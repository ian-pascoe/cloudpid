// The three MCP sign-in routes (`docs/architecture/mcp-sign-in.md` → The client document and the callback outside Access,
// Starting and completing a sign-in) over a scripted Registry: what reaches it, and what the browser gets back.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
import type {
  McpSignInCompleteAnswer,
  McpSignInCompleteInput,
  McpSignInConfirmAnswer,
  McpSignInConfirmInput,
  McpSignInStartAnswer,
  McpSignInStartInput,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it, vi } from "vitest";
import {
  serveCallback,
  serveClientDocument,
  serveStart,
  type SignInEnv,
  type SignInRegistry,
} from "./sign-in-http.ts";

const ORIGIN = "https://cloudpid-server-pr-450.ian-g-pascoe.workers.dev";
const STATE = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9";
const CALLBACK = "/oauth/mcp/callback";

const LIVE: SignInEnv = {
  CLOUDPID_APP_ORIGIN: ORIGIN,
  CLOUDPID_STAGE_LABEL: "pr-450",
  MCP_CLIENT_DOCUMENT: "true",
};

const LOCAL: SignInEnv = { CLOUDPID_LOCAL_MODE: "true" };

/** A Registry whose three methods answer as given, and that counts how often each was called. */
const registry = (answers: {
  start?: McpSignInStartAnswer;
  confirm?: McpSignInConfirmAnswer;
  complete?: McpSignInCompleteAnswer;
}) => {
  const startMcpSignIn = vi.fn((_input: McpSignInStartInput) =>
    Effect.succeed<McpSignInStartAnswer>(
      answers.start ?? { status: "problem", message: "unscripted" },
    ),
  );

  const confirmMcpSignIn = vi.fn((_input: McpSignInConfirmInput) =>
    Effect.succeed<McpSignInConfirmAnswer>(
      answers.confirm ?? { status: "problem", message: "unscripted" },
    ),
  );

  const completeMcpSignIn = vi.fn((_input: McpSignInCompleteInput) =>
    Effect.succeed<McpSignInCompleteAnswer>(answers.complete ?? { status: "expired" }),
  );

  return {
    startMcpSignIn,
    confirmMcpSignIn,
    completeMcpSignIn,
    use: (): SignInRegistry => ({ startMcpSignIn, confirmMcpSignIn, completeMcpSignIn }),
  };
};

const serve = async (
  request: Request,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
): Promise<Response> => {
  const response = await Effect.runPromise(
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    ),
  );

  return HttpServerResponse.toWeb(response);
};

describe("the client document", () => {
  const get = (env: SignInEnv, init?: RequestInit) =>
    serve(new Request(`${ORIGIN}/oauth/mcp/client.json`, init), serveClientDocument(env));

  it("is public JSON naming itself, cacheable for an hour", async () => {
    const response = await get(LIVE);
    const document = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(document).toMatchObject({
      client_id: `${ORIGIN}/oauth/mcp/client.json`,
      client_name: "cloudpid (pr-450)",
      redirect_uris: [`${ORIGIN}${CALLBACK}`],
      token_endpoint_auth_method: "none",
    });
  });

  it("is named cloudpid on a stage with no label", async () => {
    const response = await get({ CLOUDPID_APP_ORIGIN: ORIGIN });

    expect(await response.json()).toMatchObject({ client_name: "cloudpid" });
  });

  it("answers HEAD without a body", async () => {
    const response = await get(LIVE, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("is a 404 under alchemy dev, even with an origin var, and without one", async () => {
    expect((await get(LOCAL)).status).toBe(404);
    expect((await get({ ...LOCAL, CLOUDPID_APP_ORIGIN: ORIGIN })).status).toBe(404);
    expect((await get({})).status).toBe(404);
  });

  it("answers another method with 405", async () => {
    const response = await get(LIVE, { method: "POST", body: "x" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("the callback", () => {
  const get = (registryOf: SignInRegistry, query: string, method = "GET") =>
    serve(
      new Request(`${ORIGIN}${CALLBACK}${query}`, { method }),
      serveCallback(() => registryOf, CALLBACK),
    );

  it.each([
    ["no state", "?code=abc"],
    ["an empty state", "?state=&code=abc"],
    ["a short state", "?state=abc&code=abc"],
    ["a state that is too long", `?state=${STATE}x&code=abc`],
    ["a state with a character outside the alphabet", `?state=${STATE.slice(0, 42)}!&code=abc`],
    ["two states", `?state=${STATE}&state=${STATE}&code=abc`],
    ["a code that is too long", `?state=${STATE}&code=${"a".repeat(4097)}`],
    ["an iss that is too long", `?state=${STATE}&code=a&iss=${"a".repeat(2049)}`],
    ["an error that is too long", `?state=${STATE}&error=${"a".repeat(129)}`],
  ])("never calls the Registry for %s", async (_name, query) => {
    const scripted = registry({});
    const response = await get(scripted.use(), query);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("This is not a sign-in answer");
    expect(scripted.completeMcpSignIn).not.toHaveBeenCalled();
  });

  it("passes a well-formed answer on, bounded, and shows its outcome", async () => {
    const scripted = registry({
      complete: {
        status: "signed_in",
        server: "sentry",
        environments: [{ id: "env_1", name: "Work" }],
        resolved: [],
        revision: 2,
      },
    });

    const response = await get(
      scripted.use(),
      `?state=${STATE}&code=abc&iss=https%3A%2F%2Fas.example&error_description=${"d".repeat(2000)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("sha256-");
    expect(await response.text()).toContain("Signed in");

    expect(scripted.completeMcpSignIn.mock.calls[0]?.[0]).toMatchObject({
      state: STATE,
      path: CALLBACK,
      code: "abc",
      iss: "https://as.example",
      errorDescription: "d".repeat(1024),
    });
  });

  it("shows an expired state as expired", async () => {
    const response = await get(
      registry({ complete: { status: "expired" } }).use(),
      `?state=${STATE}&code=abc`,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This sign-in link has expired");
  });

  it("shows a status this build does not know as unavailable, saved nothing", async () => {
    const response = await get(
      registry({ complete: { status: "from_the_future" } }).use(),
      `?state=${STATE}&code=abc`,
    );

    expect(response.status).toBe(503);
  });

  it("shows a Registry that cannot be reached as a page saying nothing was saved", async () => {
    const down: SignInRegistry = {
      ...registry({}).use(),
      completeMcpSignIn: () => Effect.die(new Error("down")),
    };

    const response = await get(down, `?state=${STATE}&code=abc`);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Nothing was saved.");
  });

  it("answers another method with 405 and never calls the Registry", async () => {
    const scripted = registry({});
    const response = await get(scripted.use(), `?state=${STATE}&code=abc`, "POST");

    expect(response.status).toBe(405);
    expect(scripted.completeMcpSignIn).not.toHaveBeenCalled();
  });
});

describe("the start", () => {
  const link = "/oauth/mcp/start?environment=env_1&server=sentry&return=%2Fsettings";

  const start = (
    registryOf: SignInRegistry,
    env: SignInEnv,
    init: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    serve(
      new Request(init.url ?? `${ORIGIN}${link}`, {
        method: init.method ?? "GET",
        headers: { host: new URL(init.url ?? ORIGIN).host, ...init.headers },
        body: init.body ?? null,
      }),
      serveStart(() => registryOf, env),
    );

  const SAME = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };

  it("sends the owner on to the authorization page with a 303, and passes the link's values and the stage", async () => {
    const scripted = registry({
      start: { status: "redirect", url: "https://as.example/authorize?x=1" },
    });

    const response = await start(scripted.use(), LIVE, { headers: SAME });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://as.example/authorize?x=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(scripted.startMcpSignIn).toHaveBeenCalledWith({
      environment: "env_1",
      server: "sentry",
      stage: { origin: ORIGIN, label: "pr-450", local: false, documentEnabled: true },
      stepUp: false,
      requester: undefined,
      returnPath: "/settings",
    });
  });

  it("passes a step-up link's flag and the requester it names", async () => {
    const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });

    await start(scripted.use(), LIVE, {
      url: `${ORIGIN}${link}&step_up=1&session=sess_1&request=req_1`,
      headers: SAME,
    });

    expect(scripted.startMcpSignIn.mock.calls[0]?.[0]).toMatchObject({
      stepUp: true,
      requester: { session: "sess_1", request: "req_1" },
    });
  });

  it("starts under alchemy dev from either local origin, the redirect URI following Host", async () => {
    for (const origin of ["http://localhost:1337", "http://localhost:5173"]) {
      const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });

      const response = await start(scripted.use(), LOCAL, {
        url: `${origin}${link}`,
        headers: SAME,
      });

      expect(response.status).toBe(303);
      expect(scripted.startMcpSignIn.mock.calls[0]?.[0]).toMatchObject({
        stage: { origin, local: true, documentEnabled: false },
      });
    }
  });

  it("shows the issuer interstitial", async () => {
    const response = await start(
      registry({
        start: {
          status: "confirm",
          confirmation: {
            state: STATE,
            server: "sentry",
            source: "owner",
            url: "https://mcp.example/mcp",
            issuer: "https://as.example",
            clientId: "client",
          },
        },
      }).use(),
      LIVE,
      { headers: SAME },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Confirm the authorization server");
  });

  it("shows a refusal as a page with Back, 400", async () => {
    const response = await start(
      registry({ start: { status: "problem", message: "No such server" } }).use(),
      LIVE,
      { headers: SAME },
    );

    expect(response.status).toBe(400);

    const html = await response.text();

    expect(html).toContain("No such server");
    expect(html).toContain(`href="/settings"`);
  });

  it("shows a Registry that cannot be reached as a page", async () => {
    const down: SignInRegistry = {
      ...registry({}).use(),
      startMcpSignIn: () => Effect.die(new Error("down")),
    };

    const response = await start(down, LIVE, { headers: SAME });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("could not reach its store");
  });

  it.each([
    ["no Sec-Fetch-Site", {}],
    ["a cross-site fetch (the way back from an Access login)", { "sec-fetch-site": "cross-site" }],
    ["a same-site fetch", { "sec-fetch-site": "same-site" }],
    ["a typed address", { "sec-fetch-site": "none" }],
  ])(
    "starts nothing for %s: it asks first, and the Registry is never called",
    async (_name, headers) => {
      const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });
      const response = await start(scripted.use(), LIVE, { headers });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBe(null);
      expect(response.headers.get("content-security-policy")).not.toContain("form-action");
      expect(html).toContain(`<form method="post" action="/oauth/mcp/start">`);
      expect(html).toContain(`name="environment" value="env_1"`);
      expect(html).toContain(`name="server" value="sentry"`);
      expect(html).toContain(`name="return" value="/settings"`);
      expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
    },
  );

  it.each(["no-cors", "cors", "same-origin"])(
    "starts nothing for a same-origin request whose Sec-Fetch-Mode is %s (an <img> or a fetch)",
    async (mode) => {
      const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });

      const response = await start(scripted.use(), LIVE, {
        headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": mode },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<form method="post" action="/oauth/mcp/start">`);
      expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
    },
  );

  it("carries a step-up and the requester through the page it asks on", async () => {
    const response = await start(registry({}).use(), LIVE, {
      url: `${ORIGIN}${link}&step_up=1&session=sess_1&request=req_1&x=<b>`,
    });

    const html = await response.text();

    expect(html).toContain(`name="step_up" value="1"`);
    expect(html).toContain(`name="session" value="sess_1"`);
    expect(html).toContain(`name="request" value="req_1"`);
    expect(html).not.toContain("<b>");
  });

  it("is a problem page for a link that names no server, whatever its headers", async () => {
    const scripted = registry({});
    const response = await start(scripted.use(), LIVE, { url: `${ORIGIN}/oauth/mcp/start` });

    expect(response.status).toBe(400);
    expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["a live stage with no origin var", {}, ORIGIN],
    ["alchemy dev on an unknown Host", LOCAL, "http://localhost:3000"],
  ])("answers nothing for %s", async (_name, env, origin) => {
    const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });
    const response = await start(scripted.use(), env, { url: `${origin}${link}`, headers: SAME });

    expect(response.status).toBe(400);
    expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["no server", "/oauth/mcp/start?environment=env_1"],
    ["no environment", "/oauth/mcp/start?server=sentry"],
    ["a server with a control character", "/oauth/mcp/start?environment=e&server=a%0Ab"],
    ["a server that is too long", `/oauth/mcp/start?environment=e&server=${"a".repeat(201)}`],
  ])("is refused for a link with %s", async (_name, path) => {
    const scripted = registry({});
    const response = await start(scripted.use(), LIVE, { url: `${ORIGIN}${path}`, headers: SAME });

    expect(response.status).toBe(400);
    expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
  });

  it("drops a return path that leaves the app", async () => {
    const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });

    await start(scripted.use(), LIVE, {
      url: `${ORIGIN}/oauth/mcp/start?environment=e&server=s&return=%2F%2Fevil.example`,
      headers: SAME,
    });

    expect(scripted.startMcpSignIn.mock.calls[0]?.[0]).toMatchObject({ returnPath: undefined });
  });

  it("answers another method with 405", async () => {
    const response = await start(registry({}).use(), LIVE, {
      method: "PUT",
      headers: SAME,
      body: "x",
    });

    expect(response.status).toBe(405);
  });

  describe("the interstitial's POST", () => {
    const post = (
      scripted: ReturnType<typeof registry>,
      body: string,
      headers: Record<string, string> = {},
      env: SignInEnv = LIVE,
    ) =>
      start(scripted.use(), env, {
        url: `${ORIGIN}/oauth/mcp/start`,
        method: "POST",
        headers: {
          ...SAME,
          origin: ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
      });

    it("sends the owner on after Continue", async () => {
      const scripted = registry({
        confirm: { status: "redirect", url: "https://as.example/authorize" },
      });

      const response = await post(scripted, `state=${STATE}&decision=continue`);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://as.example/authorize");
      expect(scripted.confirmMcpSignIn).toHaveBeenCalledWith({
        state: STATE,
        decision: "continue",
      });
    });

    it("starts the sign-in a prompt page confirmed, with the link's values", async () => {
      const scripted = registry({
        start: { status: "redirect", url: "https://as.example/authorize" },
      });

      const response = await post(
        scripted,
        "environment=env_1&server=sentry&step_up=1&session=s1&request=r1&return=%2Fsettings",
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://as.example/authorize");
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
      expect(scripted.startMcpSignIn.mock.calls[0]?.[0]).toMatchObject({
        environment: "env_1",
        server: "sentry",
        stepUp: true,
        requester: { session: "s1", request: "r1" },
        returnPath: "/settings",
      });
    });

    it("is refused for a form that is neither a start nor an answer", async () => {
      const scripted = registry({});
      const response = await post(scripted, "decision=continue");

      expect(response.status).toBe(400);
      expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
    });

    it("says Cancel changed nothing", async () => {
      const response = await post(
        registry({ confirm: { status: "cancelled" } }),
        `state=${STATE}&decision=cancel`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Sign-in cancelled");
    });

    it("tells an expired one to start again", async () => {
      const response = await post(
        registry({ confirm: { status: "expired" } }),
        `state=${STATE}&decision=continue`,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("expired or was already used");
    });

    it.each([
      ["no Origin", { origin: "" }],
      ["another origin", { origin: "https://evil.example" }],
      // What a browser sends from a `Referrer-Policy: no-referrer` page: accepting it would take any sandboxed page's POST.
      ["a null Origin", { origin: "null" }],
    ])("is refused with %s, and the Registry is never called", async (_name, headers) => {
      const scripted = registry({});
      const response = await post(scripted, `state=${STATE}&decision=continue`, headers);

      expect(response.status).toBe(403);
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
    });

    it("refuses a forged start from another site, and never calls the Registry", async () => {
      const scripted = registry({ start: { status: "redirect", url: "https://as.example/a" } });

      const response = await post(scripted, "environment=env_1&server=sentry", {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      });

      expect(response.status).toBe(403);
      expect(scripted.startMcpSignIn).not.toHaveBeenCalled();
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
    });

    it("is refused without Sec-Fetch-Site: same-origin", async () => {
      const scripted = registry({});

      const response = await post(scripted, `state=${STATE}&decision=continue`, {
        "sec-fetch-site": "cross-site",
      });

      expect(response.status).toBe(403);
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
    });

    it.each([
      ["a state that is malformed", "state=abc&decision=continue", {}],
      ["no state", "decision=continue", {}],
      ["a body that is too long", `state=${STATE}&decision=continue&x=${"a".repeat(3000)}`, {}],
      [
        "a body that is not a form",
        `state=${STATE}&decision=continue`,
        { "content-type": "text/plain" },
      ],
    ])("is refused for %s, and the Registry is never called", async (_name, body, headers) => {
      const scripted = registry({});
      const response = await post(scripted, body, headers);

      expect(response.status).toBe(400);
      expect(scripted.confirmMcpSignIn).not.toHaveBeenCalled();
    });
  });
});
