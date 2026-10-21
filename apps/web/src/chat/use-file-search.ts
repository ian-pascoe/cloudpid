// The composer's `@` menu (`files`): what follows the `@` is sent to the Session once the owner pauses for
// `FILE_SEARCH_DEBOUNCE_MS`, and the last answer is kept while the next one is asked for, so the menu narrows it as the
// owner types (`filesMenu` in `menu.ts`). An answer serves while the menu stays open and for `FILE_ANSWER_TTL_MS`, as the
// catalog does (`use-catalog.ts`): opening the menu again, or a later query, asks afresh.

// @effect-diagnostics globalDate:off globalTimers:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: timers and Date are the platform here.

import type { FileMatches } from "@cloudpid/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionConnection } from "../session/connection.ts";
import type { FileResults } from "./menu.ts";

/** How long the owner pauses typing before the query is sent. */
export const FILE_SEARCH_DEBOUNCE_MS = 120;

/** How long an answer serves its query while the menu stays open. */
export const FILE_ANSWER_TTL_MS = 30_000;

/** A conversation and a query typed in its composer. */
type Asked = { readonly conversationId: number | undefined; readonly query: string };

/** An answer, with what it answers, when it came, and the opening of the menu it came in. */
type Held = Asked & {
  readonly paths: readonly string[];
  readonly at: number;
  readonly opening: number;
};

/** What the Session answered so far: the latest answer, and the query whose request failed, if any. */
export type FileSearchState = { readonly held: Held | null; readonly failed: Asked | null };

const EMPTY: FileSearchState = { held: null, failed: null };

/**
 * The `@` menu's requests for one composer, apart from React: `set` says what the menu shows now, and the store asks
 * the Session (`files`) when it should, keeping the latest answer to arrive. An answer overtaken by a newer request's is
 * dropped; another conversation starts over; closing the menu clears a failure, and the next opening asks again.
 */
export class FileSearchStore {
  readonly #files: (query: string, conversationId: number | undefined) => Promise<FileMatches>;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #state = EMPTY;
  #conversationId: number | undefined;
  #query: string | null = null;
  /** Counts the menu's openings, so an answer from an earlier one is asked for again. */
  #opening = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The query the pending timer, or the request out, asks about. */
  #asking: string | null = null;
  #sent = 0;
  #shown = 0;

  constructor(
    files: (query: string, conversationId: number | undefined) => Promise<FileMatches>,
    now: () => number = Date.now,
  ) {
    this.#files = files;
    this.#now = now;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): FileSearchState => this.#state;

  /** The menu now shows `query` (null: it is closed) in the composer of `conversationId`. */
  set(conversationId: number | undefined, query: string | null): void {
    if (conversationId !== this.#conversationId) {
      this.#conversationId = conversationId;
      this.#cancel();
      // Answers on their way for the conversation before are dropped.
      this.#shown = this.#sent;
      this.#update(EMPTY);
    }

    const opened = this.#query === null && query !== null;

    this.#query = query;

    if (query === null) {
      this.#cancel();

      if (this.#state.failed !== null) this.#update({ ...this.#state, failed: null });

      return;
    }

    if (opened) {
      this.#opening += 1;
      // A request still out from the last opening answers for that one: this one asks again.
      this.#cancel();
    }

    if (this.#asking === query) return;

    this.#cancel();

    if (this.#serves(query)) return;

    this.#asking = query;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#ask(conversationId, query);
    }, FILE_SEARCH_DEBOUNCE_MS);
  }

  dispose(): void {
    this.#cancel();
    this.#listeners.clear();
  }

  /** Whether the answer held still serves `query`: asked in this opening of the menu, and fresh. */
  #serves(query: string): boolean {
    const { held } = this.#state;

    return (
      held !== null &&
      held.query === query &&
      held.opening === this.#opening &&
      this.#now() - held.at < FILE_ANSWER_TTL_MS
    );
  }

  #ask(conversationId: number | undefined, query: string): void {
    this.#sent += 1;

    const request = this.#sent;
    const opening = this.#opening;

    const done = () => {
      if (this.#asking === query) this.#asking = null;
    };

    this.#files(query, conversationId).then(
      (answer) => {
        done();

        if (conversationId !== this.#conversationId || request < this.#shown) return;

        this.#shown = request;

        const failed = this.#state.failed?.query === query ? null : this.#state.failed;

        this.#update({
          held: { conversationId, query, paths: answer.paths, at: this.#now(), opening },
          failed,
        });
      },
      () => {
        done();

        if (conversationId !== this.#conversationId || query !== this.#query) return;

        this.#update({ ...this.#state, failed: { conversationId, query } });
      },
    );
  }

  #cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = undefined;
    this.#asking = null;
  }

  #update(state: FileSearchState): void {
    this.#state = state;

    for (const listener of this.#listeners) listener();
  }
}

/** The menu's view of `state` for what is typed now: `query` in the composer of `conversationId`. */
export const fileResults = (
  state: FileSearchState,
  conversationId: number | undefined,
  query: string | null,
): FileResults => {
  const held = state.held?.conversationId === conversationId ? state.held : null;

  const failed =
    state.failed !== null &&
    state.failed.conversationId === conversationId &&
    state.failed.query === query;

  return {
    query: held?.query ?? null,
    paths: held?.paths ?? [],
    searching: query !== null && held?.query !== query && !failed,
    failed,
  };
};

/**
 * What the Session answered for `query` (null while the menu is not open) in the root conversation's directory, or in
 * subagent conversation `conversationId`'s.
 */
export const useFileSearch = (
  connection: Pick<SessionConnection, "files">,
  conversationId: number | undefined,
  query: string | null,
): FileResults => {
  const store = useMemo(
    () => new FileSearchStore((asked, conversation) => connection.files(asked, conversation)),
    [connection],
  );

  useEffect(() => {
    store.set(conversationId, query);
  }, [store, conversationId, query]);

  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return fileResults(state, conversationId, query);
};
