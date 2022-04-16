/* Copyright 2020 the Deno authors. All rights reserved. MIT license. */

import { handleRegistryRequest } from "./registry.ts";
import { handleConfigRequest } from "./registry_config.ts";
import { handleApiRequest } from "./suggestions.ts";
import { handleVSCRequest } from "./vscode.ts";

import type { ConnInfo } from "https://deno.land/std@0.112.0/http/server.ts";
import { createReporter, Reporter } from "https://deno.land/x/g_a@0.1.2/mod.ts";
import { accepts } from "https://deno.land/x/oak_commons@0.1.1/negotiation.ts";
import type { Event } from "./ga4.ts";
import { formatStatus, GA4Report, isRedirect, isServerError } from "./ga4.ts";

const REMOTE_URL = "https://dotland-fresh.deno.dev";

function isHtmlRequest(req: Request) {
  return accepts(req, "application/*", "text/html") === "text/html";
}

function isNonAssetRequest(req: Request, res: Response) {
  const { pathname } = new URL(req.url);
  return pathname === "/" ||
    pathname.startsWith("/std") ||
    pathname.startsWith("/x") || isHtmlRequest(req) || res.status >= 400;
}

function isBot(req: Request) {
  const accept = req.headers.get("accept");
  const referer = req.headers.get("referer");
  const userAgent = req.headers.get("user-agent");
  return referer == null &&
    (userAgent == null || !userAgent.startsWith("Mozilla/")) &&
    (accept == null || accept === "*/*");
}

function getBotName(req: Request) {
  const userAgent = req.headers.get("user-agent");
  return userAgent?.replace(/[^\w\-].*$/, "") ?? "(unknown bot)";
}

// Makes up a document title based on the returned content type, and whether or
// not an error happened. Example of document titles it can return are "html",
// "javascript", "typescript", "wasm", and "not found".
function getDocumentTitle(req: Request, res: Response): string {
  if (!res.ok) {
    return res.statusText.toLowerCase();
  } else if (isHtmlRequest(req)) {
    return "html";
  } else {
    const contentType = res.headers.get("content-type") ?? "";
    return /^application\/(.*?)(?:;|$)/i.exec(contentType)?.[1] ?? "";
  }
}

const gaForBots = createReporter({
  id: Deno.env.get("GA_TRACKING_ID_FOR_BOTS"),
  filter(req, _res) {
    return isBot(req);
  },
  metaData(req, res) {
    return {
      campaignMedium: "Bot",
      campaignSource: getBotName(req),
      documentTitle: getDocumentTitle(req, res),
    };
  },
});

const gaForHumans = createReporter({
  id: Deno.env.get("GA_TRACKING_ID_FOR_HUMANS"),
  filter(req, res) {
    return !isBot(req) && isNonAssetRequest(req, res);
  },
  metaData(req, res) {
    return { documentTitle: getDocumentTitle(req, res) };
  },
});

const ga: Reporter = async (...args) => {
  await Promise.all([gaForBots(...args), gaForHumans(...args)]);
};

function ga4(
  request: Request,
  conn: ConnInfo,
  response: Response,
  _start: number,
  error?: unknown,
) {
  Promise.resolve().then(async () => {
    // We're tracking page views and file downloads. These are the only two
    // HTTP methods that _might_ be used.
    if (!/^(GET|POST)$/.test(request.method)) {
      return;
    }

    const bot = isBot(request);
    const botName = bot ? getBotName(request) : null;

    // If the visitor is using a web browser, only create events when we serve
    // a top level documents or download; skip assets like css, images, fonts.
    if (!bot && !isNonAssetRequest(request, response) && error == null) {
      return;
    }

    // Filter out traffic generated by uptime checks (Checkly and GCP).
    if (
      botName === "Checkly" ||
      botName === "GoogleStackdriverMonitoring-UptimeChecks"
    ) {
      return;
    }

    let event: Event | null = null;
    if (isRedirect(response)) {
      const redirectLocation = response.headers.get("location");
      event = { name: "redirect", params: { redirectLocation } };
    } else if (bot) {
      event = { name: "download", params: {} };
    } else {
      const fetchDest = request.headers.get("sec-fetch-dest");
      if (fetchDest) {
        if (/^(document|i?frame|video)$/.test(fetchDest)) {
          event = { name: "page_view", params: {} };
        } else {
          event = null; // Don't report asset downloads.
        }
      } else {
        const contentType = response.headers.get("content-type");
        if (contentType != null && /text\/html/.test(contentType)) {
          event = { name: "page_view", params: {} }; // Probably an old browser.
        } else {
          event = { name: "download", params: {} };
        }
      }
    }

    if (event == null && error == null) {
      return;
    }

    if (event != null) {
      // And add some extra HTTP metadata to the event.
      event.params.httpRequestMethod = request.method;
      event.params.httpResponseStatus = formatStatus(response);

      // Add client type classification to the event.
      if (botName === "Deno") {
        event.params.clientType = "deno";
      } else if (bot) {
        event.params.clientType = "other";
      } else {
        event.params.clientType = "browser";
      }
    }

    // If an exception was thrown, build a separate event to report it.
    let exceptionEvent;
    if (error != null) {
      exceptionEvent = {
        name: "exception",
        params: {
          description: String(error),
          fatal: isServerError(response),
        },
      };
    } else {
      exceptionEvent = undefined;
    }

    // Create basic report.
    const report = new GA4Report({ request, response, conn });

    // Override the default (page_view) event.
    report.event = event;

    // Add the exception event, if any.
    if (exceptionEvent != null) {
      report.events.push(exceptionEvent);
    }

    await report.send();
  }).catch((err) => {
    console.error(`Internal error: ${err}`);
  });
}

export function withLog(
  handler: (
    request: Request,
    connInfo: ConnInfo,
  ) => Response | Promise<Response>,
): (request: Request, connInfo: ConnInfo) => Promise<Response> {
  return async (req, con) => {
    let err: unknown;
    let res!: Response;
    const start = performance.now();
    try {
      res = await handler(req, con);
    } catch (e) {
      err = e;
      console.error(err);
      res = new Response(
        "500 Internal Server Error\nPlease try again later.",
        { status: 500 },
      );
    } finally {
      ga(req, con, res, start, err);
      ga4(req, con, res, start, err);
    }
    return res;
  };
}

export function handleRequest(request: Request): Promise<Response> {
  // this checks to see if the requestor prefers "application" code over "html"
  // which would be run-time clients who either omit an accept header (which
  // implies any content type) or provides a `*/*` header
  const isHtml = accepts(request, "application/*", "text/html") === "text/html";

  const url = new URL(request.url);

  if (url.pathname === "/v1") {
    return Promise.resolve(
      Response.redirect("https://deno.land/posts/v1", 301),
    );
  }

  if (url.pathname === "/posts") {
    return Promise.resolve(Response.redirect("https://deno.com/blog", 307));
  }

  if (url.pathname.startsWith("/posts/")) {
    return Promise.resolve(Response.redirect(
      `https://deno.com/blog/${url.pathname.substring("/posts/".length)}`,
      307,
    ));
  }

  if (url.pathname.startsWith("/typedoc")) {
    return Promise.resolve(
      Response.redirect("https://doc.deno.land/deno/stable", 301),
    );
  }

  if (url.pathname.startsWith("/_vsc")) {
    return handleVSCRequest(url);
  }

  if (url.pathname.startsWith("/_api/")) {
    return handleApiRequest(url);
  }

  if (["/install.sh", "/install.ps1"].includes(url.pathname)) {
    return Promise.resolve(
      Response.redirect(`https://deno.land/x/install${url.pathname}`, 307),
    );
  }

  if (url.pathname === "/.well-known/deno-import-intellisense.json") {
    return handleConfigRequest(request);
  }

  const isRegistryRequest = url.pathname.startsWith("/std") ||
    url.pathname.startsWith("/x/");

  if (isRegistryRequest) {
    if (isHtml) {
      const ln = extractAltLineNumberReference(url.toString());
      if (ln) {
        return Promise.resolve(
          Response.redirect(`${ln.rest}#L${ln.line}`, 302),
        );
      }
    } else {
      return handleRegistryRequest(url);
    }
  }

  if (!["HEAD", "GET"].includes(request.method)) {
    return Promise.resolve(new Response(null, { status: 405 })); // Method not allowed.
  }

  return proxyFile(url, REMOTE_URL);
}

const ALT_LINENUMBER_MATCHER = /(.*):(\d+):\d+$/;

export function extractAltLineNumberReference(
  url: string,
): { rest: string; line: number } | null {
  const matches = ALT_LINENUMBER_MATCHER.exec(url);
  if (matches === null) return null;
  return {
    rest: matches[1],
    line: parseInt(matches[2]),
  };
}

async function proxyFile(url: URL, remoteUrl: string): Promise<Response> {
  const proxyUrl = new URL(remoteUrl + url.pathname + url.search).href;

  const proxyRequest = new Request(proxyUrl);
  const proxyResponse = await fetchWithRetry(proxyRequest);

  return proxyResponse;
}

async function fetchWithRetry(request: Request): Promise<Response> {
  let promise: Promise<Response>;
  for (let i = 0; i < 3; i++) {
    promise = fetch(request);
    try {
      return await promise;
    } catch (err) {
      // TODO(lucacasonato): only retry on known retryable errors
      console.warn("retrying on proxy error", err);
    }
  }
  return promise!;
}
