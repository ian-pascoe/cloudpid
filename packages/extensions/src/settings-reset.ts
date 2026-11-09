// `settings_reset` of a field no Approval is asked for (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Approvals with no Session, The tools; `docs/architecture/agent-changes.md`): at Global the field goes back to its default,
// at an Environment its Override is removed, so it inherits Global again. The Session's tool (`./approval-tools.ts`) asks the
// owner for a Limit and for a reset that makes an MCP server reachable again, and makes every other reset with `resetPlain`.
// The endpoint's core (`settingsResetCore`, which the Session does not run) answers a Limit, the Instructions and a widening
// reset as `unsupported`, with nothing asked, changed or recorded (those wait for the owner's Approval, which the endpoint
// has no card for), and makes the rest with `resetPlain` in the endpoint's words.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { isMcpField, overrideFieldPath } from "@cloudpid/config";
import {
  RESET_FIELDS_ENDPOINT,
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
 * The endpoint's `settings_reset`: a Limit, the Instructions and a reset that would widen an MCP server's reach are
 * `unsupported` with nothing changed; any other field is reset at once. (The Session's tool asks the owner instead, and
 * shares `resetPlain` and the MCP key core.)
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
            "Nothing was changed: settings_reset does not take the Instructions, which steer every conversation and wait for the owner's Approval; the owner changes them on the Settings page.",
          code: "unsupported",
        });
      }

      if (overrideFieldPath(field) === undefined) {
        return yield* SettingsAccessError.make({
          message: `Nothing was saved: ${field} is not a setting settings_reset takes. The settings are: ${RESET_FIELDS_ENDPOINT}.`,
          code: "invalid_argument",
        });
      }

      if (isMcpField(field)) {
        return yield* services.mcp.resetField({ scope, field, reason }, surface, conversation);
      }

      if (Option.isSome(limitOfField(field))) {
        return yield* SettingsAccessError.make({
          message: `Nothing was changed: ${field} is a Limit (${Arr.join(SETTINGS_LIMIT_FIELDS, ", ")}), whose change waits for the owner's Approval, which is not asked here; the owner changes it on the Settings page.`,
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
