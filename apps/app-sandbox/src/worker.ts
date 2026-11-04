// docs/architecture/mcp-apps.md → The App sandbox. The App sandbox Worker's entry: public, with no Access, no secret and
// no binding, on the route `*.ianpascoe.app/*`. It serves the spec's proxy page (`/`) and its script (`/proxy.js`) on a
// hostname that parses as a View's, and a 404 for everything else.
import { SANDBOX_LOCAL_VAR, appOriginOf, localAppOriginOf } from "@cloudpid/server/view-host";
import { buildCsp } from "./csp.ts";
import { sandboxHeaders } from "./headers.ts";
import { PROXY_JS, proxyPage } from "./proxy.ts";

/** A `text/plain` answer with the fixed headers, for an error. */
const plain = (
  status: number,
  body: string,
  headers = sandboxHeaders("text/plain; charset=utf-8"),
) => new Response(body, { status, headers });

const notFound = (): Response => plain(404, "Not found");

/** The Worker's one var: `"true"` under `alchemy dev`, where the stack serves it on a local port (`resource.ts`). */
export type SandboxEnv = { readonly [SANDBOX_LOCAL_VAR]?: string };

/**
 * The origin that may frame the page comes from the hostname alone (`appOriginOf`): never from the URL's query, a
 * header, the `Referer` or a cookie, none of which the Worker reads but the one `?csp=` parameter. The exception is the
 * local mode of `alchemy dev` (the var is set by the stack there and by nothing else), where one shared origin
 * serves every View and has no hostname to read it from: the page says which of the two local app origins it is
 * (`?host=`), and any other value is a 404, so a local sandbox frames only the main Worker's origins.
 */
const serve = (request: Request, env: SandboxEnv = {}): Response => {
  const url = new URL(request.url);

  const local = env[SANDBOX_LOCAL_VAR] === "true";
  // The script is the same for every host, and its request carries no `?host=`: the local mode serves it as it is.
  const scriptOnly = local && url.pathname === "/proxy.js";

  const appOrigin = local
    ? localAppOriginOf(url.searchParams.get("host"))
    : appOriginOf(url.hostname);

  if (appOrigin === undefined && !scriptOnly) return notFound();

  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = sandboxHeaders("text/plain; charset=utf-8");
    headers.set("allow", "GET, HEAD");

    return plain(405, "Method not allowed", headers);
  }

  if (url.pathname === "/proxy.js") {
    return new Response(PROXY_JS, {
      headers: sandboxHeaders("text/javascript; charset=utf-8"),
    });
  }

  if (url.pathname === "/" && appOrigin !== undefined) {
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
