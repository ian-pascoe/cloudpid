// Throwaway probe for #399 (Verify the App sandbox on a deployed stage). Not part of cloudpid; never merged.
//
// The App sandbox Worker of ADR-0031 reduced to what the ticket checks: one Worker on the route `*.ianpascoe.app/*`
// serving only the spec's proxy page at `<hash>.ianpascoe.app` (prod) and `<hash>--<stage>.ianpascoe.app`, with
// - the CSP as a response header built from `?csp=` (the server's `ui.csp`, JSON), never looser than the spec's default;
// - `frame-ancestors` = the one app origin that hostname's stage maps to (`STAGES`), and postMessage checked against it;
// - no cookie read or set: the Worker only reports whether a `Cookie` header arrived, never its value.

interface Env {
  /** JSON `{ "<stage label or empty for prod>": "<app origin>" }`. */
  readonly STAGES: string;
  readonly SANDBOX_ZONE: string;
}

interface UiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

const HOST_PATTERN = /^([a-z2-7]{26})(?:--([a-z0-9-]{1,35}))?$/;

const origin = (value: string) => new URL(value).origin;

/** Only `https:` origins outside the sandbox zone and cloudpid's own hosts (ADR-0031: never looser, never cloudpid). */
const domains = (list: unknown, zone: string): string[] =>
  Array.isArray(list)
    ? list.flatMap((entry) => {
        if (typeof entry !== "string") return [];

        try {
          const url = new URL(entry);
          const host = url.hostname;

          const own =
            host === zone ||
            host.endsWith(`.${zone}`) ||
            host === "ianpascoe.dev" ||
            host.endsWith(".ianpascoe.dev");

          return url.protocol === "https:" && !own ? [url.origin] : [];
        } catch {
          return [];
        }
      })
    : [];

const buildCsp = (raw: string | null, zone: string, ancestor: string) => {
  let csp: UiCsp = {};

  try {
    csp = raw ? (JSON.parse(raw) as UiCsp) : {};
  } catch {
    csp = {};
  }

  const resources = domains(csp.resourceDomains, zone);
  const connect = domains(csp.connectDomains, zone);
  const frames = domains(csp.frameDomains, zone);
  const bases = domains(csp.baseUriDomains, zone);
  const list = (items: string[], fallback: string) => (items.length ? items.join(" ") : fallback);

  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `style-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `img-src 'self' data: ${resources.join(" ")}`.trim(),
    `font-src 'self' ${resources.join(" ")}`.trim(),
    `media-src 'self' data: ${resources.join(" ")}`.trim(),
    `connect-src ${list(connect, "'none'")}`,
    `frame-src ${list(frames, "'none'")}`,
    `base-uri ${list(bases, "'self'")}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestor}`,
  ].join("; ");
};

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// The proxy, ported from ext-apps' examples/basic-host/src/sandbox.ts, with the host origin taken from the hostname's
// stage (server-rendered) instead of `document.referrer`, plus `_probe` diagnostics on `sandbox-proxy-ready`.
const PROXY_JS = String.raw`
const config = JSON.parse(document.getElementById("config").textContent);
const HOST = config.hostOrigin;
const OWN = location.origin;
let topReadable = true;
try { void window.top.location.href; } catch { topReadable = false; }
const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
inner.style.cssText = "width:100%;height:100%;border:0";
document.body.appendChild(inner);
window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    if (event.origin !== HOST) { console.error("[sandbox] rejected parent origin", event.origin); return; }
    const data = event.data;
    if (data && data.method === "ui/notifications/sandbox-resource-ready") {
      const { html, sandbox } = data.params || {};
      if (typeof sandbox === "string") inner.setAttribute("sandbox", sandbox);
      const doc = inner.contentDocument;
      if (doc) { doc.open(); doc.write(html); doc.close(); } else { inner.srcdoc = html; }
    } else if (inner.contentWindow) {
      inner.contentWindow.postMessage(data, "*");
    }
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN) { console.error("[sandbox] rejected inner origin", event.origin); return; }
    window.parent.postMessage(event.data, HOST);
  }
});
window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {
  _probe: { origin: OWN, hostOrigin: HOST, cookieHeader: config.cookieHeader, documentCookie: document.cookie,
            referrer: document.referrer, topReadable, csp: config.csp } } }, HOST);
`;

const proxyPage = (config: object) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>App sandbox</title>
<style>html,body{margin:0;height:100vh;width:100vw;background:transparent}body{display:flex}iframe{flex-grow:1}</style>
</head><body><script type="application/json" id="config">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>
<script src="/proxy.js"></script></body></html>`;

export default {
  fetch(request: Request, env: Env): Response {
    const url = new URL(request.url);
    const zone = env.SANDBOX_ZONE;
    const label = url.hostname.endsWith(`.${zone}`) ? url.hostname.slice(0, -zone.length - 1) : "";
    const match = HOST_PATTERN.exec(label);
    const stages = JSON.parse(env.STAGES) as Record<string, string>;
    const target = match ? stages[match[2] ?? ""] : undefined;

    // Unknown hosts, unknown stages and the apex (not routed here) serve nothing.
    if (!match || !target || request.method !== "GET") {
      return new Response("Not found", {
        status: 404,
        headers: { ...COMMON_HEADERS, "content-type": "text/plain" },
      });
    }

    const ancestor = origin(target);
    const csp = buildCsp(url.searchParams.get("csp"), zone, ancestor);

    if (url.pathname === "/proxy.js") {
      return new Response(PROXY_JS, {
        headers: { ...COMMON_HEADERS, "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname !== "/") {
      return new Response("Not found", {
        status: 404,
        headers: { ...COMMON_HEADERS, "content-type": "text/plain" },
      });
    }

    // Names only, never values: is any cookie reaching the sandbox?
    const cookie = request.headers.get("cookie");

    const cookieHeader = cookie
      ? cookie
          .split(";")
          .map((part) => part.split("=")[0]?.trim())
          .join(",")
      : null;

    return new Response(proxyPage({ hostOrigin: ancestor, cookieHeader, csp }), {
      headers: {
        ...COMMON_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
      },
    });
  },
};
