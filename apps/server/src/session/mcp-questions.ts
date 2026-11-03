// The Session's MCP questions (`docs/architecture/mcp-server-requests.md` → Questions, Elicitation requests): the forms
// MCP servers ask the owner during a call, shown on every client's card over the Session socket and pushed to the owner
// once as a call starts waiting. They live in memory, as long as their call waits; the storage holds only the records
// (never an answered value). The tools that ask are built outside the Session's runtime (`./mcp-host.ts`), so the
// service is made synchronously, and the Secrets it checks answers against are bound when the runtime builds its layer.
import { credentialCheck, DeployCredentials } from "@cloudpid/extensions/environment";
import {
  createMcpQuestions,
  McpQuestions,
  type McpQuestionsService,
  type McpQuestionStorage,
} from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PushEvent } from "../push/notification.ts";
import { mcpElicitationRequests, send, type SocketState } from "./sockets.ts";

export type SessionMcpQuestionsOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: McpQuestionStorage;
  /** The object's sockets, which every change to the waiting questions is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** Tell the owner, by Web Push, that a server waits for them. Leave it out to tell nobody. */
  readonly notify?: (event: PushEvent) => Effect.Effect<void>;
  /** The deploy-time credentials no answer may hold. */
  readonly credentials: ReadonlyArray<string>;
  /** How long a question waits, `MCP_ELICITATION_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number | undefined;
};

/** The service the Session's MCP tools ask through, and the layer that provides it once the Secrets are built. */
export type SessionMcpQuestions = {
  readonly service: McpQuestionsService;
  readonly layer: Layer.Layer<McpQuestions, never, Secrets>;
};

export const sessionMcpQuestions = (options: SessionMcpQuestionsOptions): SessionMcpQuestions => {
  let bound: SecretsService | undefined;

  /** The Secrets, asked for again if they are due; a question is never asked before the runtime is built. */
  const secrets = Effect.suspend(() =>
    bound === undefined
      ? Effect.die("The Session's Secrets are not built yet")
      : Effect.as(bound.refresh, bound),
  );

  const credentials = credentialCheck.pipe(
    Effect.provideService(DeployCredentials, { values: options.credentials }),
  );

  const service = createMcpQuestions({
    storage: options.storage,
    announce: (requests) =>
      Effect.forEach(options.sockets.getWebSockets(), (socket) =>
        send(socket, mcpElicitationRequests(requests)),
      ).pipe(Effect.asVoid),
    notify:
      options.notify === undefined
        ? undefined
        : ({ server }) =>
            options.notify?.({
              kind: "input",
              names: [],
              mcp: { server, kind: "elicitation" },
            }) ?? Effect.void,
    // What the owner is shown never holds a Secret's value.
    redact: (shown) => Effect.map(secrets, (held) => held.redact(shown)),
    holdsSecret: (text) =>
      Effect.gen(function* () {
        const held = yield* secrets;
        const holdsCredential = yield* credentials;

        return held.redact(text) !== text || holdsCredential(text);
      }),
    waitMs: options.waitMs,
  });

  return {
    service,
    layer: Layer.effect(
      McpQuestions,
      Effect.gen(function* () {
        bound = yield* Secrets;
        // The questions an earlier instance left waiting: their calls are gone with it.
        yield* service.expireStale;

        return service;
      }),
    ),
  };
};
