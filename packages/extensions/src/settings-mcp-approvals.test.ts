// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session, Built so far: S3b-2: the cores of
// the MCP servers' tools that ask the owner on the endpoint (`mcpApprovalCores`). `prepare` decides whether a call asks (a
// definition and switching on always do; the others when the Registry's check says they widen) and what the card and `expected`
// are; `apply` writes exactly `expected`'s `after`, only while the Scope has the value the owner saw, under the Registry's guard;
// `render` leaves the push to the main Worker's `sync` and answers the status `not_checked`. The world is the MCP fixture's.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalJsonInEffect:off
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { Prepared } from "./approval-cores.ts";
import { expectEndpointWords } from "./endpoint-words.fixture.ts";
import { type McpApprovalCores, mcpApprovalCores } from "./settings-mcp-approvals.ts";
import { SettingsAccessError } from "./settings.ts";
import { DEFAULT, DOCS, FILES, REASON, STAGING, field, setup } from "./settings-mcp.fixture.ts";

const author = (tool: string) => ({ tool, reason: REASON });

const world = async (start: Parameters<typeof setup>[0] = {}) => {
  const harness = await setup(start);
  const synced: Array<string> = [];

  const thunks = mcpApprovalCores({
    settings: harness.settings,
    access: harness.access,
    holdsSecret: () => Effect.succeed(false),
    sync: (environment) => Effect.sync(() => void synced.push(environment)),
  });

  const cores: McpApprovalCores = {
    settings_mcp_add: thunks.settings_mcp_add(),
    settings_mcp_update: thunks.settings_mcp_update(),
    settings_mcp_enable: thunks.settings_mcp_enable(),
    settings_mcp_exposure_set: thunks.settings_mcp_exposure_set(),
    settings_mcp_tool_exposure_set: thunks.settings_mcp_tool_exposure_set(),
    settings_mcp_remove: thunks.settings_mcp_remove(),
    settings_reset: thunks.settings_reset(),
  };

  const run = <A, E>(made: Effect.Effect<A, E>) => Effect.runPromise(made);

  return { ...harness, cores, synced, run };
};

/** One way a call can be: its core of the table, the arguments, and what `prepare` makes of it. */
type Row = {
  readonly name: string;
  readonly start: Parameters<typeof setup>[0];
  readonly prepare: (cores: McpApprovalCores) => Promise<Pick<Prepared<unknown>, "immediate">>;
  readonly asks: boolean;
};

const HIDDEN_FILES = { ...FILES, exposure: "hidden" };

describe("which MCP server calls ask the owner", () => {
  const rows: ReadonlyArray<Row> = [
    {
      name: "settings_mcp_add always asks",
      start: {},
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_add.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "files",
            entry: FILES,
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_mcp_update always asks, though it narrows",
      start: { global: { mcp: { servers: { files: FILES } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_update.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "files",
            set: { args: ["other.js"] },
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_mcp_enable always asks",
      start: {
        global: { mcp: { servers: { files: { ...FILES, enabled: false } } } },
      },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_enable.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "files",
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_mcp_exposure_set to hidden narrows, so it is made at once",
      start: { global: { mcp: { servers: { files: FILES } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_exposure_set.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "files",
            exposure: "hidden",
            reason: REASON,
          }),
        ),
      asks: false,
    },
    {
      name: "settings_mcp_exposure_set out of hidden widens, so it asks",
      start: { global: { mcp: { servers: { files: HIDDEN_FILES } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_exposure_set.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "files",
            exposure: "codemode",
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_mcp_tool_exposure_set hiding a tool narrows",
      start: { global: { mcp: { servers: { docs: DOCS } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_tool_exposure_set.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "docs",
            tool: "drop_*",
            exposure: "hidden",
            reason: REASON,
          }),
        ),
      asks: false,
    },
    {
      name: "settings_mcp_tool_exposure_set removing a hidden key widens",
      start: { global: { mcp: { servers: { docs: DOCS } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_tool_exposure_set.prepare({
            scope: GLOBAL_SETTINGS_SCOPE,
            name: "docs",
            tool: "delete_*",
            exposure: null,
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_mcp_remove of a server that falls back to nothing narrows",
      start: { overrides: { [STAGING]: { mcp: { servers: { files: FILES } } } } },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_remove.prepare({ scope: STAGING, name: "files", reason: REASON }),
        ),
      asks: false,
    },
    {
      name: "settings_mcp_remove that falls back to a wider server asks",
      start: {
        global: { mcp: { servers: { files: FILES } } },
        overrides: { [DEFAULT]: { mcp: { servers: { files: HIDDEN_FILES } } } },
      },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_mcp_remove.prepare({ scope: DEFAULT, name: "files", reason: REASON }),
        ),
      asks: true,
    },
    {
      name: "settings_reset of an adjustment that switches a server back on asks",
      start: {
        global: { mcp: { servers: { files: FILES } } },
        overrides: { [DEFAULT]: { mcp: { servers: { files: { enabled: false } } } } },
      },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_reset.prepare({
            scope: DEFAULT,
            field: field("enabled"),
            reason: REASON,
          }),
        ),
      asks: true,
    },
    {
      name: "settings_reset of an adjustment that hides a server narrows",
      start: {
        global: { mcp: { servers: { files: HIDDEN_FILES } } },
        overrides: { [DEFAULT]: { mcp: { servers: { files: { exposure: "codemode" } } } } },
      },
      prepare: (cores) =>
        Effect.runPromise(
          cores.settings_reset.prepare({
            scope: DEFAULT,
            field: field("exposure"),
            reason: REASON,
          }),
        ),
      asks: false,
    },
  ];

  it.each(rows)("$name", async ({ start, prepare, asks }) => {
    const { cores } = await world(start);
    const prepared = await prepare(cores);

    expect(prepared.immediate === true).toBe(!asks);
  });

  it("answers a call that finds the change made already as unchanged, asking nothing", async () => {
    const { cores, run } = await world({
      global: { mcp: { servers: { files: FILES } } },
    });

    const prepared = await run(
      cores.settings_mcp_enable.prepare({
        scope: GLOBAL_SETTINGS_SCOPE,
        name: "files",
        reason: REASON,
      }),
    );

    expect(prepared.unchanged).toMatchObject({ structured: { unchanged: [field("enabled")] } });
  });
});

describe("an approved MCP server change", () => {
  const entry = { command: "node", args: ["new.js"] };

  it("writes exactly what the owner saw, under the guard, and leaves the push to the main Worker", async () => {
    const { cores, run, synced, events, changeCalls, world: state } = await world();

    const args = { scope: GLOBAL_SETTINGS_SCOPE, name: "files", entry, reason: REASON };
    const prepared = await run(cores.settings_mcp_add.prepare(args));

    expect(prepared.immediate).toBe(false);
    expect(prepared.expected).toMatchObject({ value: null, after: entry });

    const applied = await run(
      cores.settings_mcp_add.apply(args, prepared.expected, author("settings_mcp_add")),
    );

    expect(applied.result.status).toBe("changed");
    expect(state.global).toEqual({ mcp: { servers: { files: entry } } });
    expect(changeCalls).toMatchObject([
      { scope: GLOBAL_SETTINGS_SCOPE, approved: true, guard: { name: "files" } },
    ]);

    const answer = await run(
      cores.settings_mcp_add.render(args, prepared.expected, applied, undefined),
    );

    // The status is not checked, and the host is asked nothing: each Environment the change reaches is synced after the answer.
    expect(answer.structured).toMatchObject({ server_status: { state: "not_checked" } });
    expectEndpointWords(answer.text);
    expect(synced.toSorted()).toEqual([DEFAULT, STAGING]);
    expect(events).not.toContain(`pushes ${DEFAULT}`);
  });

  it("is a changed-since, with nothing written, when the Scope's value is not the one the owner saw", async () => {
    const {
      cores,
      run,
      recorded,
      world: state,
    } = await world({
      global: { mcp: { servers: { files: HIDDEN_FILES } } },
    });

    const args = {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      exposure: "codemode",
      reason: REASON,
    } as const;

    const prepared = await run(cores.settings_mcp_exposure_set.prepare(args));

    // Meanwhile the entry changed.
    state.global = { mcp: { servers: { files: { ...FILES, exposure: "direct" } } } };

    const applied = await run(
      cores.settings_mcp_exposure_set.apply(
        args,
        prepared.expected,
        author("settings_mcp_exposure_set"),
      ),
    );

    expect(applied.result.status).toBe("changed-since");
    expect(recorded).toEqual([]);

    const refused = await Effect.runPromise(
      cores.settings_mcp_exposure_set
        .render(args, prepared.expected, applied, undefined)
        .pipe(Effect.flip),
    );

    expect(refused).toBeInstanceOf(SettingsAccessError);
    expectEndpointWords(refused.message);
  });

  it("guards an entry written at an Environment with the ${NAME}s it reads", async () => {
    const { cores, run, changeCalls } = await world({ known: { TOKEN: "secret" } });

    const args = {
      scope: DEFAULT,
      name: "files",
      entry: { command: "node", env: { MODE: "${TOKEN}" } },
      reason: REASON,
    };

    const prepared = await run(cores.settings_mcp_add.prepare(args));

    await run(cores.settings_mcp_add.apply(args, prepared.expected, author("settings_mcp_add")));

    expect(changeCalls).toMatchObject([{ guard: { name: "files", reads: ["TOKEN"] } }]);
  });

  it("is applied from the request's arguments alone when no known is handed on, as the Registry's apply does", async () => {
    const {
      cores,
      run,
      world: state,
    } = await world({
      global: { mcp: { servers: { files: { ...FILES, enabled: false } } } },
    });

    const args = { scope: GLOBAL_SETTINGS_SCOPE, name: "files", reason: REASON };
    const prepared = await run(cores.settings_mcp_enable.prepare(args));

    const applied = await run(
      cores.settings_mcp_enable.apply(args, prepared.expected, author("settings_mcp_enable")),
    );

    expect(applied.result.status).toBe("changed");
    expect(state.global).toEqual({ mcp: { servers: { files: FILES } } });

    // The answer an apply from the stored arguments alone gives names the owner, as the endpoint's every answer does.
    const answer = await run(
      cores.settings_mcp_enable.render(args, prepared.expected, applied, undefined),
    );

    expectEndpointWords(answer.text);
  });

  it("says of an answer rebuilt from a claim that it may reach each Environment, which it sends the set again, not which", async () => {
    const { cores, run, synced } = await world({
      overrides: { [STAGING]: { mcp: { servers: { files: { ...FILES, args: ["own.js"] } } } } },
    });

    const args = { scope: GLOBAL_SETTINGS_SCOPE, name: "files", entry: FILES, reason: REASON };
    const prepared = await run(cores.settings_mcp_add.prepare(args));

    const applied = await run(
      cores.settings_mcp_add.apply(args, prepared.expected, author("settings_mcp_add")),
    );

    const known = await run(cores.settings_mcp_add.knownFromClaim(args, prepared.expected));

    expect(known.everywhere).toBe(true);

    synced.length = 0;

    const answer = await run(
      cores.settings_mcp_add.render(
        args,
        prepared.expected,
        { known, result: applied.result },
        undefined,
      ),
    );

    // Every Environment is sent the set again, though Staging's own entry overrides Global's.
    expect(synced.toSorted()).toEqual([DEFAULT, STAGING]);
    // The words say the change may reach each one rather than which (`everywhere`); the sentence itself is not pinned.
    expectEndpointWords(answer.text);
  });
});
