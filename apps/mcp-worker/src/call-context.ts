/**
 * One engine call's connection deps, over the host's `prior` rows and the call's hooks
 * (`docs/architecture/mcp-connections.md` → The engine; #382 D1, D13.2): the rows live in memory for the call and the
 * ones it changed go back as `state`; `fetch` is the Worker's own, metered against the call's lease on the byte budget;
 * `auth` asks the host, and every token it gives is remembered so the result can be scrubbed of it.
 */
// @effect-diagnostics globalFetch:off -- the engine reaches remote servers with the Worker's own `fetch`, under the core's tap.
import type { McpDeps, RowStore } from "@cloudpid/mcp";
import type { McpEngineHooks, McpEnginePrior, McpEngineState } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { ByteBudget, type Lease, meteredFetch } from "./budget.ts";

/** What a call needs from the Worker around it. */
export interface CallEnvironment {
  /** The deployed version, for `clientInfo`. */
  readonly version: string;
  /** Keeps the invocation alive until `done` settles (`ctx.waitUntil`): a large result's stream is read after return. */
  readonly hold: (done: Promise<void>) => void;
}

/** One call's connection deps, and what the call learns along the way. */
export interface CallContext {
  readonly deps: McpDeps;
  readonly lease: Lease;
  /** Every access token the call sent, scrubbed from its result. */
  readonly tokens: ReadonlySet<string>;
  /** The rows the call changed. */
  readonly state: () => McpEngineState;
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

/** Opens one call's context: its rows, its lease on the byte budget and its deps. */
export const openCall = Effect.fn("mcp.engine.openCall")(function* (
  prior: McpEnginePrior,
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const budget = yield* ByteBudget;
  const lease = budget.lease();
  const eras = rowCell(prior.era);
  const sessions = rowCell(prior.session);
  const tokens = new Set<string>();

  const base = {
    fetch: meteredFetch(
      (input, init) => fetch(input, init),
      lease,
      hooks.opened === undefined ? undefined : notifier(hooks.opened),
    ),
    eras: eras.store,
    sessions: sessions.store,
    // A remote server is offered no roots, and the questions it may ask come with later slices.
    capabilities: () => ({}),
    clientInfo: { name: "cloudpid", version: env.version },
  } satisfies McpDeps;

  const deps: McpDeps =
    hooks.auth === undefined ? base : { ...base, auth: authFrom(hooks.auth, tokens) };

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

  return { deps, lease, tokens, state } satisfies CallContext;
});
