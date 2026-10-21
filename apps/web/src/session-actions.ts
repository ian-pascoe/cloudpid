// What the owner does to a Session from a surface that shows its failure itself, as promises that surface awaits: each
// resolves to null when it worked, or to why it did not. An archive or unarchive also reports to the surface's `problem`.

import { useAtomSet } from "@effect/atom-react";
import type { SessionRecord } from "@cloudpid/protocol";
import * as Exit from "effect/Exit";
import type * as Atom from "effect/reactivity/Atom";
import { exitFailure } from "./registry.ts";
import {
  archiveSessionAtom,
  createSessionAtom,
  renameSessionAtom,
  type SessionPlace,
  unarchiveSessionAtom,
} from "./sessions.ts";

export interface SessionActions {
  /** Register a new Session; resolves to it, or undefined when that failed. */
  readonly create: (where?: SessionPlace) => Promise<SessionRecord | undefined>;
  readonly rename: (id: string, title: string) => Promise<string | null>;
  readonly archive: (id: string) => Promise<string | null>;
  readonly unarchive: (id: string) => Promise<string | null>;
}

/**
 * The actions of a surface whose `problem` is the failure of its last archive or unarchive: it is cleared as one starts
 * and set to why it failed, if it did.
 */
export const useSessionActions = (problem: Atom.Writable<string | null>): SessionActions => {
  const setProblem = useAtomSet(problem);
  const create = useAtomSet(createSessionAtom, { mode: "promiseExit" });
  const rename = useAtomSet(renameSessionAtom, { mode: "promiseExit" });
  const archive = useAtomSet(archiveSessionAtom, { mode: "promiseExit" });
  const unarchive = useAtomSet(unarchiveSessionAtom, { mode: "promiseExit" });

  const shown = (action: (id: string) => Promise<Exit.Exit<unknown, unknown>>) => (id: string) => {
    setProblem(null);

    return action(id).then((exit) => {
      const failure = exitFailure(exit);

      setProblem(failure);

      return failure;
    });
  };

  return {
    create: (where = {}) =>
      create(where).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
    rename: (id, title) => rename({ id, title }).then(exitFailure),
    archive: shown(archive),
    unarchive: shown(unarchive),
  };
};
