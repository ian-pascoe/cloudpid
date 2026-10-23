// The composer's catalog (`catalog`): the Session's Slash commands and the Prompt templates and Skills of the
// conversation's directory, kept per conversation. Asked for when the menu first opens, and again once it is older than
// `CATALOG_TTL_MS`, so a template or Skill added meanwhile shows up without a reload. The draft composer keeps its own
// the same way, asked of the Registry (`draft-lookups.ts`).

import type { Catalog } from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Atom from "effect/reactivity/Atom";
import type { RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "./conversation.ts";

/** How long a catalog is fresh. */
export const CATALOG_TTL_MS = 30_000;

/** How long to wait before asking again after the Session could not answer. */
export const CATALOG_RETRY_MS = 5_000;

/** A catalog as the composer has it, whether it is being asked for, and when it may be again. */
interface Held {
  readonly catalog: Catalog | null;
  readonly asking: boolean;
  readonly nextAt: number;
}

/** Catalogs kept per key: each one, and how to ask for it. */
export interface CatalogLookup<K> {
  /** The catalog of `key`: null until it was first answered. Kept while a composer reads it. */
  readonly catalogAtom: (key: K) => Atom.Atom<Catalog | null>;
  /**
   * Ask for the catalog of `key`, unless it is fresh or a request is out. An answer replaces the catalog; a failure keeps
   * what it had (the menu still has the composer's own commands), and the next opening of the menu after
   * `CATALOG_RETRY_MS` asks again.
   */
  readonly askCatalogAtom: (key: K) => Atom.AtomResultFn<void, void>;
}

/** Catalogs per key, each asked for with `ask`. */
export const catalogLookup = <K, E>(
  ask: (key: K, get: Atom.FnContext) => Effect.Effect<Catalog, E, RegistryClient>,
): CatalogLookup<K> => {
  const heldAtom = Atom.family((_key: K) =>
    Atom.make<Held>({ catalog: null, asking: false, nextAt: 0 }),
  );

  return {
    catalogAtom: Atom.family((key: K) => Atom.map(heldAtom(key), (held) => held.catalog)),
    askCatalogAtom: Atom.family((key: K) =>
      appRuntime.fn(
        (_: void, get) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const held = get(heldAtom(key));

            if (held.asking || now < held.nextAt) return;

            const settle = (change: (held: Held) => Held) =>
              Effect.sync(() => {
                get.set(heldAtom(key), change(get(heldAtom(key))));
              });

            yield* settle((before) => ({ ...before, asking: true }));

            const answer = yield* ask(key, get).pipe(
              Effect.exit,
              // Stopped (nothing reads the catalog any more): the next composer may ask at once.
              Effect.onInterrupt(() => settle((before) => ({ ...before, asking: false }))),
            );

            const at = yield* Clock.currentTimeMillis;

            yield* settle((before) =>
              Exit.isSuccess(answer)
                ? { catalog: answer.value, asking: false, nextAt: at + CATALOG_TTL_MS }
                : { ...before, asking: false, nextAt: at + CATALOG_RETRY_MS },
            );
          }),
        { concurrent: true },
      ),
    ),
  };
};

/** The conversations' catalogs, asked of their Session. */
export const { catalogAtom, askCatalogAtom } = catalogLookup((key: ConversationKey, get) =>
  get
    .result(sessionClientAtom(key.sessionId))
    .pipe(Effect.flatMap((client) => client.catalog(key.conversationId))),
);
