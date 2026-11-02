// Throwaway probe for #399 (Verify the App sandbox on a deployed stage). Not part of cloudpid; never merged.
//
// Stands in for a stage's app page: a Worker behind Access (the same owner-email policy as `deployment(stage)`), on
// `workers.dev` (role `stage`, like `dev_$USER` and previews) or a custom domain on `ianpascoe.dev` (role `prod`). Its
// page frames the App sandbox as an App View would be framed (double iframe: the proxy on `*.ianpascoe.app`, the View
// written into the proxy's inner iframe), runs the postMessage handshake both ways, probes the header CSP from inside
// the View, checks that other stages' sandbox origins refuse to be framed here, and POSTs its results to `/report`,
// which logs them (Workers Logs) so a run on any device can be read back.

import { ICON_192, ICON_512 } from "./icons.ts";

interface Env {
  readonly ROLE: "stage" | "prod";
  /** JSON list of `{ name, url, expect: "load" | "blocked" }`. */
  readonly FRAMES: string;
}

// The stub App View: plain inline script (`script-src 'unsafe-inline'`), the spec's handshake, and CSP probes whose
// outcome it reports in a `notifications/message` after the host's `tool-result`.
const VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Probe View</title>
<style>body{font:14px system-ui;margin:8px;color:#222;background:#eef}</style></head>
<body><div id="s">View loaded</div><script>
var results = { inlineScript: true, violations: [] };
document.addEventListener("securitypolicyviolation", function (e) {
  results.violations.push(e.effectiveDirective + " " + e.blockedURI);
  if (e.blockedURI.indexOf("www.cloudflare.com") >= 0) {
    results.declaredViolation = { blockedURI: e.blockedURI, disposition: e.disposition, statusCode: e.statusCode,
                                  originalPolicy: e.originalPolicy, sample: e.sample };
  }
});
results.origin = location.origin;
results.documentCookie = document.cookie;
try { void window.top.location.href; results.topReadable = true; } catch (e) { results.topReadable = false; }
try { eval("1"); results.eval = "allowed"; } catch (e) { results.eval = "blocked"; }
function attempt(name, promise) {
  results[name] = "pending";
  var timeout = new Promise(function (r) { setTimeout(function () { r("timeout"); }, 3000); });
  return Promise.race([promise.then(function () { return "settled"; }, function () { return "failed"; }), timeout])
    .then(function (outcome) { results[name] = outcome; });
}
function img(src) {
  return new Promise(function (ok, fail) { var i = new Image(); i.onload = ok; i.onerror = fail; i.src = src; });
}
var probes = Promise.all([
  attempt("connectDeclared", fetch("https://www.cloudflare.com/cdn-cgi/trace", { mode: "no-cors" })),
  attempt("connectUndeclared", fetch("https://example.com/", { mode: "no-cors" })),
  attempt("connectCloudpidDeclaredButStripped", fetch("https://pi.ianpascoe.dev/", { mode: "no-cors" })),
  attempt("imgDeclared", img("https://www.cloudflare.com/favicon.ico")),
  attempt("imgUndeclared", img("https://example.org/favicon.ico")),
]);
var f = document.createElement("iframe"); f.src = "https://example.com/"; document.body.appendChild(f);
var nextId = 1, pending = {};
function send(msg) { window.parent.postMessage(msg, "*"); }
function request(method, params) {
  var id = nextId++;
  send({ jsonrpc: "2.0", id: id, method: method, params: params });
  return new Promise(function (resolve) { pending[id] = resolve; });
}
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) return;
  var m = event.data;
  if (m && m.id !== undefined && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return; }
  if (m && m.method === "ui/notifications/tool-result") {
    probes.then(function () { return new Promise(function (r) { setTimeout(r, 300); }); }).then(function () {
      document.getElementById("s").textContent = "View: tool-result received, reporting";
      send({ jsonrpc: "2.0", method: "notifications/message",
             params: { level: "info", data: { echo: m.params.content[0].text, results: results } } });
    });
  }
});
request("ui/initialize", { appInfo: { name: "probe-view", version: "0" }, appCapabilities: {},
                           protocolVersion: "2026-01-26" }).then(function (result) {
  results.initializeResult = result && result.hostInfo && result.hostInfo.name;
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
});
</script></body></html>`;

const CLIENT_JS = String.raw`
const config = JSON.parse(document.getElementById("config").textContent);
const VIEW_HTML = config.viewHtml;
const out = document.getElementById("out");
const rows = [];
function row(name, ok, detail) {
  rows.push({ name, ok, detail });
  const tr = document.createElement("tr");
  tr.innerHTML = "<td></td><td></td><td></td>";
  tr.children[0].textContent = ok ? "PASS" : "FAIL";
  tr.children[0].style.color = ok ? "green" : "red";
  tr.children[1].textContent = name;
  tr.children[2].textContent = typeof detail === "string" ? detail : JSON.stringify(detail);
  out.appendChild(tr);
}
function runFrame(spec) {
  return new Promise((resolve) => {
    const expectedOrigin = new URL(spec.url).origin;
    const wrap = document.createElement("div");
    wrap.innerHTML = "<h3></h3>";
    wrap.firstChild.textContent = spec.name + " (" + expectedOrigin + ", expect " + spec.expect + ")";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    iframe.title = "App: probe (" + spec.name + ")";
    iframe.src = spec.url;
    wrap.appendChild(iframe);
    document.getElementById("frames").appendChild(wrap);
    const nonce = "ping-" + Math.random().toString(36).slice(2);
    const steps = {};
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      if (spec.expect === "blocked") {
        row(spec.name + ": framing refused", !steps.proxyReady, steps.proxyReady ? "proxy loaded, frame-ancestors did not block" : "no proxy-ready in 8 s");
      } else {
        const p = steps.probe || {};
        const r = steps.viewResults || {};
        row(spec.name + ": proxy ready from its origin", !!steps.proxyReady, p.origin || "none");
        row(spec.name + ": no cookie reached the sandbox", steps.proxyReady && p.cookieHeader === null && p.documentCookie === "", { cookieHeader: p.cookieHeader, documentCookie: p.documentCookie });
        row(spec.name + ": sandbox cannot read top", steps.proxyReady && p.topReadable === false, { topReadable: p.topReadable, referrer: p.referrer });
        row(spec.name + ": View -> host ui/initialize", !!steps.initialize, steps.initialize || "none");
        row(spec.name + ": host -> View response, View -> host initialized", !!steps.initialized, "");
        row(spec.name + ": host -> View tool-result, View -> host echo", steps.echo === nonce, steps.echo || "none");
        row(spec.name + ": View on sandbox origin, top unreadable", r.origin === expectedOrigin && r.topReadable === false, { origin: r.origin, topReadable: r.topReadable });
        // Judged by violation events, not load outcomes: a declared host may still fail to load for its own reasons.
        const v = r.violations || [];
        const hit = (directive, url) => v.some((x) => x.startsWith(directive) && x.includes(url));
        const expected = { "script-src eval": hit("script-src", "eval") || r.eval === "blocked", "connect-src example.com": hit("connect-src", "example.com"), "connect-src pi.ianpascoe.dev (declared, stripped)": hit("connect-src", "pi.ianpascoe.dev"), "img-src example.org": hit("img-src", "example.org") };
        // Firefox blocks the frame (console: "blocked the loading of a resource (frame-src)") but fires no event for it.
        expected["frame-src example.com (informational)"] = hit("frame-src", "example.com");
        const declaredClean = !v.some((x) => x.includes("www.cloudflare.com"));
        const cspOk = r.inlineScript === true && r.eval === "blocked" && declaredClean && Object.entries(expected).every(([k, ok]) => ok || k.endsWith("(informational)"));
        row(spec.name + ": header CSP enforced in the View", cspOk, { expectedViolations: expected, declaredDomainsNotBlocked: declaredClean, outcomes: { connectDeclared: r.connectDeclared, imgDeclared: r.imgDeclared, connectUndeclared: r.connectUndeclared, imgUndeclared: r.imgUndeclared }, violations: v, declaredViolation: r.declaredViolation });
      }
      resolve({ spec, steps });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== expectedOrigin) { steps.wrongOrigin = event.origin; return; }
      const m = event.data || {};
      if (m.method === "ui/notifications/sandbox-proxy-ready") {
        steps.proxyReady = Date.now();
        steps.probe = m.params && m.params._probe;
        if (spec.expect === "blocked") return finish();
        iframe.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: VIEW_HTML } }, expectedOrigin);
      } else if (m.method === "ui/initialize") {
        steps.initialize = m.params && m.params.appInfo && m.params.appInfo.name;
        iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "probe-host", version: "0" }, hostCapabilities: {}, hostContext: {} } }, expectedOrigin);
      } else if (m.method === "ui/notifications/initialized") {
        steps.initialized = Date.now();
        iframe.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: nonce }] } }, expectedOrigin);
      } else if (m.method === "notifications/message") {
        steps.echo = m.params.data.echo;
        steps.viewResults = m.params.data.results;
        finish();
      }
    };
    window.addEventListener("message", onMessage);
    setTimeout(finish, 8000);
  });
}
(async () => {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  document.getElementById("env").textContent = "role " + config.role + " · " + location.origin + " · standalone " + standalone + " · " + navigator.userAgent;
  const runs = [];
  for (const spec of config.frames) runs.push(await runFrame(spec));
  const allOk = rows.every((r) => r.ok);
  const summary = document.getElementById("summary");
  summary.textContent = allOk ? "ALL PASS (" + rows.length + " checks)" : "FAILURES: " + rows.filter((r) => !r.ok).length + " of " + rows.length;
  summary.style.color = allOk ? "green" : "red";
  const label = new URLSearchParams(location.search).get("label") || "";
  const res = await fetch("/report", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, role: config.role, origin: location.origin, standalone, ua: navigator.userAgent, allOk, rows }) });
  document.getElementById("reported").textContent = res.ok ? "Reported to the probe Worker's logs." : "Report failed: " + res.status;
})();
`;

const page = (env: Env) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sandbox probe (${env.ROLE})</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#5b3fd9">
<style>body{font:14px system-ui;margin:12px}iframe{width:100%;height:120px;border:1px solid #999}
td{padding:2px 6px;vertical-align:top;border-bottom:1px solid #ddd;word-break:break-word}#summary{font-size:22px;font-weight:bold}</style>
</head><body><h1>App sandbox probe · #399</h1>
<div id="summary">Running…</div><div id="reported"></div><p id="env"></p>
<table><tbody id="out"></tbody></table><div id="frames"></div>
<script type="application/json" id="config">${JSON.stringify({ role: env.ROLE, frames: JSON.parse(env.FRAMES), viewHtml: VIEW_HTML }).replaceAll("<", "\\u003c")}</script>
<script src="/client.js"></script></body></html>`;

const png = (b64: string) =>
  new Response(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    {
      headers: { "content-type": "image/png", "cache-control": "max-age=3600" },
    },
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return new Response(page(env), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      case "/client.js":
        return new Response(CLIENT_JS, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      case "/manifest.webmanifest":
        return Response.json({
          name: `Sandbox probe (${env.ROLE})`,
          short_name: `Probe ${env.ROLE}`,
          start_url: "/?label=pwa",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#5b3fd9",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
        });
      case "/icon-192.png":
        return png(ICON_192);
      case "/icon-512.png":
        return png(ICON_512);
      case "/report":
        if (request.method !== "POST") break;
        console.log("probe-report", JSON.stringify(await request.json()));

        return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
};
