// The cores of `settings_mcp_list` and `settings_mcp_get` (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Shared definitions and the core/wrapper split, Reading a whole field, and the endpoint's limits): each reads the
// MCP servers of one Scope through plain services (the Registry's MCP read, and the host of an Environment, whose held
// inventory is all it asks for) and answers its text, its structured value and its details, for the Session (`surface:
// "session"`, byte for byte what the in-session tools answered before the split) or the endpoint (`surface: "endpoint"`: no
// Scope is marked a Session's own, the value is cut to `ENDPOINT_BOUNDS` and then fitted to
// `ENDPOINT_STRUCTURED_BYTES`, and its text is built from that value and cut to `ENDPOINT_TEXT_CHARS`). The in-session
// wrappers are in `./settings-mcp.ts`; the services are the Registry's, which `apps/server` builds with no Session
// (`settingsMcpReads`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off globalDate:off -- builders over plain values.
import {
  GLOBAL_SETTINGS_SCOPE,
  type HARNESS_TOOLS,
  SettingsMcpGetEndpointOutput,
  SettingsMcpGetOutput,
  SettingsMcpListEndpointOutput,
  SettingsMcpListOutput,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";
import { cutNote, cutText, fitted, type HarnessRead, NOT_FOUND } from "./harness.ts";
import { asOutput } from "./outputs.ts";
import { SettingsAccessError } from "./settings-describe.ts";
import { readInventory, type SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { ENDPOINT_BOUNDS, getOutput, listOutput, scopeOutput } from "./settings-mcp-values.ts";
import { describeGet, describeList, scopeWords } from "./settings-mcp-words.ts";
import { storedBytes } from "./stored-bytes.ts";

/** What the cores read: the Registry's MCP read, the hosts' held inventory, and the Session's own Environment. */
export type SettingsMcpReadServices = Pick<SettingsMcpAccessService, "view" | "own" | "host">;

type ListArgs = typeof HARNESS_TOOLS.settings_mcp_list.endpoint.input.Type;

type GetArgs = typeof HARNESS_TOOLS.settings_mcp_get.endpoint.input.Type;

/** The most the entry in force, or one layer as written, weighs stored on the endpoint: more is left out. */
const MAX_WRITTEN_BYTES = 4 * 1024;

/** What the endpoint's cut text ends with. */
const CUT_NOTE = cutNote("the structured result has the rest, as far as its limit allows.");

type Layers = typeof SettingsMcpGetOutput.Type.layers;

/** `layer` as the endpoint gives it: left out (null) when it is too large. */
const writtenFits = (layer: Layers["global"]): boolean =>
  layer === null || storedBytes(layer) <= MAX_WRITTEN_BYTES;

/** `settings_mcp_list`: the MCP servers of a Scope. */
export const settingsMcpListRead =
  (access: SettingsMcpReadServices): HarnessRead<ListArgs, SettingsAccessError> =>
  (args, surface) =>
    Effect.gen(function* () {
      const view = yield* access.view({ scope: args.scope });
      const own = surface === "session" ? yield* access.own : null;
      const inventory = yield* readInventory(access, { view, parts: ["tools"] });

      if (surface === "endpoint") {
        const out: typeof SettingsMcpListEndpointOutput.Type = Struct.omit(
          listOutput(view, null, inventory, ENDPOINT_BOUNDS),
          ["is_own"],
        );

        return {
          text: cutText(describeList(out), CUT_NOTE),
          structured: asOutput(SettingsMcpListEndpointOutput, out),
          details: { scope: view.scope, servers: view.servers.length },
        };
      }

      const out = listOutput(view, own, inventory);

      return {
        text: describeList(out),
        structured: asOutput(SettingsMcpListOutput, out),
        details: { scope: view.scope, servers: view.servers.length },
      };
    });

/** `settings_mcp_get`: one MCP server of a Scope, in full. */
export const settingsMcpGetRead =
  (access: SettingsMcpReadServices): HarnessRead<GetArgs, SettingsAccessError> =>
  (args, surface) =>
    Effect.gen(function* () {
      const { scope, name } = args;
      const view = yield* access.view({ scope, name });
      const own = surface === "session" ? yield* access.own : null;
      const entry = Arr.head(view.servers);

      if (Option.isNone(entry) || view.layers === null) {
        return yield* SettingsAccessError.make({
          message: `No MCP server ${JSON.stringify(name)} in ${scopeWords(scopeOutput(view))}. ${
            view.names.length === 0 ? "It has none." : `Its servers: ${Arr.join(view.names, ", ")}.`
          }${
            view.scope === GLOBAL_SETTINGS_SCOPE
              ? " Global lists its own entries only: a Repo's server is in the set of an Environment that has the Repo (give its id)."
              : ""
          }`,
          code: NOT_FOUND,
        });
      }

      const inventory = yield* readInventory(access, {
        view,
        names: [entry.value.server.name],
        parts: ["tools", "prompts", "instructions", "status"],
      });

      const details = { scope: view.scope, server: entry.value.server.name };

      if (surface === "session") {
        const out = getOutput(view, entry.value, view.layers, own, inventory);

        return { text: describeGet(out), structured: asOutput(SettingsMcpGetOutput, out), details };
      }

      const base = getOutput(view, entry.value, view.layers, null, inventory, ENDPOINT_BOUNDS);
      const entryFits = storedBytes(base.entry) <= MAX_WRITTEN_BYTES;
      const globalFits = writtenFits(base.layers.global);
      const environmentFits = writtenFits(base.layers.environment);

      const whole: typeof SettingsMcpGetEndpointOutput.Type = {
        ...Struct.omit(base, ["is_own", "entry", "layers"]),
        entry: entryFits ? base.entry : null,
        entry_truncated: !entryFits,
        layers: {
          global: globalFits ? base.layers.global : null,
          environment: environmentFits ? base.layers.environment : null,
          repos: base.layers.repos,
          repos_truncated: base.layers.repos_truncated,
          truncated: !globalFits || !environmentFits || base.layers.repos_truncated,
        },
      };

      // What the parts' bounds still leave over the limit is dropped, the longest first, each flagged.
      const out = fitted(whole, [
        (value) => ({ ...value, tools: [], tools_truncated: true }),
        (value) => ({
          ...value,
          layers: { ...value.layers, repos: [], repos_truncated: true, truncated: true },
        }),
        (value) => ({ ...value, prompts: [], prompts_truncated: true }),
        (value) => ({
          ...value,
          unmatched_tool_exposure: [],
          unmatched_tool_exposure_truncated: true,
        }),
        (value) => ({ ...value, warnings: [], warnings_truncated: true }),
        (value) => ({ ...value, entry: null, entry_truncated: true }),
      ]);

      return {
        text: cutText(describeGet(out), CUT_NOTE),
        structured: asOutput(SettingsMcpGetEndpointOutput, out),
        details,
      };
    });
