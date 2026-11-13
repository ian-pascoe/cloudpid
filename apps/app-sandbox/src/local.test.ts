// @effect-diagnostics preferEffectRecord:off asyncFunction:off -- assertions over native records; vitest's Promise-based tests.
// docs/architecture/mcp-apps.md → The App sandbox (Who deploys it). The local mode `alchemy dev` serves the Worker in: one
// shared origin, framed only by the main Worker's two local origins, named by the page and checked against a fixed set.
import { LOCAL_APP_ORIGINS, SANDBOX_LOCAL_VAR } from "@cloudpid/server/view-host";
import { describe, expect, it } from "vite-plus/test";
import { buildCsp } from "./csp.ts";
import { FIXED_HEADERS } from "./headers.ts";
import { PROXY_JS, proxyPage } from "./proxy.ts";
import worker from "./worker.ts";

const LOCAL = { [SANDBOX_LOCAL_VAR]: "true" };
const HASH = "5zdfpsreiskluv5bvtlks2urnj";

const get = (url: string, env: Record<string, string> = LOCAL) =>
  worker.fetch(new Request(url), env);

describe("the App sandbox in local mode", () => {
  it.each(LOCAL_APP_ORIGINS)("serves the proxy page to %s, framed by it alone", async (origin) => {
    const response = get(`http://127.0.0.1:1338/?host=${encodeURIComponent(origin)}`);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(csp.match(/frame-ancestors [^;]*/)?.[0]).toBe(`frame-ancestors ${origin}`);
    expect(csp).toBe(buildCsp(null, origin));
    expect(await response.text()).toBe(proxyPage(origin));

    for (const [name, value] of Object.entries(FIXED_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
  it.each([
    "",
    "?host=https://evil.example",
    "?host=http://localhost:9999",
    "?host=http://localhost:1337/",
    "?host=http://localhost:1337%20http://evil.example",
    "?host=*",
  ])("answers 404 for a page whose host is not one of the local origins: %j", (query) => {
    const response = get(`http://127.0.0.1:1338/${query}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("serves /proxy.js with no ?host=, the same script for every origin", async () => {
    const response = get("http://127.0.0.1:1338/proxy.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PROXY_JS);
  });
  it("is not a mode a request can ask for: without the var, ?host= and a localhost host are a 404", () => {
    for (const env of [{}, { [SANDBOX_LOCAL_VAR]: "false" }, { [SANDBOX_LOCAL_VAR]: "1" }]) {
      const response = get(
        `http://127.0.0.1:1338/?host=${encodeURIComponent(LOCAL_APP_ORIGINS[0] ?? "")}`,
        env,
      );

      expect(response.status).toBe(404);
    }

    expect(get("http://127.0.0.1:1338/proxy.js", {}).status).toBe(404);
  });

  it("still takes a deployed host's origin from the hostname when the var is not set", () => {
    const response = get(`https://${HASH}.ianpascoe.app/?host=http://localhost:1337`, {});

    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://pi.ianpascoe.dev",
    );
  });
});
