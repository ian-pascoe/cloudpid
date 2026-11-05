// @effect-diagnostics preferEffectArray:off asyncFunction:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as pi's extension API gives them.
/**
 * What each `/cloudpid` subcommand does (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Command): the
 * usage and the configured endpoint, `login`, `logout` (one endpoint's sign-in only), and `import`'s routing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommand, USAGE } from "./command.ts";
import { type Config, SETUP_STEPS } from "./config.ts";
import { Refusal } from "./errors.ts";
import type { Host } from "./flow.ts";
import { gitIn } from "./git.ts";
import { oauthServer } from "./oauth.fixture.ts";
import { runCommand, type RunDeps } from "./run.ts";
import { signIn } from "./signin.ts";
import {
  ENDPOINT_URL,
  scriptedUi,
  type ScriptedUi,
  stubEndpoint,
  tempAuthStore,
} from "./stub.fixture.ts";

const config: Config = { url: new URL(ENDPOINT_URL) };

let auth: ReturnType<typeof tempAuthStore>;

/** What reached the network or the disk beyond the store. */
let calls: Array<string>;

beforeEach(() => {
  auth = tempAuthStore();
  calls = [];
});

afterEach(() => {
  auth.cleanup();
});

const host = (ui: ScriptedUi, hasUI = true): Host => ({
  cwd: "/nowhere",
  hasUI,
  isIdle: () => true,
  session: () => {
    throw new Error("the session is not read");
  },
  model: undefined,
  thinking: undefined,
  ui,
  appendEntry: () => undefined,
});

const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
  config: () => config,
  git: gitIn,
  store: auth.store,
  endpoint: () => {
    calls.push("endpoint");

    return Promise.reject(new Error("no endpoint"));
  },
  signIn: () => {
    calls.push("signIn");

    return Promise.resolve("signed-in");
  },
  exists: () => false,
  ...extra,
});

const run = async (line: string, ui: ScriptedUi, extra: Partial<RunDeps> = {}, hasUI = true) => {
  await runCommand(parseCommand(line), host(ui, hasUI), deps(extra));
};

describe("a bare command or an unknown subcommand", () => {
  it("prints the usage and the configured endpoint, and does nothing else", async () => {
    const ui = scriptedUi({});

    await run("", ui);

    expect(ui.notices).toEqual([{ message: `${USAGE}\nEndpoint: ${ENDPOINT_URL}`, type: "info" }]);
    expect(calls).toEqual([]);
    expect(await auth.store.read(ENDPOINT_URL)).toBeUndefined();
  });

  it("prints the setup steps in place of the endpoint when none is configured", async () => {
    const ui = scriptedUi({});

    await run("", ui, {
      config: () => {
        throw new Refusal(`/cloudpid is not set up.\n${SETUP_STEPS}`);
      },
    });

    expect(ui.notices[0]?.message).toContain(USAGE);
    expect(ui.notices[0]?.message).toContain("not set up");
    expect(ui.notices[0]?.message).toContain("cloudpid.baseUrl");
    expect(calls).toEqual([]);
  });

  it("says what was wrong with an unknown subcommand, and does nothing else", async () => {
    const ui = scriptedUi({});

    await run("fix the failing test", ui);

    expect(ui.notices).toHaveLength(1);
    expect(ui.notices[0]?.type).toBe("warning");
    expect(ui.notices[0]?.message).toContain("Unknown subcommand: fix.");
    expect(ui.notices[0]?.message).toContain(USAGE);
    expect(calls).toEqual([]);
  });
});

describe("login", () => {
  it("signs in to the configured endpoint, replacing a stored sign-in", async () => {
    const oauth = oauthServer();
    const stub = stubEndpoint({ oauth, store: auth.store });
    const ui = scriptedUi({});

    await auth.store.write(ENDPOINT_URL, oauth.signedIn());

    await run("login", ui, {
      signIn: (given) =>
        signIn(given, ui, {
          store: auth.store,
          fetch: stub.fetch,
          openBrowser: oauth.browse,
          client: "pi-cloudpid/test",
          now: oauth.now,
        }),
    });

    expect(ui.notices.at(-1)).toEqual({
      message: `cloudpid: signed in to ${ENDPOINT_URL}.`,
      type: "info",
    });
    expect((await auth.store.read(ENDPOINT_URL))?.tokens?.access_token).toBe("access-2");
  });

  it("says so when the endpoint wants no sign-in", async () => {
    const ui = scriptedUi({});

    await run("login", ui, { signIn: () => Promise.resolve("not-required") });

    expect(ui.notices[0]?.message).toContain("does not ask for a sign-in");
  });

  it("refuses without pi's interactive mode, and when the endpoint is not configured", async () => {
    await expect(run("login", scriptedUi({}), {}, false)).rejects.toThrow(
      /needs pi's interactive mode/,
    );
    await expect(
      run("login", scriptedUi({}), {
        config: () => {
          throw new Refusal("not set up");
        },
      }),
    ).rejects.toThrow("not set up");
    expect(calls).toEqual([]);
  });
});

describe("logout", () => {
  const entry = (label: string) => ({
    tokens: { access_token: label, token_type: "Bearer" as const },
  });

  it("deletes the stored sign-in of the configured endpoint, and only that one", async () => {
    const ui = scriptedUi({});

    await auth.store.write(ENDPOINT_URL, entry("here"));
    await auth.store.write("https://preview.example.test/mcp", entry("preview"));

    await run("logout", ui);

    expect(ui.notices[0]?.message).toContain(`signed out of ${ENDPOINT_URL}`);
    expect(await auth.store.read(ENDPOINT_URL)).toBeUndefined();
    expect((await auth.store.read("https://preview.example.test/mcp"))?.tokens?.access_token).toBe(
      "preview",
    );

    await run("logout", ui);

    expect(ui.notices[1]?.message).toBe(`cloudpid: no stored sign-in for ${ENDPOINT_URL}.`);
    expect(calls).toEqual([]);
  });

  it("refuses when the endpoint is not configured, deleting nothing", async () => {
    await auth.store.write(ENDPOINT_URL, entry("here"));

    await expect(
      run("logout", scriptedUi({}), {
        config: () => {
          throw new Refusal("not set up");
        },
      }),
    ).rejects.toThrow("not set up");
    expect(await auth.store.read(ENDPOINT_URL)).toBeDefined();
  });
});

describe("import", () => {
  it("runs the import flow with everything after `import` as the instruction", async () => {
    const ui = scriptedUi({});

    // Headless, the flow's first refusal names itself: the verb reached `importSession`.
    await expect(run("import login and logout flows", ui, {}, false)).rejects.toThrow(
      /\/cloudpid import needs pi's interactive mode/,
    );
    expect(calls).toEqual([]);
  });
});
