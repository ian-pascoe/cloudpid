// The `settings_mcp` extension (`docs/architecture/mcp-configuration.md` → The agent's changes; `docs/architecture/agent-changes.md`
// → MCP server changes): the agent's tools for the MCP servers of either Scope, as deferred tools of the root conversation
// only (`settings_` is in `PARENT_ONLY_TOOL_PREFIXES`), in an extension of their own and not in `mcp`, which is rebuilt
// whenever the inventory changes. Here are its three read-only tools: `settings_mcp_list`, `settings_mcp_get` and
// `settings_mcp_reload`. The seven that change servers (`add`, `update`, `remove`, `enable`, `disable`, `exposure_set` and
// `tool_exposure_set`) join this extension, and are not built yet. The values are in `./settings-mcp-values.ts`, their
// words in `./settings-mcp-words.ts`.
//
// What the tools read has two sources, neither of which connects to a server or starts a Container. The Registry
// (`SettingsMcpAccess`) gives the configuration: the Scope's servers as the owner's set resolves them, where each key comes
// from, what each `${NAME}` reads (`secret`, `variable` or `missing`, never its value), the MCP sign-in, the problems and
// the Repos' files. The Environment's `McpHost`, through `McpHostClient.servers` with `demand: false` (no Workspace, no
// wait, and no discovery started), gives the inventory it holds: the state, the tools and the negotiated protocol version.
// The inventory is null at Global, which has no host, and for an Environment whose set has no server (no host is woken for
// it). Nothing they give holds a resolved value or a hash.
//
// A reload reads the Repos' files again, under the throttle the scheduled looks share, then pushes the set the Registry now
// computes to the Environment's host, since the Registry never calls out, and has the host drop its eras and Legacy sessions
// and rediscover its HTTP servers at once. It is no Agent change.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off globalDate:off -- builders over plain values.
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { McpApplySet, McpServersRequest, McpSetRevision } from "@cloudpid/mcp/types";
import type { SettingsMcpReload, SettingsMcpView } from "@cloudpid/protocol";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./mcp/client.ts";
import { asOutput, outputSchema } from "./outputs.ts";
import { GLOBAL_SETTINGS_SCOPE, SettingsAccessError, SettingsScope } from "./settings.ts";
import {
  getOutput,
  type Inventory,
  listOutput,
  MAX_GET_TOOLS,
  notRead,
  type ReloadHost,
  reloadOutput,
  scopeOutput,
} from "./settings-mcp-values.ts";
import {
  SettingsMcpGetOutput,
  SettingsMcpListOutput,
  SettingsMcpReloadOutput,
} from "./settings-mcp-outputs.ts";
import { describeGet, describeList, describeReload, scopeWords } from "./settings-mcp-words.ts";

export { MAX_GET_INSTRUCTIONS_BYTES, MAX_GET_TOOLS } from "./settings-mcp-values.ts";

export const extensionName = "settings_mcp";

/** The tools of the extension that are built: the read-only three. */
export const SETTINGS_MCP_READ_TOOLS = [
  "settings_mcp_list",
  "settings_mcp_get",
  "settings_mcp_reload",
] as const;

/**
 * The Registry's MCP read, the Environments' hosts and the pushes of a changed set, as the Session reaches them. `view` and
 * `reload` fail, saying so, for an id no Environment has.
 */
export type SettingsMcpAccessService = {
  /** The MCP servers of `scope` (`*`, or an Environment's id), only `name`'s when given, with its layers as written. */
  readonly view: (input: {
    readonly scope: string;
    readonly name?: string | undefined;
  }) => Effect.Effect<SettingsMcpView, SettingsAccessError>;
  /** The Session's own Environment; null when the Registry does not list it. */
  readonly own: Effect.Effect<string | null, SettingsAccessError>;
  /** Look at `environment`'s Repos' files again, under the shared throttle, and what that made of the set. */
  readonly reload: (environment: string) => Effect.Effect<SettingsMcpReload, SettingsAccessError>;
  /** The sets the Registry has yet to hand `environment`'s host (`mcpPending`'s pushes for it), each with its revision. */
  readonly pushes: (
    environment: string,
  ) => Effect.Effect<ReadonlyArray<McpApplySet>, SettingsAccessError>;
  /** Tell the Registry its host took a set (`mcpPushed`), so it is not sent again. */
  readonly pushed: (
    input: McpSetRevision & { readonly environment: string },
  ) => Effect.Effect<void, SettingsAccessError>;
  /** The `McpHost` of Environment `environment`, own or another's: a host that is not asked is not woken. */
  readonly host: (environment: string) => McpHostClientService;
};

export class SettingsMcpAccess extends Context.Service<
  SettingsMcpAccess,
  SettingsMcpAccessService
>()("@cloudpid/extensions/settings-mcp/SettingsMcpAccess") {}

/**
 * The host's inventory of `view`'s servers, with `parts`. Asked for an Environment's set that has servers, whichever
 * Environment it is, and never for one without any (a host is not woken for none). It names no Workspace, waits for
 * nothing and has the host start no discovery (`demand: false`): it reads what the host holds, and starts no Container.
 */
const readInventory = (
  access: SettingsMcpAccessService,
  input: {
    readonly view: SettingsMcpView;
    readonly names?: ReadonlyArray<string>;
    readonly parts: ReadonlyArray<string>;
  },
): Effect.Effect<Inventory> =>
  Effect.gen(function* () {
    const { view } = input;

    if (view.scope === GLOBAL_SETTINGS_SCOPE) return notRead("global");

    if (view.servers.length === 0) return notRead("no_servers");

    const request: Mutable<McpServersRequest> = { parts: input.parts, demand: false };

    if (input.names !== undefined) request.names = input.names;

    const answer = yield* access.host(view.scope).servers(request);

    return Predicate.isTagged(answer, "HostFailed")
      ? notRead("host_unavailable")
      : {
          read: "read",
          byName: new Map(Arr.map(answer.servers, (server) => [server.name, server] as const)),
        };
  });

/**
 * Send `environment`'s host the set the Registry has not handed it (`mcpPending`'s push for it), as the main Worker does
 * after the owner's save: the Registry never calls out, so the Session carries the push of its own change, to any
 * Environment's host (`docs/architecture/mcp-configuration.md` → From the Registry to the host). It tells the Registry
 * once the host took it. `not_needed` when there is nothing to hand it (the host has the set, or neither it nor the set
 * has a server, `shouldPushMcpSet`: such a host is never woken) or it holds a later one; `failed` when the push could
 * not be made: nothing fails the tool for it, and the host's next pull heals it.
 */
export const pushMcpSet = (
  access: SettingsMcpAccessService,
  environment: string,
): Effect.Effect<"pushed" | "not_needed" | "failed"> =>
  Effect.gen(function* () {
    const sets = yield* access.pushes(environment);

    if (sets.length === 0) return "not_needed" as const;

    const host = access.host(environment);
    let sent = false;

    for (const set of sets) {
      const answer = yield* host.apply(set);

      if (Predicate.isTagged(answer, "Applied")) {
        yield* access.pushed({ environment, hash: set.hash, revision: set.revision });
        sent = true;
      } else if (!Predicate.isTagged(answer, "Stale")) {
        return "failed" as const;
      }
    }

    return sent ? ("pushed" as const) : ("not_needed" as const);
  }).pipe(Effect.orElseSucceed(() => "failed" as const));

/** How the host answered a reload, as a value gives it. */
const reloadHost = (
  answer: Effect.Success<ReturnType<McpHostClientService["apply"]>> | undefined,
): ReloadHost => {
  if (answer === undefined) {
    return { status: "not_reached", servers: [], note: "the set has no servers" };
  }

  if (Predicate.isTagged(answer, "Reloaded")) {
    return { status: "reloaded", servers: answer.servers, note: null };
  }

  return Predicate.isTagged(answer, "HostUnsupported")
    ? {
        status: "unsupported",
        servers: [],
        note: "the host is an older build that does not reload yet: it heals at the next deploy",
      }
    : { status: "failed", servers: [], note: "the host did not answer" };
};

const SCOPE_NOTE =
  "Give scope \"*\" for Global, which lists Global's own entries only, or an Environment's id (environment_list shows them) for its whole set: its own entries, Global's and each Repo's .pi/mcp.json.";

const NEVER_RESOLVED =
  "It reads the Registry and the Environment's MCP host's held inventory: it connects to no server and starts no Container. It shows each ${NAME} an entry reads as a Secret, a Variable or missing, never a value, and no hash. State, tool counts and the negotiated protocol version are what the host already holds (none for Global, or for an Environment with no servers).";

/**
 * The `settings_mcp` extension: its read-only tools over the Session's `SettingsMcpAccess` (the Registry's MCP read) and
 * the Environments' hosts it reaches (`SettingsMcpAccess.host`).
 */
export const SettingsMcpTools: Effect.Effect<Extension, never, SettingsMcpAccess> = Effect.gen(
  function* () {
    const access = yield* SettingsMcpAccess;

    const list = yield* defineEffectTool({
      name: "settings_mcp_list",
      description: `List the MCP servers of one Scope: per server its name and tool prefix, its source (Global, the Environment, or a Repo's file), the Repo entries it shadows, its transport and target, enabled, Exposure and the count of toolExposure keys each with where it is written, its description, the \${NAME} values it reads (marked secret, variable or missing), the settings_reset fields the Environment holds for it, its connection state with tool, direct, prompt and resource counts, the negotiated protocol version and the last error, its MCP sign-in and its problems; then each Repo's file as last read, adjustments with no server, and warnings. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only. To change a server, load the settings_mcp tools that change them with tool_search; a Repo's .pi/mcp.json is edited as a file, in a pull request.`,
      parameters: Schema.Struct({ scope: SettingsScope }),
      structuredOutputSchema: outputSchema(SettingsMcpListOutput),
      replay: "safe",
      execute: ({ scope }) =>
        Effect.gen(function* () {
          const view = yield* access.view({ scope });
          const own = yield* access.own;
          const inventory = yield* readInventory(access, { view, parts: ["tools"] });
          const out = listOutput(view, own, inventory);

          return {
            output: [{ type: "text" as const, text: describeList(out) }],
            structuredOutput: asOutput(SettingsMcpListOutput, out),
            details: { scope: view.scope, servers: view.servers.length },
          };
        }),
    });

    const get = yield* defineEffectTool({
      name: "settings_mcp_get",
      description: `Show one MCP server of one Scope in full: its layers as written (Global's entry, the Environment's entry or adjustment, each Repo's, shadowed ones included), the entry in force, up to ${MAX_GET_TOOLS} of its tools each with its model-facing name, title, effective Exposure and what decided it (the server's, a toolExposure name or pattern, or tools.offered), its annotation hints and problems, the toolExposure keys that match none of its tools, its prompts, its own instructions (cut at 4 KiB), the negotiated protocol version, its sampling setting ("ask", "allow" or "off": whether it may use the user's models) and its state. name is the server in force in that Scope's set. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only.`,
      parameters: Schema.Struct({
        scope: SettingsScope,
        name: Schema.String.check(Schema.isMinLength(1)).annotate({
          description: "The server's name as settings_mcp_list shows it",
        }),
      }),
      structuredOutputSchema: outputSchema(SettingsMcpGetOutput),
      replay: "safe",
      execute: ({ scope, name }) =>
        Effect.gen(function* () {
          const view = yield* access.view({ scope, name });
          const own = yield* access.own;
          const entry = Arr.head(view.servers);

          if (Option.isNone(entry) || view.layers === null) {
            return yield* SettingsAccessError.make({
              message: `No MCP server ${JSON.stringify(name)} in ${scopeWords(scopeOutput(view))}. ${
                view.names.length === 0
                  ? "It has none."
                  : `Its servers: ${Arr.join(view.names, ", ")}.`
              }${
                view.scope === GLOBAL_SETTINGS_SCOPE
                  ? " Global lists its own entries only: a Repo's server is in the set of an Environment that has the Repo (give its id)."
                  : ""
              }`,
            });
          }

          const inventory = yield* readInventory(access, {
            view,
            names: [entry.value.server.name],
            parts: ["tools", "prompts", "instructions", "status"],
          });

          const out = getOutput(view, entry.value, view.layers, own, inventory);

          return {
            output: [{ type: "text" as const, text: describeGet(out) }],
            structuredOutput: asOutput(SettingsMcpGetOutput, out),
            details: { scope: view.scope, server: entry.value.server.name },
          };
        }),
    });

    const reload = yield* defineEffectTool({
      name: "settings_mcp_reload",
      description: `Read an Environment's Repos' .pi/mcp.json again (at most once per Repo each 30 seconds, a Repo looked at since being reported as recent), and have the Environment's MCP host drop its eras and Legacy sessions and rediscover its HTTP servers at once: for a server that is stuck, or a file that was just merged. It reports per Repo its directory, slug, path, outcome (changed, unchanged, absent, unreadable, invalid, not_github or recent), blob, read time and error; and for the set the servers added, removed and changed and the problems that appeared and cleared. A Repo that cannot be read keeps its last good copy: only the user's Reload on the Settings page drops it. scope is an Environment's id only ("*" is refused: Global has no Repos and no host). The set is sent to that Environment's MCP host and the host reloaded, whichever Environment it is (a host is not woken for an Environment whose set is and was empty). It is not an Agent change: no reason, no record, no Approval. A Repo's file is read on its default branch only, so a change on a branch shows once it is merged.`,
      parameters: Schema.Struct({ scope: SettingsScope }),
      structuredOutputSchema: outputSchema(SettingsMcpReloadOutput),
      replay: "safe",
      execute: ({ scope }) =>
        Effect.gen(function* () {
          if (scope === GLOBAL_SETTINGS_SCOPE) {
            return yield* SettingsAccessError.make({
              message:
                "settings_mcp_reload takes an Environment's id: Global has no Repos to read and no MCP host to reload. Give the id as environment_list shows it.",
            });
          }

          const report = yield* access.reload(scope);
          const push = yield* pushMcpSet(access, scope);

          // A set with no server has nothing to rediscover, and the host is not woken for none.
          const reloaded =
            report.servers > 0 ? yield* access.host(scope).apply({ kind: "reload" }) : undefined;

          const out = reloadOutput(report, push, reloadHost(reloaded));

          return {
            output: [{ type: "text" as const, text: describeReload(out) }],
            structuredOutput: asOutput(SettingsMcpReloadOutput, out),
            details: { scope: report.scope, servers: report.servers },
          };
        }),
    });

    return defineExtension({ name: extensionName, tools: [list, get, reload] });
  },
);
