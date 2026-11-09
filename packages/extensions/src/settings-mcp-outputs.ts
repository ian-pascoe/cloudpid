// What `settings_mcp_list`, `settings_mcp_get` and `settings_mcp_reload` give programs (`docs/architecture/agent-capabilities.md`
// → Values for programs; `docs/architecture/mcp-configuration.md` → Lists): each tool's `structuredOutput`, declared as its
// `structuredOutputSchema` (`./outputs.ts`). Keys are snake_case and "none" is null. Nothing here holds a resolved `${NAME}`
// value, a hash or a token: an entry is as written, each `${NAME}` it reads is marked `secret`, `variable` or `missing`.
// What can grow is cut as `./outputs.ts` says, with a `*_truncated` flag.
// @effect-diagnostics missingPipeableSignature:off
import { SERVER_STATES, SettingsMcpReloadOutput } from "@cloudpid/protocol/harness-tools";
import * as Schema from "effect/Schema";
import { ChangeOutputFields } from "./outputs.ts";

// The read tools' and the reload's schemas are declared once, in `@cloudpid/protocol/harness-tools`, for both surfaces.
export { SettingsMcpReloadOutput };

/** A server's status once an `add`, `update` or `enable` is made (`docs/architecture/mcp-configuration.md` → Results, Status wait). */
export const ServerStatusOutput = Schema.Struct({
  server: Schema.String.annotate({ description: "The server's name" }),
  state: Schema.Literals([...SERVER_STATES, "not_checked"]).annotate({
    description:
      "The server's state in this Session's Environment's MCP host after the change, waited for up to 10 s: connected, connecting (still, after the wait), needs_sign_in (the user must sign in: load mcp_sign_in_ask with tool_search and ask), failed, skipped, disabled, not_discovered (a stdio server before its first call starts the Container), or not_checked (the change does not reach this Session's Environment, or the host did not answer)",
  }),
  tools: Schema.Int.annotate({ description: "The tools it offers, once connected" }),
  direct: Schema.Int.annotate({ description: "Of those, the tools offered to the model by name" }),
  error: Schema.NullOr(Schema.String).annotate({
    description: "At most 300 characters of the error when it failed; null otherwise",
  }),
  note: Schema.String.annotate({ description: "What to tell the user of it, in a sentence" }),
});

/** What `settings_mcp_add`, `settings_mcp_update` and `settings_mcp_enable` give programs: the change, and the server's status. */
export const McpChangeOutput = Schema.Struct({
  ...ChangeOutputFields,
  server_status: Schema.NullOr(ServerStatusOutput).annotate({
    description:
      "The server's status after the change; null where the change was declined or nothing changed",
  }),
});
