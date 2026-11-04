/**
 * One engine call's connection deps, over the host's `prior` rows and the call's hooks
 * (`docs/architecture/mcp-connections.md` → The engine; #382 D1, D13.2): the rows live in memory for the call and the
 * ones it changed go back as `state`; `fetch` is the Worker's own, metered against the call's lease on the byte budget;
 * `auth` asks the host, and every token it gives is remembered so the result can be scrubbed of it.
 */
// @effect-diagnostics globalFetch:off -- the engine reaches remote servers with the Worker's own `fetch`, under the core's tap.
import type { McpDeps, RowStore } from "@cloudpid/mcp";
import {
  MCP_PROGRESS_PER_SECOND,
  McpInputAnswer,
  McpInputRequest as McpInputRequestSchema,
  type McpCallContext,
  type McpEngineHooks,
  type McpEnginePrior,
  type McpEngineState,
  type McpInputRequest,
  type McpLogEntry,
  type McpProgress,
} from "@cloudpid/mcp/types";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpBridgeBinding } from "./binding.ts";
import { ByteBudget, type Lease, meteredFetch } from "./budget.ts";
import { callLogs } from "./logs.ts";

/** What a call needs from the Worker around it. */
export interface CallEnvironment {
  /** The deployed version, for `clientInfo`. */
  readonly version: string;
  /** Keeps the invocation alive until `done` settles (`ctx.waitUntil`): a large result's stream is read after return. */
  readonly hold: (done: Promise<void>) => void;
  /** `MCP_BRIDGE`, which a stdio target is reached through; absent where the Worker has none. */
  readonly bridge?: McpBridgeBinding;
}

/** One call's connection deps, and what the call learns along the way. */
export interface CallContext {
  readonly deps: McpDeps;
  readonly lease: Lease;
  /** Every access token the call sent, scrubbed from its result. */
  readonly tokens: ReadonlySet<string>;
  /** Hands the lease to the result's stream, which gives it back once read (`results.ts`). */
  readonly handOff: () => void;
  /** Whether the lease was handed to a stream. */
  readonly handedOff: () => boolean;
  /** The rows the call changed. */
  readonly state: () => McpEngineState;
  /** The server logs the call heard, scrubbed and cut, oldest first, at most 50. */
  readonly logs: () => ReadonlyArray<McpLogEntry>;
  /** The response bytes the call read from the server. */
  readonly bytes: () => number;
  /**
   * Sends the call's requests through `route` instead of the Worker's own `fetch` (a stdio target's bridge, still metered),
   * and offers the server `roots`: a connection is declared them only through here, so a remote server never is.
   */
  readonly routeVia: (route: McpDeps["fetch"], roots: McpDeps["roots"]) => void;
}

/** A row store over one in-memory cell, recording whether the call kept or dropped its row. */
const rowCell = (initial: Schema.Json | undefined) => {
  let row = initial;
  let change = Option.none<Schema.Json | null>();

  const store: RowStore = {
    get: Effect.sync(() => row),
    set: (next) =>
      Effect.sync(() => {
        row = next;
        change = Option.some(next);
      }),
    drop: Effect.sync(() => {
      row = undefined;
      change = Option.some(null);
    }),
  };

  return { store, change: () => change };
};

/** Tells the host a request's headers arrived; it only counts, so a lost notice fails nothing. */
const notifier = (opened: NonNullable<McpEngineHooks["opened"]>) => () => {
  void Promise.resolve(opened()).catch(() => undefined);
};

/**
 * The host's `onProgress` hook as the core's: at most `MCP_PROGRESS_PER_SECOND` notices a second reach it, the rest
 * dropped (the next one to pass says where the call is), and a hook that fails fails nothing. `now` is the clock, in
 * milliseconds.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a hook of two values, not a combinator.
export const progressTo = (
  onProgress: NonNullable<McpEngineHooks["onProgress"]>,
  now: () => number,
) => {
  const gap = 1000 / MCP_PROGRESS_PER_SECOND;
  let last = Number.NEGATIVE_INFINITY;

  return (progress: McpProgress) => {
    const at = now();

    if (at - last < gap) return;

    last = at;

    try {
      void Promise.resolve(onProgress(progress)).catch(() => undefined);
    } catch {
      // A stub whose caller is gone may throw at once: the notice is dropped, and the call goes on.
    }
  };
};

/** The host's `auth` hook as the core's, remembering each token it gives. */
const authFrom =
  (auth: NonNullable<McpEngineHooks["auth"]>, tokens: Set<string>) => (stale: boolean) =>
    Effect.tryPromise(() => auth(stale)).pipe(
      Effect.tap((token) =>
        Effect.sync(() => {
          if (token !== undefined) {
            tokens.add(token);
          }
        }),
      ),
      // A host that cannot answer gives no token, so the server asks for a sign-in as it would without one.
      Effect.orElseSucceed(() => undefined),
    );

/** What the server gets of a question the caller cannot take: the question is cancelled, and it may ask again. */
const CANCELLED: McpInputAnswer = { kind: "answered", result: { action: "cancel" } };

const decodeAnswer = Schema.decodeUnknownEffect(McpInputAnswer);

const encodeInput = Schema.encodeEffect(McpInputRequestSchema);

/**
 * The host's `onInput` hook as the core's (`docs/architecture/mcp-server-requests.md` → Questions): a caller that cannot
 * answer (its RPC broke, its Session gone) cancels the question, and an answer this build does not know (a newer
 * Session's) is a refusal, since the gain-only edge never gives an older engine a member it must act on. Nothing of a
 * question or its answer is kept or logged here.
 */
const inputFrom =
  (onInput: NonNullable<McpEngineHooks["onInput"]>) =>
  (request: McpInputRequest): Effect.Effect<McpInputAnswer> =>
    encodeInput(request).pipe(
      Effect.flatMap((encoded) => Effect.tryPromise(() => onInput(encoded))),
      Effect.flatMap((answer) =>
        decodeAnswer(answer).pipe(
          Effect.orElseSucceed((): McpInputAnswer => ({
            kind: "refused",
            message: "cloudpid could not read the answer to the question",
          })),
        ),
      ),
      Effect.orElseSucceed(() => CANCELLED),
    );

/** A host's notice of question `key` (`onInputEnded`, `onInputComplete`) as the core's: one that is lost fails nothing. */
const noticeFrom =
  (notice: NonNullable<McpEngineHooks["onInputEnded" | "onInputComplete"]>) => (key: string) => {
    try {
      void Promise.resolve(notice(key)).catch(() => undefined);
    } catch {
      // A stub whose caller is gone may throw at once: the notice is dropped.
    }
  };

/** The host's `onDeprecated` hook as the core's: a note that is lost fails nothing. */
const deprecatedFrom =
  (noted: NonNullable<McpEngineHooks["onDeprecated"]>) => (feature: string) => {
    try {
      void Promise.resolve(noted(feature)).catch(() => undefined);
    } catch {
      // A stub whose caller is gone may throw at once: the note is dropped.
    }
  };

/** Opens one call's context: its rows, its lease on the byte budget and its deps. */
export const openCall = Effect.fn("mcp.engine.openCall")(function* (
  prior: McpEnginePrior,
  hooks: McpEngineHooks,
  env: CallEnvironment,
  secrets: ReadonlyArray<string>,
) {
  const budget = yield* ByteBudget;
  const context = yield* Effect.context<never>();
  const lease = budget.lease();
  const eras = rowCell(prior.era);
  const sessions = rowCell(prior.session);
  // The Secrets the host put into the target are scrubbed as the access tokens are: from logs, errors and results.
  const tokens = new Set<string>(secrets);
  let bytes = 0;
  // Where the call's requests go: the Worker's own `fetch`, until a stdio target says otherwise.
  let route: McpDeps["fetch"] = (input, init) => fetch(input, init);

  // The core hands `fetch` a URL (or a `Request`, whose URL is all that is read) and an `init` that carries the method,
  // headers, body and signal: a bridge's `fetch` builds its own request from them.
  const routed: typeof globalThis.fetch = (input, init) =>
    route(input instanceof Request ? input.url : input, init);

  const logs = callLogs({
    now: () => Effect.runSyncWith(context)(Clock.currentTimeMillis),
    tokens: () => tokens,
  });

  const base = {
    fetch: meteredFetch(
      routed,
      lease,
      hooks.opened === undefined ? undefined : notifier(hooks.opened),
      (read) => {
        bytes += read;
      },
    ),
    eras: eras.store,
    sessions: sessions.store,
    // Roots are offered on a bridge connection only (`routeVia`). A Legacy connection declares an elicitation's form and
    // URL modes connection-wide, at `initialize`, whatever call opens it (`ctx` is undefined there): a question on a call
    // that cannot take it is cancelled, and a server that sees `url` may answer a `tools/call` `-32042`, which a call
    // that cannot wait for a page gets as the server's error (`docs/architecture/mcp-server-requests.md` → Questions,
    // Elicitation requests). A Modern request declares per request: the form of an elicitation only on a call whose caller
    // offers it (`ctx.answers`) and has an `onInput` to answer with; its `url` mode also only where the caller keeps the
    // page for later (`defer`) and resumes it (`pages`), or waits at it live (`livePages`: a prompt send's get), since a
    // Modern page is answered once the owner is done there.
    capabilities: (ctx?: McpCallContext) =>
      ctx === undefined
        ? { elicitation: { form: {}, url: {} } }
        : ctx.answers?.elicitation === true && hooks.onInput !== undefined
          ? {
              elicitation:
                (ctx.answers.defer === true && ctx.answers.pages === true) ||
                ctx.answers.livePages === true
                  ? { form: {}, url: {} }
                  : { form: {} },
            }
          : {},
    clientInfo: { name: "cloudpid", version: env.version },
    onLog: logs.hear,
  } satisfies McpDeps;

  const deps: Mutable<McpDeps> = { ...base };

  if (hooks.auth !== undefined) deps.auth = authFrom(hooks.auth, tokens);

  if (hooks.onInput !== undefined) deps.onInput = inputFrom(hooks.onInput);

  if (hooks.onInputEnded !== undefined) deps.onInputEnded = noticeFrom(hooks.onInputEnded);

  if (hooks.onInputComplete !== undefined) {
    deps.onInputComplete = noticeFrom(hooks.onInputComplete);
  }

  if (hooks.onDeprecated !== undefined) deps.onDeprecated = deprecatedFrom(hooks.onDeprecated);

  // A Worker's clock moves with I/O, and each notice arrives by I/O.
  if (hooks.onProgress !== undefined) deps.onProgress = progressTo(hooks.onProgress, Date.now);

  const state = () => {
    const changed: { -readonly [K in keyof McpEngineState]: McpEngineState[K] } = {};

    Option.map(eras.change(), (era) => {
      changed.era = era;
    });
    Option.map(sessions.change(), (session) => {
      changed.session = session;
    });

    return changed;
  };

  let handed = false;

  return {
    deps,
    lease,
    tokens,
    state,
    handOff: () => {
      handed = true;
    },
    handedOff: () => handed,
    logs: logs.entries,
    bytes: () => bytes,
    routeVia: (through, roots) => {
      route = through;

      if (roots !== undefined) deps.roots = roots;
    },
  } satisfies CallContext;
});

/**
 * Runs `use` over a new call context. The call's lease goes back once `use` ends, however it ends (a defect or an
 * interruption included), unless `use` succeeded having handed the lease to a stream, which gives it back itself.
 */
export const withCall = Effect.fnUntraced(function* <A, E, R>(
  prior: McpEnginePrior,
  hooks: McpEngineHooks,
  env: CallEnvironment,
  use: (call: CallContext) => Effect.Effect<A, E, R>,
  secrets: ReadonlyArray<string>,
) {
  // Opened uninterruptibly with its release attached, so no interruption can leave the lease held.
  return yield* Effect.acquireUseRelease(openCall(prior, hooks, env, secrets), use, (call, exit) =>
    Effect.sync(() => {
      if (Exit.isFailure(exit) || !call.handedOff()) {
        call.lease.release();
      }
    }),
  );
});
