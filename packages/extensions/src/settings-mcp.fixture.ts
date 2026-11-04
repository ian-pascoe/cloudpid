// The world the `settings_mcp` changing tools' tests run in: the Settings at two Scopes (the fixture's, the Registry's rules over
// plain JSON), the server set resolved by the owner's resolver, the real widening check, the in-memory fake host, and Approvals
// that answer as the test says. Shared by the tests of the tools that change servers (`settings-mcp-changes.test.ts`,
// `settings-mcp-definitions.test.ts`).
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off globalDate:off
import {
  checkMcpWidening,
  type McpResolvedServer,
  overridesFrom,
  resolveMcpServerSet,
  resolveOverridesLeniently,
} from "@cloudpid/config";
import type {
  AgentChange,
  SettingsMcpChangeCheck,
  SettingsMcpRepo,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { expect } from "vitest";
import {
  type ApprovalAnswer,
  type ApprovalAsk,
  Approvals,
  type ApprovalsError,
} from "./approvals.ts";
import { AgentChangeLog, DeployCredentials } from "./environment.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  SettingsReload,
  type SettingsView,
} from "./settings.ts";
import {
  changeGlobalSettings,
  changeSettingsOverrides,
  resolvedGlobal,
} from "./settings.fixture.ts";
import type { RecordedField } from "./settings.fixture.ts";
import { SettingsMcpAccess, type SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { McpChangeTools, McpChanges } from "./settings-mcp-changes.ts";
import { McpDefinitionTools } from "./settings-mcp-definitions.ts";

export const DEFAULT = "default";
export const STAGING = "staging";

export const FILES = { command: "node", args: ["files.js"] };
export const DOCS = { url: "https://docs.example/mcp", toolExposure: { "delete_*": "hidden" } };

export const field = (key: string, name = "files") => `mcp.servers.${name}.${key}`;

type World = {
  global: Schema.Json;
  environments: Record<string, { name: string; overrides: Schema.Json }>;
};

/** The world as a test sets it up, with the tools over fakes of the Registry's reads, writes and check. */
export const setup = async (
  start: {
    readonly global?: Schema.Json;
    readonly overrides?: Readonly<Record<string, Schema.Json>>;
    readonly own?: string;
    readonly hostServers?: ReadonlyArray<FakeMcpServer>;
    readonly offered?: ReadonlyArray<string>;
    /** The owner's answers to the requests, in order; the rest are approved. */
    readonly answers?: ReadonlyArray<{ readonly approve: boolean; readonly reason?: string }>;
    /** Runs when a request is asked, before the owner answers: what changes in the world meanwhile. */
    readonly onAsk?: (request: ApprovalAsk) => void;
    /** Task ids whose requests an eviction left waiting: those calls are reruns. */
    readonly held?: ReadonlyArray<number>;
    /** What each `${NAME}` is at the Environments: the rest are missing. */
    readonly known?: Readonly<Record<string, "secret" | "variable">>;
    /** The Environments' Repos: their files as last looked at, and the servers each holds. */
    readonly repos?: ReadonlyArray<{
      readonly directory: string;
      readonly servers: Readonly<Record<string, Schema.Json>>;
      readonly state?: string;
    }>;
  } = {},
) => {
  const world: World = {
    global: start.global ?? {},
    environments: {
      [DEFAULT]: { name: "Default", overrides: start.overrides?.[DEFAULT] ?? {} },
      [STAGING]: { name: "Staging", overrides: start.overrides?.[STAGING] ?? {} },
    },
  };

  const own = start.own ?? DEFAULT;
  const recorded: AgentChange[] = [];
  const logged: Array<{ tool: string; field: string }> = [];
  const events: string[] = [];
  const asked: ApprovalAsk[] = [];
  const changeCalls: Array<{ scope: string; approved: boolean; guard: unknown }> = [];
  const held = new Set(start.held ?? []);
  let answered = 0;
  const host = fakeMcpHost(start.hostServers ?? []);

  const record = (
    made: Omit<AgentChange, "id" | "at" | "actor" | "session" | "reverts" | "revertedBy">,
  ): AgentChange => {
    const change: AgentChange = {
      id: recorded.length + 1,
      at: 1_000,
      actor: "agent",
      session: "s-1",
      reverts: null,
      revertedBy: null,
      ...made,
    };

    recorded.push(change);

    return change;
  };

  const dummy = (made: RecordedField): AgentChange => ({
    id: 0,
    at: 0,
    actor: "agent",
    session: null,
    conversation: null,
    tool: null,
    reason: "",
    reverts: null,
    revertedBy: null,
    ...made,
  });

  const setOf = (environment: string | undefined, global = world.global, overrides?: Schema.Json) =>
    resolveMcpServerSet(
      global,
      environment === undefined
        ? {}
        : (overrides ?? world.environments[environment]?.overrides ?? {}),
      [],
    );

  const missing = (id: string) =>
    SettingsAccessError.make({ message: `No Environment has the id ${JSON.stringify(id)}.` });

  const settings: SettingsAccessService = {
    get: (scope) =>
      Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
        if (scope === GLOBAL_SETTINGS_SCOPE) {
          const resolved = resolvedGlobal(world.global);

          return Effect.succeed({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings: resolved,
            overrides: overridesFrom(resolved),
            overriddenIn: {},
          });
        }

        const environment = world.environments[scope];

        if (environment === undefined) return Effect.fail(missing(scope));

        const lenient = resolveOverridesLeniently(world.global, environment.overrides);

        return Effect.succeed({
          scope,
          name: environment.name,
          settings: lenient.settings,
          overrides: lenient.overrides,
          global: lenient.global,
          instructions: "",
        });
      }),
    own: Effect.succeed(own),
    change: ({ scope, changes, author: { conversation, tool, reason, approved }, guard }) =>
      Effect.suspend(() => {
        changeCalls.push({ scope, approved: approved === true, guard });
        events.push(
          `change ${scope} ${Arr.join(
            Arr.map(changes, (each) => each.field),
            ",",
          )}`,
        );

        if (scope === GLOBAL_SETTINGS_SCOPE) {
          const changed = changeGlobalSettings(world.global, changes, (made) =>
            record({ ...made, conversation, tool, reason }),
          );

          world.global = changed.global;

          return Effect.succeed(changed.answer);
        }

        const environment = world.environments[scope];

        if (environment === undefined) return Effect.fail(missing(scope));

        const changed = changeSettingsOverrides(
          world.global,
          environment.overrides,
          scope,
          changes,
          (made) => record({ ...made, conversation, tool, reason }),
        );

        environment.overrides = changed.overrides;

        return Effect.succeed(changed.answer);
      }),
  };

  const serverOf = (resolved: McpResolvedServer): SettingsMcpServer => ({
    server: resolved,
    origins: { enabled: "default", exposure: "default", toolExposure: "default" },
    reads: [],
    resetFields: [],
    signIn: null,
    hints: [],
    problems: [],
  });

  const access: SettingsMcpAccessService = {
    view: ({ scope, name }) =>
      Effect.suspend(() => {
        const global = scope === GLOBAL_SETTINGS_SCOPE;
        const environment = world.environments[scope];

        if (!global && environment === undefined) return Effect.fail(missing(scope));

        const set = setOf(global ? undefined : scope);
        const shown = Arr.filter(set.servers, (each) => name === undefined || each.name === name);

        const definedIn =
          global && name !== undefined && shown.length === 0
            ? Arr.filterMap(Record.toEntries(world.environments), ([id, each]) =>
                Arr.some(setOf(id).servers, (server) => server.name === name)
                  ? Result.succeed({ id, name: each.name })
                  : Result.failVoid,
              )
            : undefined;

        const repoViews: ReadonlyArray<SettingsMcpRepo> = global
          ? []
          : Arr.map(start.repos ?? [], (repo) => ({
              repo: repo.directory,
              path: ".pi/mcp.json",
              state: repo.state ?? "read",
              blob: `blob-${repo.directory}`,
            }));

        const view: Mutable<SettingsMcpView> = {
          scope,
          name: global ? "Global" : (environment?.name ?? scope),
          servers: Arr.map(shown, serverOf),
          names: Arr.map(set.servers, (each) => each.name),
          layers: null,
          repos: repoViews,
          orphans: set.orphans,
          problems: set.problems,
          offered: start.offered ?? [],
          warnings: [],
        };

        if (definedIn !== undefined) view.definedIn = definedIn;

        if (!global && name !== undefined) {
          view.layers = {
            global: null,
            environment: null,
            repos: Arr.filterMap(start.repos ?? [], (repo) => {
              const written = repo.servers[name];

              return written === undefined
                ? Result.failVoid
                : Result.succeed({
                    kind: "entry" as const,
                    value: written,
                    source: {
                      kind: "repo" as const,
                      directory: repo.directory,
                      slug: `owner/${repo.directory}`,
                      path: ".pi/mcp.json",
                    },
                    name,
                    shadowed: false,
                  });
            }),
          };
        }

        return Effect.succeed(view);
      }),
    own: Effect.succeed(own),
    check: ({ scope, name, changes, reads }) =>
      Effect.sync((): SettingsMcpChangeCheck => {
        const ids = scope === GLOBAL_SETTINGS_SCOPE ? Record.keys(world.environments) : [scope];

        return {
          environments: Arr.filterMap(ids, (id) => {
            const before = Arr.findFirst(setOf(id).servers, (each) => each.name === name);
            const environment = world.environments[id];
            let afterSet = setOf(id);

            if (scope === GLOBAL_SETTINGS_SCOPE) {
              const changed = changeGlobalSettings(world.global, changes, dummy);

              afterSet = setOf(id, changed.global);
            } else if (environment !== undefined) {
              const changed = changeSettingsOverrides(
                world.global,
                environment.overrides,
                id,
                changes,
                dummy,
              );

              afterSet = setOf(id, world.global, changed.overrides);
            }

            const after = Arr.findFirst(afterSet.servers, (each) => each.name === name);

            if (Option.isNone(before) && Option.isNone(after)) return Result.failVoid;

            return Result.succeed({
              environment: { id, name: environment?.name ?? id },
              reads: Arr.map(reads ?? [], (read) => ({
                name: read,
                kind: start.known?.[read] ?? ("missing" as const),
              })),
              reached:
                JSON.stringify(Option.getOrUndefined(before)?.server) !==
                JSON.stringify(Option.getOrUndefined(after)?.server),
              widening: checkMcpWidening(
                Option.getOrUndefined(before),
                Option.getOrUndefined(after),
              ),
            });
          }),
        };
      }),
    reload: () => Effect.die("unused"),
    pushes: (environment) =>
      Effect.sync(() => {
        events.push(`pushes ${environment}`);

        return [{ kind: "set" as const, hash: `hash-${environment}`, revision: 7, entries: [] }];
      }),
    pushed: ({ environment }) =>
      Effect.sync(() => {
        events.push(`pushed ${environment}`);
      }),
    host: () => host.client,
  };

  const secrets: Pick<SecretsService, "refresh" | "redact"> = {
    refresh: Effect.void,
    redact: (value) => value,
  };

  const provided = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | SettingsMcpAccess
      | SettingsAccess
      | SettingsReload
      | AgentChangeLog
      | DeployCredentials
      | Secrets
      | Approvals
    >,
  ) =>
    effect.pipe(
      Effect.provideService(SettingsMcpAccess, access),
      Effect.provideService(SettingsAccess, settings),
      Effect.provideService(SettingsReload, {
        apply: Effect.succeed({ picked: { model: false, thinkingLevel: false } }),
      }),
      Effect.provideService(AgentChangeLog, {
        record: (change) =>
          Effect.sync(() => {
            logged.push({ tool: change.tool, field: change.field });
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [] }),
      Effect.provideService(Approvals, {
        ask: (request) =>
          Effect.sync((): ApprovalAnswer => {
            asked.push(request);
            start.onAsk?.(request);

            const given = start.answers?.[answered];

            answered += 1;

            return given?.approve === false
              ? { approved: false, reason: given.reason, expected: request.expected }
              : { approved: true, expected: request.expected };
          }),
        settle: () => Effect.void,
        holds: (id) => Effect.succeed(held.has(Number(id))),
        pending: Effect.succeed([]),
        answer: () => Effect.void,
        dropAbandoned: Effect.void,
      }),
      // SAFETY: the tools use only `refresh` and `redact`.
      Effect.provideService(Secrets, secrets as SecretsService),
    );

  const extension = [
    ...(await Effect.runPromise(McpChangeTools.pipe(provided))),
    ...(await Effect.runPromise(McpDefinitionTools.pipe(provided))),
  ];

  const changes = await Effect.runPromise(McpChanges.pipe(provided));

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension, (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  return { world, recorded, logged, events, host, tool, changes, asked, changeCalls };
};

/** The invocation's API of the call with task id `taskId`: the tools read only the conversation and the task. */
export const callApi = (taskId = 1, details?: ToolExecutionApi["details"]) =>
  // SAFETY: the tools read only the calling conversation, task and running details from the invocation's API.
  ({ conversationId: ROOT_CONVERSATION_ID, taskId, details }) as ToolExecutionApi;

export type Outcome = Awaited<ReturnType<ToolRegistration["execute"]>>;

export const run = (
  tool: ToolRegistration,
  args: Readonly<Record<string, unknown>>,
  taskId = 1,
  details?: ToolExecutionApi["details"],
): Promise<Outcome> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, callApi(taskId, details), BACKGROUND_CONTEXT);

export const text = (result: Outcome): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

export const failure = async (call: Promise<Outcome>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

export const REASON = "Not used by this project";

/** What `settings_reset` does for an MCP field, as `McpChanges.resetField` runs it. */
export const reset = (
  changes: Awaited<ReturnType<typeof setup>>["changes"],
  scope: string,
  fieldName: string,
) =>
  Effect.runPromise(
    changes.resetField({ scope, field: fieldName, reason: REASON, api: callApi() }).pipe(
      // SAFETY: `resetField` yields the tool's outcome, whose shape `Outcome` names.
      Effect.map((result) => ({ ok: true as const, text: text(result as Outcome) })),
      Effect.catch((error: SettingsAccessError | ApprovalsError) =>
        Effect.succeed({ ok: false as const, text: error.message }),
      ),
    ),
  );
