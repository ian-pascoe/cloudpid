// The core of `settings_get` (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions
// and the core/wrapper split, Reading a whole field, and the endpoint's limits): it reads the Settings of one Scope through
// plain services and answers its text, its structured value and its details, for the Session (`surface: "session"`, byte for
// byte what the in-session tool answered before the split) or the endpoint (`surface: "endpoint"`: no Environment is
// marked a Session's own, the value is cut to `ENDPOINT_SETTINGS_BOUNDS`, its text is built from that value and cut to
// `ENDPOINT_TEXT_CHARS`, and `field: "instructions"` reads the Scope's own Instructions whole, a page at a time). The
// in-session wrapper is in `./settings.ts`; the services are the Registry's, which `apps/server` builds with no Session
// (`settingsReads`).
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- text built from plain values.
import {
  GLOBAL_SETTINGS_SCOPE,
  type HARNESS_TOOLS,
  SettingsGetEndpointOutput,
  SettingsGetOutput,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  cutNote,
  cutText,
  fitted,
  type HarnessRead,
  INVALID_ARGUMENT,
  pageFields,
  pageOf,
  pageText,
} from "./harness.ts";
import { asOutput } from "./outputs.ts";
import {
  describeSettings,
  isGlobalView,
  SettingsAccessError,
  settingsOutput,
  type SettingsView,
} from "./settings-describe.ts";
import type { SettingsAccessService } from "./settings.ts";
import { ENDPOINT_SETTINGS_BOUNDS } from "./settings-outputs.ts";

/** What the core reads: the Registry's Settings, and the Session's own Environment among them. */
export type SettingsReadServices = Pick<SettingsAccessService, "get" | "own">;

type GetArgs = typeof HARNESS_TOOLS.settings_get.endpoint.input.Type;

/** What the endpoint's cut text ends with. */
const CUT_NOTE = cutNote('pass `field: "instructions"` to read the Instructions whole.');

type Whole = Required<
  Omit<
    typeof SettingsGetEndpointOutput.Type,
    "id" | "field" | "text" | "offset" | "total_chars" | "next_offset"
  >
>;

/** A value as the settings list shows it. */
const valueWords = (value: Schema.Json | null): string => JSON.stringify(value);

/** What `settings_get` says on the endpoint, from its value. */
const describeEndpointSettings = (out: Whole): string => {
  const atGlobal = out.scope.id === GLOBAL_SETTINGS_SCOPE;

  const lines = Arr.map(out.settings, (setting) => {
    const value = setting.value_truncated ? "too long to show" : valueWords(setting.value);

    const global =
      setting.global_value === null || setting.value_truncated
        ? ""
        : `; Global: ${valueWords(setting.global_value)}`;

    const overriding =
      setting.overridden_in.length === 0
        ? ""
        : `; overridden in ${Arr.join(
            Arr.map(setting.overridden_in, (each) => `${JSON.stringify(each.name)} (${each.id})`),
            ", ",
          )}${setting.overridden_in_truncated ? ", and more" : ""}`;

    return `  ${setting.field}: ${value} (${setting.source}${global}${overriding})`;
  });

  const size = (instructions: { readonly bytes: number }, where: string) =>
    instructions.bytes === 0 ? `none (${where})` : `${instructions.bytes} bytes (${where})`;

  return Arr.join(
    [
      atGlobal
        ? `Global Settings (scope "${GLOBAL_SETTINGS_SCOPE}"): what each Environment inherits, field by field, unless it overrides the field. Each value says where it comes from: "default" (nobody sets it) or "global" (set at Global), and names the Environments that override it.`
        : `Settings of Environment ${JSON.stringify(out.scope.name)} (id ${out.scope.id}): its Overrides over Global over the defaults. Each value is "override" (set on purpose for this Environment, kept even when equal to Global's, shown with the Global value it replaces) or "inherited" (from Global).`,
      "Settings:",
      ...lines,
      ...(out.settings_truncated ? ["(more settings exist than are listed)"] : []),
      out.mcp_servers === null
        ? "MCP servers: the count is unavailable now; settings_mcp_list shows them"
        : `MCP servers: ${out.mcp_servers} at this Scope; settings_mcp_list shows them`,
      atGlobal
        ? `Instructions (every conversation is shown them first): ${size(out.instructions.global, "Global's")}. Pass field "instructions" to read them whole.`
        : `Instructions (they add up, never overridden: Global's, then this Environment's own): Global's ${size(out.instructions.global, 'scope "*"')}; this Environment's own ${out.instructions.environment === null ? "none" : size(out.instructions.environment, `scope ${JSON.stringify(out.scope.id)}`)}. Pass field "instructions" to read the Scope's own whole.`,
      ...(out.problem === null
        ? []
        : [`Saved overrides left out, as they no longer apply: ${out.problem}`]),
    ],
    "\n",
  );
};

/** The Scope's own Instructions: Global's, or an Environment's own. */
const ownInstructions = (view: SettingsView): string =>
  isGlobalView(view) ? view.settings.instructions : view.instructions;

/**
 * `settings_get`: the Settings in force at a Scope, each with where its value comes from. On the endpoint, `field:
 * "instructions"` reads the Scope's own Instructions whole, a page at a time (`offset`), and the value is cut to the
 * endpoint's bounds.
 */
export const settingsGetRead =
  (services: SettingsReadServices): HarnessRead<GetArgs, SettingsAccessError> =>
  (args, surface) =>
    Effect.gen(function* () {
      const view = yield* services.get(args.scope);

      if (surface === "session") {
        const own = yield* services.own;

        return {
          text: describeSettings(view, own),
          structured: asOutput(SettingsGetOutput, settingsOutput(view, own)),
          details: { scope: view.scope, problem: view.problem ?? null },
        };
      }

      if (args.field === undefined) {
        if (args.offset !== undefined) {
          return yield* SettingsAccessError.make({
            message: "offset reads a page of a field: pass field with it.",
            code: INVALID_ARGUMENT,
          });
        }

        const base = settingsOutput(view, null, ENDPOINT_SETTINGS_BOUNDS);

        const whole: Whole = {
          ...Struct.omit(base, ["own_environment", "is_own"]),
        };

        // Instructions that would still not fit lose their text first, flagged.
        const out = fitted(whole, [
          (value) => ({
            ...value,
            instructions: {
              global: { ...value.instructions.global, text: "", text_truncated: true },
              environment:
                value.instructions.environment === null
                  ? null
                  : { ...value.instructions.environment, text: "", text_truncated: true },
            },
          }),
        ]);

        return {
          text: cutText(describeEndpointSettings(out), CUT_NOTE),
          structured: asOutput(SettingsGetEndpointOutput, out),
          details: { scope: view.scope, problem: view.problem ?? null },
        };
      }

      const text = ownInstructions(view);
      const page = pageOf(text, args.offset ?? 0);

      if (page === undefined) {
        return yield* SettingsAccessError.make({
          message: `offset ${args.offset} is past the end of the Instructions, which are ${text.length} characters.`,
          code: INVALID_ARGUMENT,
        });
      }

      return {
        text: pageText(page),
        structured: asOutput(SettingsGetEndpointOutput, pageFields(view.scope, args.field, page)),
        details: { scope: view.scope, field: args.field },
      };
    });
