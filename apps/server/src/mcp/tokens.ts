// The host's access tokens (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object; `docs/architecture/
// mcp-connections.md` → The host object, The engine): what `McpHost` asks the Registry's `mcpAccessToken` for, keeps in
// memory, and hands to the engine. Only the Registry holds tokens at rest and refreshes them; the host's cache is in
// memory only, and holds a token until `exp − 60 s`, or for 15 min when the server gave it no lifetime. It drops one on
// a 401, on eviction (the memory goes with the instance) and on `apply({ kind: "sign_ins" })`.
//
// A token is bound to its sign-in's protected resource: it is handed out only for a server whose URL is the resource's
// origin and within its path, so a token never goes to another site even if an entry's URL were repointed.
//
// A token is in a `token` access, and nowhere else: no error, log line or span of this module carries one.
// @effect-diagnostics missingPipeableSignature:off -- the cache's operations, not combinators.
import { McpAccessTokenAnswer, type McpSignInNote } from "@cloudpid/mcp/types";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpRegistryPort, type McpRegistryPortService } from "./registry-port.ts";
import { MINUTE_MS } from "./time.ts";

/** A cached token is dropped this long before it expires (the Registry refreshes from the same margin). */
export const TOKEN_MARGIN_MS = MINUTE_MS;

/** A token with no lifetime is held this long. */
export const NO_EXPIRY_HOLD_MS = 15 * MINUTE_MS;

/** Why there is no token for a server: what the sign-in says, or that the Registry could not be asked. */
export type NoToken =
  | {
      readonly kind: "none";
      /** `required`, `step_up`, `rejected`, `refresh_failing` or `unavailable`; the Registry's own status. */
      readonly status: "required" | "step_up" | "rejected" | "refresh_failing" | "unavailable";
      readonly reason: string;
      readonly scope?: string;
    }
  | { readonly kind: "unreachable"; readonly message: string };

/** The access a server has: a token to send, or why there is none. */
export type TokenAccess =
  | {
      readonly kind: "token";
      readonly token: string;
      /** The MCP sign-in id: new with each completed sign-in or step-up, the same through refreshes. */
      readonly signIn: string;
      /** Present while the sign-in's status is not `ok` yet its token still serves. */
      readonly note?: McpSignInNote;
    }
  | NoToken;

/** The server a token is asked for: its name in the set and the URL it is reached at. */
export type TokenFor = {
  readonly environment: string;
  readonly server: string;
  readonly url: string;
};

export type McpTokensService = {
  /** The token for `server`: the cache's while it stands, else the Registry's. */
  readonly access: (input: TokenFor) => Effect.Effect<TokenAccess>;
  /**
   * `token`, which `server` just refused with a 401 that is not `insufficient_scope`, is dropped, and the Registry
   * asked again with it as `stale`: it refreshes it, or hands over the current token when another host already did.
   */
  readonly refused: (input: TokenFor & { readonly token: string }) => Effect.Effect<TokenAccess>;
  /** Drop the cached tokens of `servers` (every server's when none is named). */
  readonly drop: (servers?: ReadonlyArray<string>) => Effect.Effect<void>;
};

/** What the cache holds for one server. */
type Held = {
  readonly url: string;
  readonly token: string;
  readonly signIn: string;
  readonly note: McpSignInNote | undefined;
  readonly validUntil: number;
};

/**
 * Whether `url` is the origin of `resource` and within its path: `https://mcp.example.com/mcp` and `.../mcp/sse` are
 * within `https://mcp.example.com/mcp`, and `/mcp-other` is not.
 */
export const withinResource = (url: string, resource: string): boolean => {
  if (!URL.canParse(url) || !URL.canParse(resource)) return false;

  const target = new URL(url);
  const bound = new URL(resource);

  if (target.origin !== bound.origin) return false;

  const prefix = bound.pathname.endsWith("/") ? bound.pathname : `${bound.pathname}/`;

  return target.pathname === bound.pathname || target.pathname.startsWith(prefix);
};

const unavailable = (reason: string): NoToken => ({ kind: "none", status: "unavailable", reason });

/** What a Registry answer comes to: the access, and what the cache keeps of it (only for a token). */
type Resolved = {
  readonly access: TokenAccess;
  readonly held: Omit<Held, "url"> | undefined;
};

const noToken = (access: NoToken): Resolved => ({ access, held: undefined });

const isToken = Schema.is(McpAccessTokenAnswer.members[0]);

const isNoToken = Schema.is(McpAccessTokenAnswer.members[1]);

/** The Registry's answer as an access for the server at `url`, with what the cache may hold of it. */
const resolve = (answer: McpAccessTokenAnswer, url: string, now: number): Resolved => {
  if (isToken(answer)) {
    if (!withinResource(url, answer.resource)) {
      return noToken(
        unavailable(
          "The server's URL is outside the protected resource its sign-in is for, so the token is not sent",
        ),
      );
    }

    const access: Types.Mutable<Extract<TokenAccess, { kind: "token" }>> = {
      kind: "token",
      token: answer.token,
      signIn: answer.signIn,
    };

    if (answer.note !== undefined) access.note = answer.note;

    return {
      access,
      held: {
        token: answer.token,
        signIn: answer.signIn,
        note: answer.note,
        validUntil:
          answer.expiresAt === undefined
            ? now + NO_EXPIRY_HOLD_MS
            : answer.expiresAt - TOKEN_MARGIN_MS,
      },
    };
  }

  if (isNoToken(answer)) {
    const access: Types.Mutable<Extract<NoToken, { kind: "none" }>> = {
      kind: "none",
      status: answer.status,
      reason: answer.reason,
    };

    if (answer.scope !== undefined) access.scope = answer.scope;

    return noToken(access);
  }

  // A status a newer Registry sends reads as a generic failure.
  return noToken(
    unavailable("The Registry answered with a sign-in state this build does not know"),
  );
};

const tokensOver = (registry: McpRegistryPortService): McpTokensService => {
  const cache = new Map<string, Held>();

  const ask = (input: TokenFor, stale?: string): Effect.Effect<TokenAccess> =>
    Effect.gen(function* () {
      const answer = yield* registry
        .accessToken(
          stale === undefined
            ? { environment: input.environment, server: input.server }
            : { environment: input.environment, server: input.server, stale },
        )
        .pipe(Effect.result);

      if (Result.isFailure(answer)) {
        // What failed is the Registry call: no value of it is in the message.
        return {
          kind: "unreachable",
          message: "The Registry could not be asked for the server's sign-in",
        } as const;
      }

      const now = yield* Clock.currentTimeMillis;
      const { access, held } = resolve(answer.success, input.url, now);

      if (held === undefined) cache.delete(input.server);
      else cache.set(input.server, { ...held, url: input.url });

      return access;
    });

  return {
    access: (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const held = cache.get(input.server);

        if (held !== undefined && held.url === input.url && now < held.validUntil) {
          const cached: Types.Mutable<Extract<TokenAccess, { kind: "token" }>> = {
            kind: "token",
            token: held.token,
            signIn: held.signIn,
          };

          if (held.note !== undefined) cached.note = held.note;

          return cached;
        }

        return yield* ask(input);
      }),

    refused: (input) =>
      Effect.suspend(() => {
        // Only the token that was refused goes: a newer one (another request's) stays for whoever asks.
        if (cache.get(input.server)?.token === input.token) cache.delete(input.server);

        return ask(input, input.token);
      }),

    drop: (servers) =>
      Effect.sync(() => {
        if (servers === undefined) cache.clear();
        else for (const server of servers) cache.delete(server);
      }),
  };
};

/**
 * The engine's `auth(stale)` hook for one server (`McpEngineHooks.auth`): the token the host holds for it, asked again
 * with `stale` after the server refused the one given. Remembers the token it gave, so the Registry is told which one
 * was refused, and tells `seen` each access it handed over (and whether it answered a refusal). A request's engine
 * call passes it as `auth` (a background call has none: a function stub does not
 * outlive its invocation, #409, so discovery passes the token in the target's headers instead).
 */
export const engineAuth = (
  tokens: McpTokensService,
  input: TokenFor,
  seen?: (access: TokenAccess, stale: boolean) => void,
): ((stale: boolean) => Effect.Effect<string | undefined>) => {
  let given: string | undefined;

  return (stale) => {
    const refused = stale ? given : undefined;

    return (
      refused === undefined ? tokens.access(input) : tokens.refused({ ...input, token: refused })
    ).pipe(
      Effect.map((access) => {
        seen?.(access, refused !== undefined);
        given = access.kind === "token" ? access.token : undefined;

        return given;
      }),
    );
  };
};

/** The host's tokens, kept in its runtime for the object's life. */
export class McpTokens extends Context.Service<McpTokens, McpTokensService>()(
  "@cloudpid/server/mcp/tokens/McpTokens",
) {
  static readonly layer = Layer.effect(
    McpTokens,
    Effect.gen(function* () {
      return tokensOver(yield* McpRegistryPort);
    }),
  );
}
