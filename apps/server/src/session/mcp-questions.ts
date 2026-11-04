// The Session's MCP questions (`docs/architecture/mcp-server-requests.md` → Questions, Elicitation requests): the forms
// MCP servers ask the owner during a call, shown on every client's card over the Session socket and pushed to the owner
// once as a call starts waiting. A Legacy server's live in memory, as long as their call waits; a Modern server's are
// kept in the storage between the call's rounds, an accepted form's content sealed (AES-GCM, under a key derived from
// `SECRETS_ENCRYPTION_KEY` for the purpose `mcp-elicitation`, bound to the Session and the question) until its resume
// is built. The storage never holds an answered value in the clear. The tools that ask are built outside the Session's
// runtime (`./mcp-host.ts`), so the service is made synchronously, and the Secrets it checks answers against are bound
// when the runtime builds its layer.
import { credentialCheck, DeployCredentials } from "@cloudpid/extensions/environment";
import {
  createMcpQuestions,
  McpQuestions,
  type McpQuestionsService,
  type McpQuestionStorage,
  type McpSamplingRemember,
} from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import { openKeptVault } from "@cloudpid/extensions/secrets/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { PushEvent } from "../push/notification.ts";
import { mcpElicitationRequests, mcpSamplingRequests, send, type SocketState } from "./sockets.ts";

export type SessionMcpQuestionsOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: McpQuestionStorage;
  /** The object's sockets, which every change to the waiting questions is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** Tell the owner, by Web Push, that a server waits for them. Leave it out to tell nobody. */
  readonly notify?: (event: PushEvent) => Effect.Effect<void>;
  /** The deploy-time credentials no answer may hold. */
  readonly credentials: ReadonlyArray<string>;
  /** Whether a host is one of cloudpid's own, which no page a server asks the owner to open may be on. */
  readonly ownHost?: ((host: string) => boolean) | undefined;
  /** How long a question waits, `MCP_ELICITATION_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number | undefined;
  /** How long a question of a prompt send waits, `MCP_PROMPT_QUESTION_WAIT_MS` unless a test shortens it. */
  readonly promptWaitMs?: number | undefined;
  /** How long a Sampling request waits, `MCP_SAMPLING_ASK_WAIT_MS` unless a test shortens it. */
  readonly samplingWaitMs?: number | undefined;
  /** Where the Sampling card's *Always allow* and *Never* write the server's definition; without it the card cannot. */
  readonly remember?: McpSamplingRemember | undefined;
  /**
   * The master key, `SECRETS_ENCRYPTION_KEY`, and what names the Session in each sealed answer's binding: with both, a
   * Modern server's form is kept for later; without, it is answered live, as a Legacy one.
   */
  readonly encryptionKey?: Redacted.Redacted<string> | undefined;
  readonly session?: string | undefined;
};

/** The purpose deferred answers are sealed for (`openKeptVault`). */
export const MCP_ELICITATION_PURPOSE = "mcp-elicitation";

/** The service the Session's MCP tools ask through, and the layer that provides it once the Secrets are built. */
export type SessionMcpQuestions = {
  readonly service: McpQuestionsService;
  readonly layer: Layer.Layer<McpQuestions, never, Secrets>;
};

/** What the Notification says of what waits: a page to open, a model to use, or (absent both) a form. */
const pushedFor = (server: string, page: true | undefined, sampling: true | undefined) => {
  if (page === true) return { server, kind: "elicitation", page } as const;

  return { server, kind: sampling === true ? "sampling" : "elicitation" } as const;
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

  const { encryptionKey, session } = options;

  // Opened once, at the first answer it seals or opens; a malformed key fails that answer, never the Session.
  const kept =
    encryptionKey === undefined || session === undefined
      ? undefined
      : Effect.runSync(
          openKeptVault(Redacted.value(encryptionKey), MCP_ELICITATION_PURPOSE).pipe(Effect.cached),
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
        : ({ server, page, sampling }) =>
            options.notify?.({
              kind: "input",
              names: [],
              mcp: pushedFor(server, page, sampling),
            }) ?? Effect.void,
    announceSampling: ({ requests, grants }) =>
      Effect.forEach(options.sockets.getWebSockets(), (socket) =>
        send(socket, mcpSamplingRequests(requests, grants)),
      ).pipe(Effect.asVoid),
    samplingWaitMs: options.samplingWaitMs,
    remember: options.remember,
    // What the owner is shown never holds a Secret's value.
    redact: (shown) => Effect.map(secrets, (held) => held.redact(shown)),
    holdsSecret: (text) =>
      Effect.gen(function* () {
        const held = yield* secrets;
        const holdsCredential = yield* credentials;

        return held.redact(text) !== text || holdsCredential(text);
      }),
    waitMs: options.waitMs,
    promptWaitMs: options.promptWaitMs,
    ownHost: options.ownHost,
    vault:
      kept === undefined || session === undefined
        ? undefined
        : {
            seal: (id, text) =>
              Effect.flatMap(kept, (vault) => vault.seal({ owner: session, name: id }, text)),
            open: (id, sealed) =>
              Effect.flatMap(kept, (vault) => vault.open({ owner: session, name: id }, sealed)),
          },
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
