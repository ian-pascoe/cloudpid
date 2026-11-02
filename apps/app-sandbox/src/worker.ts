// docs/architecture/mcp-apps.md → The App sandbox. The App sandbox Worker's entry: public, with no Access, no secret and
// no binding, on the route `*.ianpascoe.app/*`. It serves the spec's proxy page (`/`) and its script (`/proxy.js`) on a
// hostname that parses as a View's, and a 404 for everything else.
import { appOriginOf } from "@cloudpid/server/view-host";
import { buildCsp } from "./csp.ts";
import { sandboxHeaders } from "./headers.ts";
import { PROXY_JS, proxyPage } from "./proxy.ts";

const notFound = (): Response =>
  new Response("Not found", { status: 404, headers: sandboxHeaders("text/plain; charset=utf-8") });

/**
 * The origin that may frame the page comes from the hostname alone (`appOriginOf`): never from the URL's query, a
 * header, the `Referer` or a cookie, none of which the Worker reads but the one `?csp=` parameter.
 */
const serve = (request: Request): Response => {
  const url = new URL(request.url);
  const appOrigin = appOriginOf(url.hostname);

  if (appOrigin === undefined) return notFound();

  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = sandboxHeaders("text/plain; charset=utf-8");
    headers.set("allow", "GET, HEAD");

    return new Response("Method not allowed", { status: 405, headers });
  }

  if (url.pathname === "/proxy.js") {
    return new Response(PROXY_JS, {
      headers: sandboxHeaders("text/javascript; charset=utf-8"),
    });
  }

  if (url.pathname === "/") {
    return new Response(proxyPage(appOrigin), {
      headers: sandboxHeaders(
        "text/html; charset=utf-8",
        buildCsp(url.searchParams.get("csp"), appOrigin),
      ),
    });
  }

  return notFound();
};

export default { fetch: serve };
