// The Session's side of its MCP tasks (`docs/architecture/mcp-server-requests.md` → MCP tasks): what the `mcp` extension
// follows them with. The record and the follower live in the Harness, the results in this object's key-value storage;
// this file gives the extension that storage, the Secrets a server's words are redacted of, and the one thing it cannot
// reach, the host's list of Runs whose end the owner is told of (`notify-submissions`): a follow-up Run a follower starts
// for an MCP task's end is one. The tools are built outside the Session's runtime (`./mcp-host.ts`), so the options are
// made synchronously, and the Secrets are bound when the runtime builds its layer.
import type { McpTasksOptions, McpTasksTiming } from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import type { SubmissionId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordRunNotice, type SessionNoticeKv } from "./host.ts";

export type SessionMcpTasksOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: SessionNoticeKv & Pick<McpTasksOptions["storage"], "delete">;
  /** Shorter times, for a test; the spec's otherwise. */
  readonly timing?: McpTasksTiming | undefined;
};

/** The options the Session's MCP tools follow tasks with, and the layer that binds the Secrets they redact. */
export type SessionMcpTasks = {
  readonly options: McpTasksOptions;
  readonly layer: Layer.Layer<never, never, Secrets>;
};

export const sessionMcpTasks = (options: SessionMcpTasksOptions): SessionMcpTasks => {
  let bound: SecretsService | undefined;

  /** The Secrets, asked for again if they are due; a task is never followed before the runtime is built. */
  const secrets = Effect.suspend(() =>
    bound === undefined
      ? Effect.die("The Session's Secrets are not built yet")
      : Effect.as(bound.refresh, bound),
  );

  const tasks: McpTasksOptions = {
    storage: options.storage,
    submitted: (id: SubmissionId) => {
      recordRunNotice(options.storage, id);
    },
    // What a server writes of its task never reaches the record or the model with a Secret's value in it.
    redact: (text) => Effect.runPromise(Effect.map(secrets, (held) => held.redact(text))),
  };

  return {
    options: options.timing === undefined ? tasks : { ...tasks, timing: options.timing },
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        bound = yield* Secrets;
      }),
    ),
  };
};
