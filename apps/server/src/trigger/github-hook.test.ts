// A Trigger's GitHub-managed hook at GitHub (`github-hook.ts`), over a fake GitHub (`github.fixture.ts`) and a real
// `GitHubApp` with a key made for the test: the token each call asks for, what a hook is made with, how each of GitHub's
// refusals reads, the span of each call, and which hooks the orphan sweep picks.
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off preferEffectArray:off -- node:crypto makes the test key.
import { generateKeyPairSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { fakeGitHub, type FakeGitHubState, fakeGitHubState } from "./github.fixture.ts";
import { orphanHooks, type RepoHooks, triggerGitHub } from "./github-hook.ts";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const config = {
  url: "https://pi.example/hooks/t1/token",
  secret: "s3cret",
  events: ["workflow_run"],
};

const made = (state: FakeGitHubState = fakeGitHubState()) => ({
  state,
  hooks: triggerGitHub({
    appId: "123456",
    privateKey: KEY,
    fetch: fakeGitHub(state),
    now: () => Date.UTC(2026, 10, 9),
  }).hooks,
});

/** `run`'s failure, or a test failure when it succeeds. */
const failure = <A, E>(run: Effect.Effect<A, E>) => Effect.runPromise(run.pipe(Effect.flip));

describe("a GitHub-managed hook at GitHub", () => {
  it("is made on the repo with a token for the installation on its owner that asks for Webhooks: write alone", async () => {
    const { state, hooks } = made();

    expect(await Effect.runPromise(hooks.create("o/r", config))).toBe(1);

    const mints = state.seen.filter(({ path }) => path.endsWith("/access_tokens"));

    expect(mints.map(({ path }) => path)).toEqual(["/app/installations/11/access_tokens"]);
    expect(JSON.parse(mints[0]?.body ?? "null")).toEqual({
      permissions: { repository_hooks: "write" },
    });
    expect(state.seen.at(-1)).toMatchObject({
      method: "POST",
      path: "/repos/o/r/hooks",
      token: "ghs_o_1",
    });
    expect(state.hooks.get("o/r")).toEqual([{ id: 1, contentType: "json", ...config }]);
  });

  it("is updated in place, and told gone, or deleted, when GitHub no longer has it", async () => {
    const { state, hooks } = made();

    await Effect.runPromise(hooks.create("o/r", config));

    expect(await Effect.runPromise(hooks.update("o/r", 1, { ...config, secret: "new" }))).toBe(
      "updated",
    );
    expect(state.hooks.get("o/r")?.[0]?.secret).toBe("new");

    await Effect.runPromise(hooks.delete("o/r", 1));

    expect(state.hooks.get("o/r")).toEqual([]);
    expect(await Effect.runPromise(hooks.update("o/r", 1, config))).toBe("gone");
    await Effect.runPromise(hooks.delete("o/r", 1));
  });

  it.each<[string, (state: FakeGitHubState) => void, string, string, number | undefined]>([
    [
      "an installation that hasn't accepted Webhooks: write, at the mint",
      (state) => state.accepted.clear(),
      "o/r",
      "permission",
      422,
    ],
    ["an account the App is not installed on", () => {}, "elsewhere/r", "not_installed", undefined],
    ["GitHub out of service", (state) => (state.down = true), "o/r", "unreachable", 503],
    [
      "GitHub's own limit of hooks per event",
      (state) => {
        state.limit = 1;
        state.hooks.set("o/r", [
          {
            id: 9,
            url: "https://x.example",
            secret: "",
            events: ["workflow_run"],
            contentType: "json",
          },
        ]);
      },
      "o/r",
      "refused",
      422,
    ],
  ])("is refused with its code for %s", async (_case, arrange, repo, code, status) => {
    const state = fakeGitHubState();

    arrange(state);

    expect(await failure(made(state).hooks.create(repo, config))).toMatchObject(
      status === undefined ? { code } : { code, status },
    );
  });

  it("shows GitHub's own words when it refuses a hook, so its 20-hook limit reads as GitHub's", async () => {
    const state = fakeGitHubState();

    state.limit = 0;

    // The words are GitHub's: the owner reads its refusal, not one of cloudpid's.
    expect((await failure(made(state).hooks.create("o/r", config))).message).toContain(
      'The "workflow_run" event cannot have more than 0 hooks',
    );
  });

  it("is refused as a missing permission for a token GitHub says no integration may use", async () => {
    const hooks = triggerGitHub({
      appId: "123456",
      privateKey: KEY,
      now: () => Date.UTC(2026, 10, 9),
      fetch: async (url, init) => {
        const answer = await fakeGitHub(fakeGitHubState())(url, init);

        return url.includes("/repos/")
          ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
          : answer;
      },
    }).hooks;

    expect(await failure(hooks.list("o/r"))).toMatchObject({ code: "permission", status: 403 });
  });

  it("records each call as a trigger.github_hook span with its op, outcome and HTTP status", async () => {
    const spans: Array<Tracer.NativeSpan> = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    const state = fakeGitHubState();
    const { hooks }: { readonly hooks: RepoHooks } = made(state);

    const traced = <A, E>(run: Effect.Effect<A, E>) =>
      Effect.runPromiseExit(run.pipe(Effect.provideService(Tracer.Tracer, tracer)));

    await traced(hooks.create("o/r", config));
    state.down = true;
    await traced(hooks.delete("o/r", 1));

    expect(
      spans.map(({ name, attributes }) => [
        name,
        attributes.get("trigger.github_hook.op"),
        attributes.get("trigger.outcome"),
        attributes.get("http.status"),
      ]),
    ).toEqual([
      ["trigger.github_hook", "create", "ok", 201],
      ["trigger.github_hook", "delete", "unreachable", 503],
    ]);
  });
});

describe("orphanHooks", () => {
  const origin = "https://pi.example";

  const hook = (id: number, url: string | undefined) => ({ id, url });

  it("picks this stage's hooks of a Trigger the Registry doesn't know, or of the Trigger itself, and nothing else", () => {
    const hooks = [
      hook(1, `${origin}/hooks/known/tok`),
      hook(2, `${origin}/hooks/gone/tok`),
      hook(3, `${origin}/hooks/own/old-token`),
      hook(4, "https://pr-7.pi.example/hooks/gone/tok"),
      hook(5, "https://ci.example/hook"),
      hook(6, `${origin}/hooks/gone/tok/more`),
      hook(7, undefined),
    ];

    expect(orphanHooks(hooks, { origin, own: "own", known: new Set(["known", "own"]) })).toEqual([
      hook(2, `${origin}/hooks/gone/tok`),
      hook(3, `${origin}/hooks/own/old-token`),
    ]);
  });
});
