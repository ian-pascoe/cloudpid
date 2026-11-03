// The Session's Sign-in requests (`docs/architecture/mcp-sign-in.md` → Sign-in requests): the agent's asks that the owner
// sign in to an MCP server, shown on every client's card over the Session socket and pushed once for the first open request
// of a sign-in's key. They are durable (the Session's storage), and the Registry keeps one waiter row for each, which
// the main Worker reads to carry a completed sign-in back (`mcp/sign-in-sessions.ts` → `resolveMcpSignIns` below). The
// tool that asks is built outside the Session's runtime (`./mcp-host.ts`), so the service is made synchronously, and the
// Secrets the agent's words are redacted of are bound when the runtime builds its layer.
import {
  createMcpSignIns,
  McpSignIns,
  McpSignInsError,
  type McpSignInsService,
  type McpSignInStorage,
} from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import { type McpSignInKnownAskAnswer, readMcpSignInAskAnswer } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PushEvent } from "../push/notification.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import { mcpSignInRequests, send, type SocketState } from "./sockets.ts";

/** The Registry's methods the requests use, on its object. */
export type SessionSignInRegistry = Pick<RegistryMethods, "mcpSignInAsk" | "mcpSignInWithdraw">;

export type SessionMcpSignInsOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: McpSignInStorage;
  /** The object's sockets, which every change to the open requests is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** The Session's name, its ID in the Registry; none, and no request can be made. */
  readonly session: string | undefined;
  /** The Registry object. */
  readonly registry: () => SessionSignInRegistry;
  /** Tell the owner, by Web Push, that a sign-in is needed. Leave it out to tell nobody. */
  readonly notify?: (event: PushEvent) => Effect.Effect<void>;
};

/** The service the Session's MCP tools ask through, and the layer that provides it once the Secrets are built. */
export type SessionMcpSignIns = {
  readonly service: McpSignInsService;
  readonly layer: Layer.Layer<McpSignIns, never, Secrets>;
};

const unreachable = (what: string) => () =>
  McpSignInsError.make({ message: `The Registry did not answer ${what}` });

export const sessionMcpSignIns = (options: SessionMcpSignInsOptions): SessionMcpSignIns => {
  let bound: SecretsService | undefined;
  const { session } = options;

  /** The Secrets, asked for again if they are due; a request is never made before the runtime is built. */
  const secrets = Effect.suspend(() =>
    bound === undefined
      ? Effect.die("The Session's Secrets are not built yet")
      : Effect.as(bound.refresh, bound),
  );

  const service = createMcpSignIns({
    storage: options.storage,
    announce: (requests) =>
      Effect.forEach(options.sockets.getWebSockets(), (socket) =>
        send(socket, mcpSignInRequests(requests)),
      ).pipe(Effect.asVoid),
    notify:
      options.notify === undefined
        ? undefined
        : ({ server, reason, key }) =>
            options.notify?.({ kind: "input", names: [], signIn: { server, reason, key } }) ??
            Effect.void,
    // What the owner is shown never holds a Secret's value.
    redact: (shown) => Effect.map(secrets, (held) => held.redact(shown)),
    registry: {
      ask: ({ environment, server, request }) =>
        session === undefined
          ? Effect.fail(McpSignInsError.make({ message: "The Session's name is unknown" }))
          : Effect.suspend(() =>
              options.registry().mcpSignInAsk({ environment, server, session, request }),
            ).pipe(
              Effect.map((answer): McpSignInKnownAskAnswer => readMcpSignInAskAnswer(answer)),
              Effect.mapError(unreachable("a Sign-in request")),
            ),
      withdraw: (request) =>
        session === undefined
          ? Effect.void
          : Effect.suspend(() => options.registry().mcpSignInWithdraw({ session, request })).pipe(
              Effect.asVoid,
              Effect.mapError(unreachable("a Sign-in request's withdrawal")),
            ),
    },
  });

  return {
    service,
    layer: Layer.effect(
      McpSignIns,
      Effect.gen(function* () {
        bound = yield* Secrets;

        return service;
      }),
    ),
  };
};
