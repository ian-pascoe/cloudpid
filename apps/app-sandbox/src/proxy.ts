// docs/architecture/mcp-apps.md → The App sandbox (Frames). The spec's proxy page and its script, ported from ext-apps'
// reference host (`examples/basic-host/sandbox.html` and `src/sandbox.ts`), with the host origin taken from the page
// (the sandbox's hostname) instead of `document.referrer`, which a browser or extension can strip.

/** The name of the `<meta>` the page carries the app origin in, which `/proxy.js` reads once. */
const HOST_ORIGIN_META = "cloudpid-host-origin";

/** The page escapes what it writes into an attribute, though an app origin never holds these. */
const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * The proxy page for the host at `hostOrigin`, the app origin of the hostname it is served on: the transparent
 * full-size frame, its styles inline and its one script external (`/proxy.js`, `'self'`). The CSP is a header, not a
 * `<meta>`, so a View cannot change it, and the inner frame inherits it.
 */
export const proxyPage = (hostOrigin: string): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <meta name="${HOST_ORIGIN_META}" content="${escapeAttribute(hostOrigin)}" />
    <title>App sandbox</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100vh;
        width: 100vw;
        background-color: transparent;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      * {
        box-sizing: border-box;
      }
      iframe {
        background-color: transparent;
        border: 0 none transparent;
        padding: 0;
        overflow: hidden;
        flex-grow: 1;
        color-scheme: inherit;
      }
    </style>
  </head>
  <body>
    <script src="/proxy.js"></script>
  </body>
</html>
`;

/**
 * `/proxy.js`: plain script, not a module and with no import, so it can be served as text and run as it is in a test.
 *
 * - **Where it runs:** only framed, and only where the top window cannot be read, the reference's self-test (a proxy that
 *   can read its top is not isolated from the host, and does nothing).
 * - **Messages:** from the parent only when `event.origin` is the app origin from the page, and from the inner frame only
 *   when it is the proxy's own origin; anything else, and every other source, is dropped. The parent's messages go to
 *   the inner frame as they are (to `"*"`, as the reference's: the frame is being written and has no origin to name),
 *   and the inner frame's to the parent at the app origin, never `"*"`.
 * - **`sandbox-resource-ready`:** the one message the proxy keeps for itself. It makes the inner frame then, not before:
 *   a frame's `sandbox` flags and permissions policy are fixed when its document is created, so `sandbox` (a string, else
 *   the reference's `allow-scripts allow-same-origin allow-forms`) and `allow="clipboard-write"` (only when `permissions`
 *   asks for `clipboardWrite`; cloudpid grants no other permission) are set before the frame is appended. A frame that
 *   already exists is removed first, so a second View never inherits the first's flags. It then loads `html` with
 *   `document.write`, so the frame inherits the header CSP and CesiumJS-style views work.
 * - **Ready:** `sandbox-proxy-ready` goes to the app origin once the listener is set.
 */
export const PROXY_JS = String.raw`(function () {
  "use strict";

  var meta = document.querySelector('meta[name="${HOST_ORIGIN_META}"]');
  var HOST = meta === null ? "" : meta.getAttribute("content") || "";
  var OWN = location.origin;

  if (HOST === "" || window.self === window.top) return;

  try {
    void window.top.location.href;
    return;
  } catch (error) {
    // A SecurityError is what an isolated frame gets, and what this wants.
  }

  var inner = null;

  function load(params) {
    if (inner !== null) document.body.removeChild(inner);

    inner = document.createElement("iframe");
    inner.setAttribute(
      "sandbox",
      typeof params.sandbox === "string" ? params.sandbox : "allow-scripts allow-same-origin allow-forms",
    );

    if (params.permissions && params.permissions.clipboardWrite) {
      inner.setAttribute("allow", "clipboard-write");
    }

    document.body.appendChild(inner);

    if (typeof params.html !== "string") return;

    var doc = inner.contentDocument;

    if (doc) {
      doc.open();
      doc.write(params.html);
      doc.close();
    } else {
      inner.srcdoc = params.html;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== HOST) {
        console.error("[sandbox] rejected a message from", event.origin);
        return;
      }

      var data = event.data;

      if (data !== null && data !== undefined && data.method === "ui/notifications/sandbox-resource-ready") {
        load(data.params || {});
      } else if (inner !== null && inner.contentWindow) {
        inner.contentWindow.postMessage(data, "*");
      }
    } else if (inner !== null && inner.contentWindow !== null && event.source === inner.contentWindow) {
      if (event.origin !== OWN) {
        console.error("[sandbox] rejected a message from the frame at", event.origin);
        return;
      }

      window.parent.postMessage(event.data, HOST);
    }
  });

  window.parent.postMessage(
    { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
    HOST,
  );
})();
`;
