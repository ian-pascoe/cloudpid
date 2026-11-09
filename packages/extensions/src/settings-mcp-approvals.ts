// The cores of the MCP servers' tools whose change waits for the owner's Approval on the endpoint
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Approvals with no Session, Built so far: S3b-2;
// `docs/architecture/mcp-configuration.md` → The agent's changes → Approval). `settings_mcp_add`, `_update` and `_enable` always
// ask: a definition decides what code runs and where Secrets go, and switching on makes tools reachable. `settings_mcp_exposure_set`,
// `_tool_exposure_set`, `_remove` and `settings_reset` of an adjustment's key ask only when the change widens what is reachable
// (`checkMcpWidening`, the Registry's `mcpChangeCheck`); one that narrows is made at once by the core of `./settings-mcp-cores.ts`,
// which the dispatcher runs when `prepare` answers `immediate`.
//
// Each is the three steps of `./approval-cores.ts` over the shared ending of the changing tools (`./settings-mcp-commit.ts`):
// - `prepare` runs the tool's own preparation (`McpPlan`, the one the Session's tool runs), so it refuses what the tool would
//   refuse, and answers the card and `expected` (`{ value, inherited?, after }`), or what a change finds already made;
// - `apply` writes exactly `expected`'s `after`, only while the Scope still has the `value` the owner saw, under the Registry's
//   guard (the name, and the `${NAME}` an Environment's entry reads, checked again in the transaction that writes);
// - `render` is the words, the value for programs and the details, with the push of the new set to each host the change
//   reaches left to the main Worker's `mcp.sync` (`sync`) and the server's status `not_checked`: no host is asked.
// `apply` needs no host and `render` asks none, so the Registry-held Approvals run it from the main Worker alone.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off
import { type McpExposure, mcpKeyField, parseMcpField, settingsFieldValue } from "@cloudpid/config";
import type { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import type { Applied, ApprovalCore, Prepared } from "./approval-cores.ts";
import { declinedAnswer } from "./approvals.ts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { mcpChanges } from "./settings-mcp-changes.ts";
import {
  asksFor,
  cardOf,
  expectedOf,
  type McpAsked,
  mcpCommit,
  type McpPlan,
  pretty,
} from "./settings-mcp-commit.ts";
import type { McpResetArgs } from "./settings-mcp-cores.ts";
import { mcpDefinitions } from "./settings-mcp-definitions.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import {
  type AppliedSettingsChange,
  NOT_PICKED,
  settingsAnswer,
  SettingsAccessError,
  type SettingsAccessService,
  settingsChanges,
  settingsTarget,
} from "./settings.ts";

export type { McpAsked } from "./settings-mcp-commit.ts";

export type { McpResetArgs } from "./settings-mcp-cores.ts";

/** What the cores run over: the Registry's MCP read and checks, the Settings, and the check of a text. */
export type McpApprovalServices = {
  readonly access: SettingsMcpAccessService;
  readonly settings: Pick<SettingsAccessService, "get" | "change">;
  /** Whether `value` holds a deploy-time credential (the Registry checks the kept Secrets in the write itself). */
  readonly holdsSecret: (value: string) => Effect.Effect<boolean>;
  /** The main Worker's push of an Environment's new set to its host (`mcp.sync`), told of each Environment a change reaches. */
  readonly sync?: ((environment: string) => Effect.Effect<void>) | undefined;
};

/** What a core that asks has of the call: its Scope and why. */
type ScopedArgs = { readonly scope: string; readonly reason: string };

/** The arguments of tool `Name` as the endpoint decodes them. */
type EndpointArgs<Name extends keyof typeof HARNESS_TOOLS> = (typeof HARNESS_TOOLS)[Name] extends {
  readonly endpoint: { readonly input: infer I };
}
  ? I extends Schema.Top
    ? I["Type"]
    : never
  : never;

/** A core of an MCP server's tool that asks: its `Known` is what the shared ending read, and its failures are the tools'. */
export type McpAskCore<Args> = ApprovalCore<
  Args,
  McpAsked,
  AppliedSettingsChange,
  SettingsAccessError
> & {
  /** What `render` is given of a write recorded under a claim, whose run was cut before it answered. */
  readonly knownFromClaim: (
    args: Args,
    expected: Schema.Json | null,
  ) => Effect.Effect<McpAsked, SettingsAccessError>;
};

/** What a tool's preparation answers when it finds nothing to do: the Session's tool result, which `settingsAnswer` words. */
type Done = Parameters<typeof settingsAnswer>[1];

/** The server and field a call changes, from its arguments alone (no state read): what `apply` needs of a request. */
type Target = { readonly name: string; readonly field: string; readonly status: boolean };

/**
 * The core of the tool `tool`: `plan` is the tool's own call (`McpPlan`), `target` what it changes, read from its arguments.
 */
const mcpCore = <Args extends ScopedArgs>(
  engine: ReturnType<typeof mcpCommit>,
  spec: {
    readonly tool: string;
    readonly target: (args: Args) => Effect.Effect<Target, SettingsAccessError>;
    readonly plan: (args: Args) => Effect.Effect<McpPlan<Done>, SettingsAccessError>;
  },
): McpAskCore<Args> => {
  const { tool } = spec;

  /** The input of a call that reads no state but the Scope's view: what an approved change is applied and worded from. */
  const resume = (args: Args) =>
    Effect.gen(function* () {
      const target = yield* spec.target(args);

      return yield* engine.resumeOf({
        tool,
        api: undefined,
        scope: args.scope,
        name: target.name,
        field: target.field,
        reason: args.reason,
        texts: [],
        status: target.status,
      });
    });

  return {
    tool,
    prepare: (args) =>
      Effect.gen(function* () {
        const plan = yield* spec.plan(args);
        const prepared = yield* plan.prepare(false);

        if (prepared.kind === "commit") {
          const { input } = prepared;
          const expected = expectedOf(input);

          return {
            card: cardOf(input, expected),
            expected,
            known: { input, checked: input.check ?? { environments: [] }, field: input.field },
            immediate: !asksFor(input),
          } satisfies Prepared<McpAsked>;
        }

        // The change finds nothing to do: the answer is the tool's, and nothing is asked unless a rerun did before.
        const input = yield* resume(args);
        const stored = settingsFieldValue(input.view.settings, plan.field);

        return {
          card: {
            tool,
            target: settingsTarget(input.view),
            change: tool,
            before: pretty(stored),
            after: pretty(stored),
            reason: args.reason,
          },
          expected: { value: stored, after: stored },
          known: {
            input,
            checked: { environments: [] },
            field: { field: plan.field, value: stored },
          },
          unchanged: settingsAnswer("endpoint", prepared.result, []),
        } satisfies Prepared<McpAsked>;
      }),

    apply: (args, expected, author, known) =>
      Effect.gen(function* () {
        const input = known?.input ?? (yield* resume(args));
        const applied = yield* engine.applyAsked(input, expected, author);

        return { known: applied.known, result: applied.result } satisfies Applied<
          McpAsked,
          AppliedSettingsChange
        >;
      }),

    render: (_args, _expected, applied) => engine.renderAsked(applied),

    declined: (_args, { input }, answer) =>
      declinedAnswer(answer, input.declined, (approval) =>
        settingsChangeOutput({ view: input.view, changes: [], unchanged: [], approval }),
      ),

    knownFromClaim: (args, expected) =>
      Effect.flatMap(resume(args), (input) => engine.askedOf(input, expected, true)),
  };
};

/** The target of a tool that changes `name`'s whole entry. */
const entryTarget = (name: string, status: boolean) =>
  Effect.succeed({ name, field: `mcp.servers.${name}`, status } satisfies Target);

/** The target of a tool that changes one key of `name`. */
const keyTarget = (name: string, key: "enabled" | "exposure" | "toolExposure", status: boolean) =>
  Effect.succeed({ name, field: mcpKeyField(name, key), status } satisfies Target);

/** `make`, run the first time it is asked for, and then its result. */
const once = <A>(make: () => A): (() => A) => {
  let held: { readonly core: A } | undefined;

  return () => {
    held ??= { core: make() };

    return held.core;
  };
};

/**
 * The cores of the MCP servers' tools that ask, over `services`, each a thunk: the shared ending, the Settings' machinery and
 * the plans are built once, and a core is made the first time it is asked for and kept (a call uses one of them).
 */
export const mcpApprovalCores = (services: McpApprovalServices) => {
  const changes = settingsChanges({
    surface: "endpoint",
    // Nothing is a Session's own here.
    access: { ...services.settings, own: Effect.succeed(null) },
    // The endpoint has no Session to read the Settings again, and records through the Registry's own claim.
    reload: Effect.succeed(NOT_PICKED),
    log: { record: () => Effect.void },
    holdsSecret: services.holdsSecret,
  });

  const engine = mcpCommit({
    surface: "endpoint",
    access: services.access,
    settings: services.settings,
    changes,
    approvals: undefined,
    sync: services.sync,
  });

  const { plans: keyPlans } = mcpChanges(engine);
  const { plans: definitionPlans } = mcpDefinitions(engine);

  return {
    settings_mcp_add: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_add">>(engine, {
        tool: "settings_mcp_add",
        target: ({ name }) => entryTarget(name, true),
        plan: ({ scope, name, entry, from_repo, reason }) =>
          definitionPlans.addPlan({ scope, name, entry, from_repo, reason, api: undefined }),
      }),
    ),

    settings_mcp_update: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_update">>(engine, {
        tool: "settings_mcp_update",
        target: ({ name }) => entryTarget(name, true),
        plan: ({ scope, name, set, reason }) =>
          definitionPlans.updatePlan({ scope, name, set, reason, api: undefined }),
      }),
    ),

    settings_mcp_enable: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_enable">>(engine, {
        tool: "settings_mcp_enable",
        target: ({ name }) => keyTarget(name, "enabled", true),
        plan: ({ scope, name, reason }) =>
          keyPlans.enablePlan({ scope, name, reason, api: undefined }),
      }),
    ),

    settings_mcp_exposure_set: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_exposure_set">>(engine, {
        tool: "settings_mcp_exposure_set",
        target: ({ name }) => keyTarget(name, "exposure", false),
        plan: ({ scope, name, exposure, reason }) =>
          keyPlans.exposureSetPlan({
            scope,
            name,
            exposure: exposure satisfies McpExposure,
            reason,
            api: undefined,
          }),
      }),
    ),

    settings_mcp_tool_exposure_set: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_tool_exposure_set">>(engine, {
        tool: "settings_mcp_tool_exposure_set",
        target: ({ name }) => keyTarget(name, "toolExposure", false),
        plan: ({ scope, name, tool, exposure, before, reason }) =>
          keyPlans.toolExposureSetPlan({
            scope,
            name,
            tool,
            exposure,
            before,
            reason,
            api: undefined,
          }),
      }),
    ),

    settings_mcp_remove: once(() =>
      mcpCore<EndpointArgs<"settings_mcp_remove">>(engine, {
        tool: "settings_mcp_remove",
        target: ({ name }) => entryTarget(name, false),
        plan: ({ scope, name, reason }) =>
          definitionPlans.removePlan({ scope, name, reason, api: undefined }),
      }),
    ),

    /** `settings_reset` of an adjustment's key (`mcp.servers.<name>.<key>`). */
    settings_reset: once(() =>
      mcpCore<McpResetArgs>(engine, {
        tool: "settings_reset",
        target: ({ field }) => {
          const parsed = parseMcpField(field);

          return parsed === null
            ? Effect.fail(
                SettingsAccessError.make({
                  message: `${field} is no field of an MCP server: nothing was changed.`,
                  code: "invalid_argument",
                }),
              )
            : Effect.succeed({ name: parsed.name, field, status: false } satisfies Target);
        },
        plan: ({ scope, field, reason }) =>
          keyPlans.resetFieldPlan({ scope, field, reason, api: undefined }),
      }),
    ),
  };
};

/** The cores, each made when first asked for and kept: `mcpApprovalCores(services).settings_mcp_add()`. */
export type McpApprovalCoreOf = ReturnType<typeof mcpApprovalCores>;

/** The cores themselves, as a test holds them. */
export type McpApprovalCores = {
  readonly [Name in keyof McpApprovalCoreOf]: ReturnType<McpApprovalCoreOf[Name]>;
};
