// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The tools, Approvals with no Session: the Settings'
// and the MCP servers' changing tools as the endpoint serves them (`settingsEndpointCores`). Each makes its change as the
// Session's tool does, in the endpoint's words (the owner, no Session; `harness-tools.test.ts` keeps unserved tools out); a Limit
// (whose reset the dispatcher asks for before the core) answers `unsupported`, and a reset of the Instructions `invalid_argument`;
// a change that would make something reachable that is not (which the dispatcher asks the owner for before the core, so one
// that reaches it widens only because the state changed since) `unavailable`; with nothing asked, saved or recorded. The world is
// the MCP fixture's: Settings at two Scopes, the real widening check, a fake host.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { WIDENING_REFUSAL_TAIL } from "@cloudpid/protocol";
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { mcpReloadCore, SETTINGS_REPLAYED, settingsEndpointCores } from "./settings-endpoint.ts";
import { DEFAULT, DOCS, FILES, REASON, STAGING, field, setup } from "./settings-mcp.fixture.ts";

// The wording assertions here are the endpoint's contract and nothing else (D13, `mcp-endpoint.md` → Names and surfaces): an
// answer says the owner, never the user, and has no sentence for a Session. The tools the endpoint does not serve are kept
// out of its words by `harness-tools.test.ts`, which reads the declarations; the rest of a sentence is not pinned.
const SESSION_WORDS = ["this Session", "the user"];

const world = async (start: Parameters<typeof setup>[0] = {}) => {
  const harness = await setup(start);
  const synced: Array<string> = [];

  const cores = settingsEndpointCores({
    settings: harness.settings,
    settingsMcp: harness.access,
    holdsSecret: () => Effect.succeed(false),
    sync: (environment) => Effect.sync(() => void synced.push(environment)),
  });

  /** A core's answer or its refusal, as the dispatcher reads them. */
  const call = <A>(made: Effect.Effect<A, { readonly message: string; readonly code?: string }>) =>
    Effect.runPromise(
      made.pipe(
        Effect.map((answer) => ({ ok: true as const, answer })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      ),
    );

  return { ...harness, cores, call, synced };
};

const noSessionWords = (text: string) => {
  for (const word of SESSION_WORDS) expect(text).not.toContain(word);
};

describe("the Settings' tools on the endpoint", () => {
  it("settings_model_set makes the change in the owner's words and records it for the dispatcher", async () => {
    const { cores, call, recorded } = await world();

    const done = await call(
      cores.settings_model_set(
        { scope: DEFAULT, thinking_level: "high", reason: REASON },
        "endpoint",
      ),
    );

    expect(done.ok).toBe(true);

    if (!done.ok) return;

    expect(recorded).toHaveLength(1);
    expect(done.answer.text).toContain("owner");
    noSessionWords(done.answer.text);
    expect(done.answer.structured).toMatchObject({ unchanged: [] });
    expect(done.answer.structured).not.toHaveProperty("approval");
  });

  it.each(["maxSubagentDepth", "maxSubagentWorkspaces"])(
    "settings_extension_set of the Limit %s is unsupported, with nothing saved",
    async (key) => {
      const { cores, call, recorded } = await world();

      const refused = await call(
        cores.settings_extension_set(
          { scope: DEFAULT, extension: "subagents", key, value: 2, reason: REASON },
          "endpoint",
        ),
      );

      expect(refused).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(recorded).toEqual([]);
    },
  );
});

describe("settings_reset on the endpoint", () => {
  it("removes an Environment's Override of a plain field, in the owner's words", async () => {
    const {
      cores,
      call,
      recorded,
      world: state,
    } = await world({
      overrides: { [DEFAULT]: { compaction: { enabled: false } } },
    });

    const done = await call(
      cores.settings_reset(
        { scope: DEFAULT, field: "compaction.enabled", reason: REASON },
        "endpoint",
      ),
    );

    expect(done.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(state.environments[DEFAULT]?.overrides).toEqual({});

    if (done.ok) noSessionWords(done.answer.text);
  });

  it.each([
    ["spendLimit.perSession", "unsupported"],
    ["extensions.subagents.maxSubagentDepth", "unsupported"],
    ["extensions.subagents.maxSubagentWorkspaces", "unsupported"],
    ["instructions", "invalid_argument"],
  ])("refuses a reset of %s as %s, with nothing saved", async (name, code) => {
    const { cores, call, recorded } = await world();

    const refused = await call(
      cores.settings_reset(
        { scope: GLOBAL_SETTINGS_SCOPE, field: name, reason: REASON },
        "endpoint",
      ),
    );

    expect(refused).toMatchObject({ ok: false, error: { code } });
    expect(recorded).toEqual([]);
  });

  it("refuses a field it does not know as invalid_argument", async () => {
    const { cores, call } = await world();

    const refused = await call(
      cores.settings_reset({ scope: DEFAULT, field: "nonsense", reason: REASON }, "endpoint"),
    );

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });

  it("answers a reset of an MCP adjustment that would make a hidden tool reachable as unavailable", async () => {
    const { cores, call, recorded, asked } = await world({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { enabled: false } } } } },
    });

    const refused = await call(
      cores.settings_reset({ scope: DEFAULT, field: field("enabled"), reason: REASON }, "endpoint"),
    );

    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(asked).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("the MCP servers' tools on the endpoint", () => {
  it("settings_mcp_disable switches the server off, leaves the push to the main Worker and asks nobody", async () => {
    const { cores, call, recorded, events, asked, synced } = await world({
      global: { mcp: { servers: { files: FILES } } },
    });

    const done = await call(
      cores.settings_mcp_disable({ scope: DEFAULT, name: "files", reason: REASON }, "endpoint"),
    );

    expect(done.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(recorded).toHaveLength(1);
    // The host is asked nothing: each Environment the change reaches is handed to `mcp.sync`, after the answer.
    expect(synced).toEqual([DEFAULT]);
    expect(events).not.toContain(`pushes ${DEFAULT}`);

    if (done.ok) {
      noSessionWords(done.answer.text);
      expect(done.answer.logged).toEqual([
        { tool: "settings_mcp_disable", environmentName: "Default", field: field("enabled") },
      ]);
    }
  });

  it("settings_mcp_exposure_set narrows at once and answers a widening as unavailable", async () => {
    const {
      cores,
      call,
      recorded,
      asked,
      world: state,
    } = await world({
      global: { mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } },
    });

    const widening = await call(
      cores.settings_mcp_exposure_set(
        { scope: GLOBAL_SETTINGS_SCOPE, name: "files", exposure: "codemode", reason: REASON },
        "endpoint",
      ),
    );

    expect(widening).toMatchObject({ ok: false, error: { code: "unavailable" } });

    expect(asked).toEqual([]);
    expect(recorded).toEqual([]);
    expect(state.global).toEqual({ mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } });

    const narrowing = await call(
      cores.settings_mcp_exposure_set(
        { scope: GLOBAL_SETTINGS_SCOPE, name: "files", exposure: "hidden", reason: REASON },
        "endpoint",
      ),
    );

    expect(narrowing.ok).toBe(true);
  });

  // The Registry's own words name the Session's user; the endpoint's answer to its guard's refusal is its own. Any other
  // rejection of the write (a bound, a name clash) is the Registry's, as it was.
  it.each([
    {
      name: "the guard's refusal, because the change widens now, as unavailable in the owner's words",
      rejects: `it needs the user's Approval, ${WIDENING_REFUSAL_TAIL}`,
      code: "unavailable",
    },
    {
      name: "any other rejection as invalid_argument",
      rejects: "an entry may be at most 16 KiB",
      code: "invalid_argument",
    },
  ])("answers a narrowing change the Registry rejected with $name", async ({ rejects, code }) => {
    const { cores, call, changeCalls } = await world({
      global: { mcp: { servers: { files: FILES } } },
      rejects,
    });

    const refused = await call(
      cores.settings_mcp_exposure_set(
        { scope: GLOBAL_SETTINGS_SCOPE, name: "files", exposure: "hidden", reason: REASON },
        "endpoint",
      ),
    );

    expect(refused).toMatchObject({ ok: false, error: { code } });
    expect(changeCalls).toMatchObject([{ guard: { name: "files", widening: true } }]);

    if (!refused.ok && code === "unavailable") noSessionWords(refused.error.message);
  });

  it("settings_mcp_tool_exposure_set hides a tool at once and answers loosening a hidden key as unavailable", async () => {
    const { cores, call, recorded } = await world({
      global: { mcp: { servers: { docs: DOCS } } },
    });

    const hiding = await call(
      cores.settings_mcp_tool_exposure_set(
        {
          scope: GLOBAL_SETTINGS_SCOPE,
          name: "docs",
          tool: "drop_*",
          exposure: "hidden",
          reason: REASON,
        },
        "endpoint",
      ),
    );

    expect(hiding.ok).toBe(true);
    expect(recorded).toHaveLength(1);

    const loosening = await call(
      cores.settings_mcp_tool_exposure_set(
        {
          scope: GLOBAL_SETTINGS_SCOPE,
          name: "docs",
          tool: "delete_*",
          exposure: null,
          reason: REASON,
        },
        "endpoint",
      ),
    );

    expect(loosening).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(recorded).toHaveLength(1);
  });

  it("settings_mcp_remove removes the server at once, and answers a removal that falls back to a wider server as unavailable", async () => {
    const {
      cores,
      call,
      recorded,
      world: state,
    } = await world({
      overrides: { [STAGING]: { mcp: { servers: { files: FILES } } } },
    });

    const done = await call(
      cores.settings_mcp_remove({ scope: STAGING, name: "files", reason: REASON }, "endpoint"),
    );

    expect(done.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(state.environments[STAGING]?.overrides).toEqual({});

    const wide = await world({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } } },
    });

    const refused = await wide.call(
      wide.cores.settings_mcp_remove({ scope: DEFAULT, name: "files", reason: REASON }, "endpoint"),
    );

    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(wide.recorded).toEqual([]);
    expect(wide.asked).toEqual([]);
  });

  it("settings_mcp_reload takes an Environment's id only", async () => {
    const { access, call } = await world();

    const refused = await call(mcpReloadCore(access)({ scope: GLOBAL_SETTINGS_SCOPE }, "endpoint"));

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });
});

describe("the replayed answers of the Settings' and MCP servers' tools", () => {
  const recordedChange = (scope: string, scopeName: string) => ({
    id: 4,
    scope,
    scopeName,
    field: "roles.small",
    before: null,
    after: { model: "m" },
  });

  it("name Global's Settings, which the Registry records as `settings`, as Global", () => {
    const answer = SETTINGS_REPLAYED.settings_role_set(
      [recordedChange("settings", "Settings")],
      GLOBAL_SETTINGS_SCOPE,
    );

    expect(answer.structured).toMatchObject({
      replayed: true,
      scope: { id: "*", name: "Global" },
      changes: [{ id: 4, field: "roles.small" }],
    });
  });

  it("keep an Environment's Scope", () => {
    const answer = SETTINGS_REPLAYED.settings_mcp_disable(
      [recordedChange(DEFAULT, "Default")],
      DEFAULT,
    );

    expect(answer.structured).toMatchObject({ scope: { id: DEFAULT, name: "Default" } });
  });
});
