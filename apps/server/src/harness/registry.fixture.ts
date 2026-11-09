// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions and the core/wrapper split (No
// Session), → Retries: `request_id`: a stand-in Registry and McpHost for the management tools (`./services.ts`,
// `./dispatch.ts`, and `/mcp`'s `endpoint.test.ts`): one Environment, "Default", and Global, with the answers the five
// read tools ask for, and, for the change tools, a Registry that records each change with its author and keeps the
// `request_id` claims as `change_requests` does; and the upkeep and `background` the services run after an answer. The
// Registry is cut down to the methods the tools use, and each call to it, to a host or to the upkeep is noted.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS } from "@cloudpid/config";
import {
  type AgentChange,
  SETTINGS_SCOPE,
  type SettingsMcpServer,
  type SettingsMcpView,
} from "@cloudpid/protocol";
import { McpApplied } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { AgentChangeAuthor } from "../registry/agent-changes.ts";
import type { ChangeAnswer } from "../registry/change-requests.ts";
import type { HarnessDeps, HarnessRegistry } from "./services.ts";

/** The Environment the stand-in Registry lists. */
const DEFAULT = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  createdAt: 0,
};

/** The setup script of the Environment: long enough to need a second page of 40,000 characters. */
const LONG_SCRIPT = `${"echo setup\n".repeat(4_000)}echo done\n`;

/** The Instructions kept Global, and the Environment's own. */
const GLOBAL_INSTRUCTIONS = "Prefer small commits.";

const ENVIRONMENT_INSTRUCTIONS = "Run the tests.";

const GLOBAL_CONTAINER = { ...DEFAULT_CONTAINER_SETTINGS, variables: { SHARED: "all" } };

const ENVIRONMENT_CONTAINER = {
  ...GLOBAL_CONTAINER,
  setupScript: LONG_SCRIPT,
  variables: { SHARED: "all", TOKEN_URL: "https://example.test/token" },
};

const server: SettingsMcpServer = {
  server: {
    name: "docs",
    source: { kind: "environment" },
    server: {
      enabled: true,
      exposure: "codemode",
      toolExposure: {},
      timeout: 60,
      sampling: "ask",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: {},
      description: "",
    },
    replacesGlobal: false,
    shadowed: [],
    resolvesSecrets: false,
  },
  origins: { enabled: "default", exposure: "default", toolExposure: "default" },
  reads: [],
  resetFields: [],
  signIn: null,
  hints: [],
  problems: [],
};

/** The MCP view of Environment `default`: its one server `docs`, with its layers as written when `name` names it. */
const view = (name: string | undefined): SettingsMcpView => ({
  scope: "default",
  name: DEFAULT.name,
  servers: name === undefined || name === "docs" ? [server] : [],
  names: ["docs"],
  layers:
    name === "docs" ? { global: null, environment: { kind: "entry", value: {} }, repos: [] } : null,
  repos: [],
  orphans: [],
  problems: [],
  offered: [],
  warnings: [],
});

/** What the Registry was asked, by method: a test that expects no call to the Registry reads it. */
export type RegistryCalls = Array<string>;

/** The stand-in Registry, with the Registry calls noted in `calls`. */
export const harnessRegistry = (calls: RegistryCalls = []): HarnessRegistry => {
  const noted =
    <A, Args extends ReadonlyArray<unknown>>(method: string, answer: (...args: Args) => A) =>
    (...args: Args) =>
      Effect.sync(() => {
        calls.push(method);

        return answer(...args);
      });

  // SAFETY: the five read tools ask these methods only; each answers what the real Registry's would for one Environment.
  return {
    listEnvironments: noted("listEnvironments", () => [DEFAULT]),
    listBuilds: noted("listBuilds", () => [
      { environment: "default", build: { status: "ready" as const, at: 5 } },
    ]),
    getEnvironment: noted("getEnvironment", ({ id }: { readonly id: string }) =>
      id === "default" ? DEFAULT : null,
    ),
    getEnvironmentSettings: noted(
      "getEnvironmentSettings",
      ({ environment }: { readonly environment: string }) =>
        environment === "default"
          ? {
              settings: ENVIRONMENT_CONTAINER,
              global: GLOBAL_CONTAINER,
              overrides: { setupScript: LONG_SCRIPT, variables: ENVIRONMENT_CONTAINER.variables },
            }
          : null,
    ),
    listEnvironmentSecrets: noted("listEnvironmentSecrets", () => []),
    listSkills: noted("listSkills", () => []),
    getGlobalContainerSettings: noted("getGlobalContainerSettings", () => ({
      settings: GLOBAL_CONTAINER,
      overrides: { variables: GLOBAL_CONTAINER.variables },
      overriddenIn: { setupScript: [{ id: "default", name: "Default" }] },
    })),
    getSettings: noted("getSettings", () => ({
      settings: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
      overrides: {},
      problem: undefined,
      overriddenIn: {},
    })),
    getSettingsOverrides: noted(
      "getSettingsOverrides",
      ({ environment }: { readonly environment: string }) =>
        environment === "default"
          ? {
              settings: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
              overrides: {},
              global: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
              problem: undefined,
              instructions: ENVIRONMENT_INSTRUCTIONS,
            }
          : null,
    ),
    mcpServerNames: noted("mcpServerNames", () => ["docs"]),
    mcpSettingsView: noted(
      "mcpSettingsView",
      ({ environment, name }: { readonly environment?: string; readonly name?: string }) =>
        environment === "default" ? view(name) : null,
    ),
  } as never;
};

/** The writing stand-in, and what it holds. */
export type ChangingRegistry = {
  readonly registry: HarnessRegistry;
  readonly ledger: ChangeLedger;
};

/** A `request_id` claim as the stand-in keeps it: as `change_requests` does, with the numbers of its changes. */
type HeldClaim = {
  readonly tool: string;
  readonly digest: string;
  readonly attempt: string;
  answer: ChangeAnswer | null;
  readonly changes: Array<number>;
};

/** What the writing stand-in holds, for a test to read and to change between calls. */
export type ChangeLedger = {
  /** The changes recorded, oldest first, with the author each was recorded as made by. */
  readonly changes: Array<{ readonly change: AgentChange; readonly author: AgentChangeAuthor }>;
  /** The `request_id` claims, by id. */
  readonly claims: Map<string, HeldClaim>;
  /** The values in force, by Scope (`default` or `*`) and field: none is the default. */
  readonly values: Map<string, Schema.Json | null>;
  /** The Build marks of the kept Secrets, by Scope and name. */
  readonly marks: Map<string, boolean>;
};

/** How the writing stand-in behaves where a test needs it to. */
export type ChangeOptions = {
  /** `agentChangeFeatures`'s answer: `{via: true}` unless a test makes it an older Registry's, or a failure. */
  readonly features?: Effect.Effect<{ readonly via: boolean }> | undefined;
  /** Runs with the answer before a settle keeps it: a test that cuts a call there makes it `Effect.never`. */
  readonly beforeSettle?: ((answer: ChangeAnswer) => Effect.Effect<void>) | undefined;
  /** A text whose presence in a value or a reason the Registry refuses as a kept Secret's (`via-secrets.ts`). */
  readonly keptSecret?: string | undefined;
  /** What the Registry refuses a text holding `keptSecret` with: `HOLDS_KEPT_SECRET` unless a test names another. */
  readonly refusal?: string | undefined;
  /**
   * Runs after a write recorded its change, before its answer: a test whose answer is lost (a cut RPC) makes it a
   * defect.
   */
  readonly afterWrite?: (() => Effect.Effect<void>) | undefined;
};

/** The Registry's refusal of a write whose text holds a kept Secret, as `via-secrets.ts` words it. */
export const HOLDS_KEPT_SECRET =
  "Nothing was saved: a text of the change holds a kept Secret's value.";

/**
 * The stand-in Registry with the writes the change tools make: it records each change with its author, claims its
 * `request_id` in the same step (a claim another attempt or other arguments hold is a defect, as the Registry's
 * `ChangeRequestConflict` is over RPC, and records nothing), looks claims up and settles them, and notes each call.
 */
export const changingRegistry = (
  calls: RegistryCalls = [],
  {
    features,
    beforeSettle,
    keptSecret,
    refusal = HOLDS_KEPT_SECRET,
    afterWrite,
  }: ChangeOptions = {},
): ChangingRegistry => {
  const ledger: ChangeLedger = {
    changes: [],
    claims: new Map(),
    values: new Map(),
    marks: new Map([["default:API_KEY", true]]),
  };

  const noted = <A>(method: string, run: () => A): Effect.Effect<A> =>
    Effect.sync(() => {
      calls.push(method);

      return run();
    });

  /** A write, noted, then `afterWrite` once it recorded a change. */
  const written = <A extends { readonly status: string }>(method: string, run: () => A) =>
    Effect.tap(noted(method, run), (answer) =>
      answer.status === "changed" && afterWrite !== undefined ? afterWrite() : Effect.void,
    );

  const holdsKept = (value: Schema.Json | null): boolean =>
    keptSecret !== undefined && JSON.stringify(value).includes(keptSecret);

  /** Record `field` of `scope` going from `before` to `after`, claiming the author's `request_id` with it. */
  const record = (
    scope: string,
    field: string,
    before: Schema.Json | null,
    after: Schema.Json | null,
    author: AgentChangeAuthor,
  ): AgentChange => {
    const id = ledger.changes.length + 1;
    const claim = "request" in author ? author.request : undefined;

    if (claim !== undefined) {
      const held = ledger.claims.get(claim.id);

      if (held === undefined) {
        ledger.claims.set(claim.id, { ...claim, answer: null, changes: [id] });
      } else if (held.attempt !== claim.attempt || held.digest !== claim.digest) {
        throw new Error(`ChangeRequestConflict: ${claim.id}`);
      } else {
        held.changes.push(id);
      }
    }

    const change: AgentChange = {
      id,
      scope,
      at: 1_000,
      actor: "agent",
      session: null,
      conversation: null,
      tool: author.tool,
      reason: author.reason,
      field,
      before,
      after,
      reverts: null,
      revertedBy: null,
    };

    ledger.changes.push({ change, author });

    return change;
  };

  const settingChange = (
    scope: string,
    { field, value }: { readonly field: string; readonly value: Schema.Json | null },
    author: AgentChangeAuthor,
  ) => {
    if (holdsKept(value) || holdsKept(author.reason)) {
      return { status: "rejected" as const, message: refusal };
    }

    const key = `${scope}:${field}`;
    const before = ledger.values.get(key) ?? null;

    if (JSON.stringify(before) === JSON.stringify(value))
      return { status: "unchanged" as const, value };

    ledger.values.set(key, value);

    return { status: "changed" as const, change: record(scope, field, before, value, author) };
  };

  const scopeName = (scope: string) => (scope === "*" ? "Global" : DEFAULT.name);

  // The change tools ask these methods besides the reads; each answers as the real Registry's would for the one
  // Environment.
  const registry: HarnessRegistry = {
    ...harnessRegistry(calls),
    agentChangeFeatures: () =>
      Effect.andThen(
        noted("agentChangeFeatures", () => undefined),
        features ?? Effect.succeed({ via: true }),
      ),
    changeEnvironment: ({
      environment,
      change,
      author,
    }: {
      readonly environment: string;
      readonly change: { readonly field: string; readonly value: Schema.Json | null };
      readonly author: AgentChangeAuthor;
    }) =>
      written("changeEnvironment", () => {
        if (environment !== DEFAULT.id) return { status: "missing" };

        const applied = settingChange(environment, change, author);

        if (applied.status === "unchanged") {
          return { status: "unchanged", environment: DEFAULT, value: applied.value };
        }

        if (applied.status === "rejected") return applied;

        return {
          status: "changed",
          environment: DEFAULT,
          change: applied.change,
          state: { settings: ENVIRONMENT_CONTAINER, global: GLOBAL_CONTAINER, overrides: {} },
          newBuild: true,
        };
      }),
    changeGlobal: ({
      change,
      author,
    }: {
      readonly change: { readonly field: string; readonly value: Schema.Json | null };
      readonly author: AgentChangeAuthor;
    }) =>
      written("changeGlobal", () => {
        const applied = settingChange("*", change, author);

        return applied.status === "changed"
          ? {
              status: "changed",
              change: applied.change,
              settings: GLOBAL_CONTAINER,
              overriddenIn: [],
              newBuilds: [{ id: DEFAULT.id, name: DEFAULT.name }],
              own: undefined,
            }
          : applied;
      }),
    agentMarkSecretBuild: ({
      environment,
      name,
      build,
      author,
    }: {
      readonly environment: string;
      readonly name: string;
      readonly build: boolean;
      readonly author: AgentChangeAuthor;
    }) =>
      written("agentMarkSecretBuild", () => {
        const scope = { id: environment, name: scopeName(environment) };
        const key = `${environment}:${name}`;
        const before = ledger.marks.get(key);

        if (holdsKept(author.reason)) return { status: "rejected", message: refusal };

        if (environment !== DEFAULT.id && environment !== "*") return { status: "missing" };

        if (before === undefined) return { status: "absent", environment: scope };

        if (before === build) return { status: "unchanged", environment: scope, build };

        ledger.marks.set(key, build);

        return {
          status: "changed",
          environment: scope,
          change: record(environment, `secrets.${name}.build`, before, build, author),
        };
      }),
    changeSettings: ({
      environment,
      changes,
      author,
    }: {
      readonly environment?: string | undefined;
      readonly changes: ReadonlyArray<{
        readonly field: string;
        readonly value: Schema.Json | null;
      }>;
      readonly author: AgentChangeAuthor;
    }) =>
      written("changeSettings", () => {
        if (environment !== undefined && environment !== DEFAULT.id) return { status: "missing" };

        const scope = environment ?? SETTINGS_SCOPE;
        const made: Array<AgentChange> = [];

        for (const change of changes) {
          const applied = settingChange(scope, change, author);

          if (applied.status === "rejected") return applied;

          if (applied.status === "changed") made.push(applied.change);
        }

        return made.length === 0
          ? { status: "unchanged" }
          : {
              status: "changed",
              changes: made,
              // The tools read the changes only; the state is the Registry's own record of the Settings after.
              state: { settings: DEFAULT_SETTINGS, overrides: {}, overriddenIn: {} },
            };
      }),
    // A server's change reaches Environment `default` alone, and widens nothing.
    mcpChangeCheck: () =>
      noted("mcpChangeCheck", () => ({
        environments: [
          {
            environment: { id: DEFAULT.id, name: DEFAULT.name },
            reads: [],
            reached: true,
            widening: [],
          },
        ],
      })),
    mcpPending: () =>
      noted("mcpPending", () => ({
        pushes: [
          {
            environment: DEFAULT.id,
            set: { kind: "set" as const, hash: "hash-1", revision: 1, entries: [] },
          },
        ],
        wipes: [],
      })),
    mcpPushed: () => noted("mcpPushed", () => undefined),
    changeRequest: ({ id }: { readonly id: string }) =>
      noted("changeRequest", () => {
        const held = ledger.claims.get(id);

        if (held === undefined) return null;

        return {
          tool: held.tool,
          digest: held.digest,
          attempt: held.attempt,
          at: 1_000,
          answer: held.answer,
          changes: held.changes.flatMap((number) => {
            const found = ledger.changes.find(({ change }) => change.id === number);

            return found === undefined
              ? []
              : [
                  {
                    id: found.change.id,
                    scope: found.change.scope,
                    scopeName: scopeName(found.change.scope),
                    field: found.change.field,
                    before: found.change.before,
                    after: found.change.after,
                  },
                ];
          }),
        };
      }),
    settleChangeRequest: ({
      id,
      attempt,
      answer,
    }: {
      readonly id: string;
      readonly attempt: string;
      readonly answer: ChangeAnswer;
    }) =>
      Effect.andThen(
        beforeSettle?.(answer) ?? Effect.void,
        noted("settleChangeRequest", () => {
          const held = ledger.claims.get(id);

          if (held === undefined || held.attempt !== attempt) return false;

          held.answer ??= answer;

          return true;
        }),
      ),
    notifyMcpChanges: () => noted("notifyMcpChanges", () => null),
  };

  return { registry, ledger };
};

/** What the upkeep stand-ins were asked, in order: `builds.of:default`, `spares.all`, `mcp.sync:default`. */
export type UpkeepCalls = Array<string>;

/**
 * The upkeep and the background of `HarnessDeps`, noted: `background` keeps each effect for the test to run with
 * `runBackground`, as `waitUntil` runs it after the answer.
 */
export const harnessUpkeep = (calls: UpkeepCalls = []) => {
  const pending: Array<Effect.Effect<void>> = [];
  const credentials: ReadonlyArray<string> = [];

  const noted = (step: string) => Effect.sync(() => void calls.push(step));

  const deps = {
    builds: {
      of: (environment: string) => noted(`builds.of:${environment}`),
      rebuild: () => Effect.succeed("asked" as const),
    },
    spares: {
      of: (environment: string) => noted(`spares.of:${environment}`),
      all: noted("spares.all"),
    },
    mcp: { sync: (environment?: string) => noted(`mcp.sync:${environment ?? "all"}`) },
    background: (effect: Effect.Effect<void>) => Effect.sync(() => void pending.push(effect)),
    credentials,
  } satisfies Omit<HarnessDeps, "registry" | "mcpHosts" | "appOrigin">;

  /** Run what was handed to `background`, and what that hands on, until none is left. */
  const runBackground = Effect.suspend(function drain(): Effect.Effect<void> {
    const next = pending.shift();

    return next === undefined ? Effect.void : Effect.andThen(next, Effect.suspend(drain));
  });

  return { deps, calls, pending, runBackground };
};

/** What the McpHost stand-in was asked: the Environment's host by its object name, and the method. */
export type HostCalls = Array<{ readonly host: string; readonly method: string }>;

/**
 * The McpHost namespace's stand-in: each Environment's host answers `servers` with `docs` and one tool, takes any set it is
 * handed, and notes the call.
 */
export const harnessHosts = (calls: HostCalls = []): HarnessDeps["mcpHosts"] => ({
  getByName: (host: string) =>
    // SAFETY: the reads ask a host for `servers` only; the answer is what a host holding one connected server gives.
    ({
      apply: () =>
        Effect.sync(() => {
          calls.push({ host, method: "apply" });

          return McpApplied.make({ hash: "hash-1", changed: true });
        }),
      servers: () =>
        Effect.sync(() => {
          calls.push({ host, method: "servers" });

          return {
            version: "v1",
            promptsVersion: "p1",
            servers: [
              {
                name: "docs",
                source: { kind: "environment" },
                server: { type: "http", url: "https://docs.example.test/mcp" },
                conn: "conn-docs",
                state: "connected",
                toolsHash: "t1",
                promptsHash: "p1",
                counts: { tools: 1, prompts: 0 },
                resources: false,
                problems: [],
                tools: [{ name: "search", description: "Search the docs.", inputSchema: {} }],
              },
            ],
          };
        }),
    }) as never,
});
