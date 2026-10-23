// The composer's `@` menu (`files`), per conversation: what follows the `@` is sent to the Session once the owner
// pauses for `FILE_SEARCH_DEBOUNCE_MS`, and the last answer is kept while the next one is asked for, so the menu
// narrows it as the owner types (`filesMenu` in `menu.ts`). An answer serves while the menu stays open and for
// `FILE_ANSWER_TTL_MS`, as the catalog does (`catalog.ts`): opening the menu again, or a later query, asks afresh. The
// draft composer's `@` menu searches the same way, asking the Registry (`draft-lookups.ts`).

// @effect-diagnostics missingPipeableSignature:off -- `fileResults` is a plain view function, not a combinator.

import type { FileMatches } from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "./conversation.ts";
import type { FileResults } from "./menu.ts";

/** How long the owner pauses typing before the query is sent. */
export const FILE_SEARCH_DEBOUNCE_MS = 120;

/** How long an answer serves its query while the menu stays open. */
export const FILE_ANSWER_TTL_MS = 30_000;

/** An answer, with the query it answers, when it came, and the opening of the menu it came in. */
interface Held {
  readonly query: string;
  readonly paths: readonly string[];
  readonly at: number;
  readonly opening: number;
}

/** What the Session answered so far: the latest answer, and the query whose request failed, if any. */
export interface FileSearchState {
  readonly held: Held | null;
  readonly failed: string | null;
}

const EMPTY: FileSearchState = { held: null, failed: null };

/** One conversation's `@` menu requests: what was answered, and what the menu shows now. */
export interface FileSearch {
  readonly state: SubscriptionRef.SubscriptionRef<FileSearchState>;
  /** The menu now shows `query`; null: it is closed. */
  readonly set: (query: string | null) => Effect.Effect<void>;
}

/**
 * The `@` menu's requests for one conversation's composer, as long as the scope is open: `set` says what the menu shows
 * now, and it asks `files` when it should, keeping the latest answer to arrive. An answer overtaken by a newer
 * request's is dropped; closing the menu clears a failure, and the next opening asks again.
 */
export const makeFileSearch = Effect.fnUntraced(function* <E>(
  files: (query: string) => Effect.Effect<FileMatches, E>,
) {
  const state = yield* SubscriptionRef.make(EMPTY);
  const timer = yield* FiberHandle.make();
  const scope = yield* Effect.scope;

  let current = EMPTY;
  let query: string | null = null;
  /** Counts the menu's openings, so an answer from an earlier one is asked for again. */
  let opening = 0;
  /** The query the pending timer, or the request out, asks about. */
  let asking: string | null = null;
  let sent = 0;
  let shown = 0;

  const update = (next: FileSearchState) =>
    Effect.suspend(() => {
      current = next;

      return SubscriptionRef.set(state, next);
    });

  const cancel = Effect.suspend(() => {
    asking = null;

    return FiberHandle.clear(timer);
  });

  /** Whether the answer held still serves `asked`: asked in this opening of the menu, and fresh. */
  const serves = (asked: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const { held } = current;

        return (
          held !== null &&
          held.query === asked &&
          held.opening === opening &&
          now - held.at < FILE_ANSWER_TTL_MS
        );
      }),
    );

  /** Send `asked`, and keep its answer unless a newer request's came first; a request out runs to its end. */
  const ask = (asked: string) =>
    Effect.gen(function* () {
      sent += 1;

      const request = sent;
      const askedIn = opening;
      const answer = yield* Effect.exit(files(asked));

      if (asking === asked) asking = null;

      if (Exit.isSuccess(answer)) {
        if (request < shown) return;

        shown = request;

        const at = yield* Clock.currentTimeMillis;

        yield* update({
          held: { query: asked, paths: answer.value.paths, at, opening: askedIn },
          failed: current.failed === asked ? null : current.failed,
        });
      } else if (asked === query) {
        yield* update({ ...current, failed: asked });
      }
    }).pipe(Effect.forkIn(scope), Effect.asVoid);

  const set = (next: string | null): Effect.Effect<void> =>
    Effect.gen(function* () {
      const opened = query === null && next !== null;

      query = next;

      if (next === null) {
        yield* cancel;

        if (current.failed !== null) yield* update({ ...current, failed: null });

        return;
      }

      if (opened) {
        opening += 1;
        // A request still out from the last opening answers for that one: this one asks again.
        yield* cancel;
      }

      if (asking === next) return;

      yield* cancel;

      if (yield* serves(next)) return;

      asking = next;
      yield* FiberHandle.run(
        timer,
        Effect.sleep(FILE_SEARCH_DEBOUNCE_MS).pipe(Effect.andThen(ask(next))),
      );
    });

  return { state, set } satisfies FileSearch;
});

/** The menu's view of `state` for what is typed now: `query`, or null while the menu is closed. */
export const fileResults = (state: FileSearchState, query: string | null): FileResults => {
  const { held } = state;
  const failed = state.failed !== null && state.failed === query;

  return {
    query: held?.query ?? null,
    paths: held?.paths ?? [],
    searching: query !== null && held?.query !== query && !failed,
    failed,
  };
};

/** `@` menu searches kept per key: what each was answered, and how to say what it shows. */
export interface FileSearchLookup<K, E> {
  /** What was answered to the `@` menu of `key`; read with `fileResults` and what is typed now. */
  readonly fileSearchAtom: (key: K) => Atom.Atom<FileSearchState>;
  /**
   * Say what the `@` menu of `key` shows now: the query after the `@`, or null while it is closed. Fails when the
   * search could not be made (`E`).
   */
  readonly searchFilesAtom: (key: K) => Atom.AtomResultFn<string | null, void, E>;
}

/**
 * `@` menu searches per key, each asking with the `files` that `searcher` makes for it. A key's requests stop when
 * nothing reads its state.
 */
export const fileSearchLookup = <K, E, F>(
  searcher: (
    key: K,
    get: Atom.AtomContext,
  ) => Effect.Effect<(query: string) => Effect.Effect<FileMatches, F>, E, RegistryClient>,
): FileSearchLookup<K, E> => {
  const searchProgramAtom = Atom.family((key: K) =>
    appRuntime.atom((get) => searcher(key, get).pipe(Effect.flatMap(makeFileSearch))),
  );

  const searchStateAtom = Atom.family((key: K) =>
    appRuntime.subscriptionRef((get) =>
      get.result(searchProgramAtom(key)).pipe(Effect.map((search) => search.state)),
    ),
  );

  return {
    fileSearchAtom: Atom.family((key: K) =>
      Atom.map(searchStateAtom(key), (result) => AsyncResult.getOrElse(result, () => EMPTY)),
    ),
    searchFilesAtom: Atom.family((key: K) =>
      appRuntime.fn(
        (query: string | null, get) =>
          get.result(searchProgramAtom(key)).pipe(Effect.flatMap((search) => search.set(query))),
        { concurrent: true },
      ),
    ),
  };
};

/** The conversations' `@` menus, searched over their Session's client. */
export const { fileSearchAtom, searchFilesAtom } = fileSearchLookup((key: ConversationKey, get) =>
  get
    .result(sessionClientAtom(key.sessionId))
    .pipe(Effect.map((client) => (query: string) => client.files(query, key.conversationId))),
);
