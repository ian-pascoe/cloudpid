// What an agent's `add`, `update` or `enable` says of the server once the change is made: its status from the Environment's
// `McpHost`, waited for up to 10 s (`docs/architecture/mcp-configuration.md` → The agent's changes → Results, Status wait).
// The change is applied, recorded and sent as a running update before the wait; Stop ends the wait and the change stands
// (pi-durable keeps a cancelled call's last running details: `docs/architecture/mcp-configuration.md` → As built: the Approval
// changes). A stdio server is discovered only in the Session's Workspace Container while it runs: no Container is started, and
// no other Environment's host is woken.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- builders over plain values.
import type { McpServerInventory, McpServersRequest } from "@cloudpid/mcp/types";
import type { SettingsMcpServer } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { boundText } from "./outputs.ts";
import type { SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { inventoryOutput } from "./settings-mcp-values.ts";

/** How long the status wait waits for a server being discovered, at most (`MCP_MAX_WAIT_MS`). */
export const STATUS_WAIT_MS = 10_000;

/** The longest error a status carries, in bytes. */
const MAX_STATUS_ERROR = 300;

/** What a server is, from the host: a state of the inventory, or `not_checked` where no host was asked. */
export type McpStatusState = ReturnType<typeof inventoryOutput>["state"] | "not_checked";

/** A server's status after a change: the `details.mcp` of the card and the `server_status` of the value. */
export type McpStatus = {
  readonly server: string;
  readonly status: McpStatusState;
  readonly tools: number;
  /** Of those tools, the ones offered to the model by name (`direct`). */
  readonly direct: number;
  readonly error: string | null;
  /** What to tell the agent about it, in a sentence. */
  readonly note: string;
};

/** A status as a call's `details.mcp` records it (what the card's chip shows). */
export const detailsOf = (status: McpStatus) => ({
  server: status.server,
  status: status.status,
  tools: status.tools,
  error: status.error,
});

const NOT_CHECKED_OTHER =
  "not checked: the change does not reach this Session's Environment, and no other Environment's host is woken to ask";

const sentence = (status: Omit<McpStatus, "note">, stdio: boolean): string => {
  const { server } = status;

  switch (status.status) {
    case "connected":
      return `${server} is connected with ${status.tools} tool${status.tools === 1 ? "" : "s"}${
        status.tools === 0
          ? ""
          : `, ${status.direct} offered to the model by name and the rest reached through codemode or tool_search`
      }.`;
    case "needs_sign_in":
      return `${server} needs the user to sign in: load \`mcp_sign_in_ask\` with tool_search and ask.`;
    case "sign_in_rejected":
      return `${server} refused the MCP sign-in it was given: the user has to sign in again (load \`mcp_sign_in_ask\` with tool_search and ask).`;
    case "failed":
    case "unavailable":
      return `${server} is not working: ${status.error ?? "the host reports a failure"}`;
    case "skipped":
      return `${server} was not connected: its definition cannot be used yet${status.error === null ? "" : ` (${status.error})`}, such as a \${NAME} that resolves to nothing.`;
    case "disabled":
      return `${server} is switched off or hidden, so it is not connected.`;
    case "not_discovered":
      return stdio
        ? `${server} is not discovered: a stdio server is discovered in a Workspace's Container while it runs, and the first call to it starts the Container.`
        : `${server} has not been discovered yet.`;
    case "connecting":
      return `${server} is still connecting after ${STATUS_WAIT_MS / 1000} s; settings_mcp_get shows its state later.`;
    case "not_checked":
      return `${server}: ${status.error ?? NOT_CHECKED_OTHER}.`;
  }
};

/** A status the Session did not ask the host for, and why. */
export const notChecked = (server: string, why: string): McpStatus => ({
  server,
  status: "not_checked",
  tools: 0,
  direct: 0,
  error: why,
  note: `${server}: ${why}.`,
});

/**
 * The status of `server` (as `entry` says it is, `offered` lifting tools to direct) in the Session's own Environment `own`,
 * waiting up to `waitMs` for it to settle (0 for a rerun, which finds the change made and does not wait). `before` runs once
 * the host is about to be asked, with the status as it stands (`connecting`), so the call's running details name it first.
 */
export const serverStatus = (
  access: SettingsMcpAccessService,
  input: {
    readonly own: string;
    readonly entry: SettingsMcpServer;
    readonly offered: ReadonlyArray<string>;
    readonly waitMs: number;
    readonly before: (status: McpStatus) => Effect.Effect<void>;
  },
): Effect.Effect<McpStatus> =>
  Effect.gen(function* () {
    const { entry } = input;
    const name = entry.server.name;
    const stdio = entry.server.server.type === "stdio";

    const connecting: McpStatus = {
      server: name,
      status: "connecting",
      tools: 0,
      direct: 0,
      error: null,
      note: `${name} is connecting.`,
    };

    if (!entry.server.server.enabled) {
      return {
        ...connecting,
        status: "disabled",
        note: sentence({ ...connecting, status: "disabled" }, stdio),
      };
    }

    yield* input.before(connecting);

    const workspace = yield* access.workspace ?? Effect.succeed(null);

    const request: Mutable<McpServersRequest> = {
      names: [name],
      parts: ["tools", "status"],
      waitMs: input.waitMs,
      demand: true,
    };

    if (workspace !== null) request.workspace = workspace;

    const answer = yield* access.host(input.own).servers(request);

    if ("_tag" in answer) return notChecked(name, "the Environment's MCP host did not answer");

    const row: McpServerInventory | undefined = answer.servers.find((each) => each.name === name);

    if (row === undefined)
      return notChecked(
        name,
        "the host does not hold the server yet: it takes the set at its next pull",
      );

    const found = inventoryOutput(entry, input.offered, row);

    const status = {
      server: name,
      status: found.state,
      tools: found.tools,
      direct: found.direct,
      error: found.error === null ? null : boundText(found.error, MAX_STATUS_ERROR).text,
    };

    return { ...status, note: sentence(status, stdio) };
  });
