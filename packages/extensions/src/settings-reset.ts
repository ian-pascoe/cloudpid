// `settings_reset` of a field no Approval is asked for (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Approvals with no Session, The tools; `docs/architecture/agent-changes.md`): at Global the field goes back to its default,
// at an Environment its Override is removed, so it inherits Global again. The Session's tool (`./approval-tools.ts`) asks the
// owner for a Limit and for a reset that makes an MCP server reachable again, and makes every other reset with `resetPlain`.
// The endpoint's core (`settingsResetCore`, which the Session does not run) refuses the Instructions as the Session's tool
// does (`settings_instructions_set` clears them), answers a widening reset as `unsupported`, and makes the rest with
// `resetPlain` in the endpoint's words. A Limit's reset is asked for before it (the main Worker's dispatcher hands it to
// the endpoint's Approvals, `apps/server/src/harness/approval-ask.ts`), so the core refuses one it is given, changing
// nothing.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { isMcpField, overrideFieldPath } from "@cloudpid/config";
import {
  RESET_FIELDS,
  SETTINGS_LIMIT_FIELDS,
  type HARNESS_TOOLS,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { INSTRUCTIONS_FIELD, limitOfField, resetAlready, resetIsDone } from "./approval-cores.ts";
import type { HarnessWrite } from "./harness.ts";
import type { McpChangeCores } from "./settings-mcp-cores.ts";
import {
  changedLines,
  fieldLabel,
  isGlobalView,
  recordedFor,
  scopeWhere,
  SettingsAccessError,
  type SettingsChangeCoreServices,
  type settingsChanges,
  settingsWritten,
} from "./settings.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import * as Option from "effect/Option";

type ResetArgs = (typeof HARNESS_TOOLS.settings_reset.session.input)["Type"];

/**
 * Reset `field` at `scope` where nobody is asked: nothing changes when it is at its default at Global, or not overridden at an
 * Environment; otherwise it is reset through `engine`, which records it and tells of it.
 */
export const resetPlain = (
  engine: Pick<ReturnType<typeof settingsChanges>, "apply">,
  input: {
    readonly surface: Surface;
    readonly view: Parameters<typeof resetIsDone>[0];
    readonly field: string;
    readonly reason: string;
    readonly conversation: number | undefined;
  },
) => {
  const { surface, view, field } = input;
  const global = isGlobalView(view);
  const label = fieldLabel(field);
  const already = resetAlready(view, field);

  if (resetIsDone(view, field)) {
    return Effect.succeed({
      output: [{ type: "text" as const, text: already }],
      structuredOutput: settingsChangeOutput({
        view,
        changes: [],
        unchanged: [field],
        approval: null,
        surface,
      }),
      details: { scope: view.scope, unchanged: [field], agentChanges: [] },
    });
  }

  return engine.apply({
    tool: "settings_reset",
    view,
    fields: [{ field, value: null, reset: true }],
    reason: input.reason,
    conversation: input.conversation,
    unchanged: already,
    changed: ({ changes, reach: reached }) =>
      `Reset the ${label} ${scopeWhere(view)}${global ? " to its default" : ": it inherits Global again"}:\n${changedLines(changes)}\n${reached.text} ${recordedFor(surface)}`,
  });
};

/** What the endpoint's `settings_reset` runs over: the Settings' services and the cores of the MCP servers' keys. */
export type SettingsResetServices = SettingsChangeCoreServices & {
  readonly mcp: Pick<McpChangeCores, "resetField">;
};

/**
 * The endpoint's `settings_reset` of a field no Approval is asked for: the Instructions are refused (their own tool clears
 * them), a Limit and a reset that would widen an MCP server's reach are `unsupported` with nothing changed (a Limit's is
 * asked for before this core runs); any other field is reset at once. (The Session's tool shares `resetPlain` and the MCP
 * key core.)
 */
export const settingsResetCore = (
  services: SettingsResetServices,
): HarnessWrite<ResetArgs, SettingsAccessError> => {
  const written = settingsWritten(services);

  return ({ scope, field, reason }, surface, conversation) =>
    Effect.gen(function* () {
      if (field === INSTRUCTIONS_FIELD) {
        return yield* SettingsAccessError.make({
          message:
            "Nothing was asked or saved: settings_reset does not take the Instructions. settings_instructions_set with an empty text clears them, once the owner approves.",
          code: "invalid_argument",
        });
      }

      if (overrideFieldPath(field) === undefined) {
        return yield* SettingsAccessError.make({
          message: `Nothing was saved: ${field} is not a setting settings_reset takes. The settings are: ${RESET_FIELDS}.`,
          code: "invalid_argument",
        });
      }

      if (isMcpField(field)) {
        return yield* services.mcp.resetField({ scope, field, reason }, surface, conversation);
      }

      if (Option.isSome(limitOfField(field))) {
        return yield* SettingsAccessError.make({
          message: `Nothing was changed: ${field} is a Limit (${Arr.join(SETTINGS_LIMIT_FIELDS, ", ")}), whose reset waits for the owner's Approval and is not made here.`,
          code: "unsupported",
        });
      }

      return yield* written(surface, (engine) =>
        Effect.gen(function* () {
          yield* engine.plain(reason, []);

          const view = yield* services.access.get(scope);

          return yield* resetPlain(engine, { surface, view, field, reason, conversation });
        }),
      );
    });
};
