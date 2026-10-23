// What the owner does to a Session from a surface that shows its failure itself, as promises that surface awaits: each
// resolves to null when it worked, or to why it did not. A new Session, an archive or an unarchive also reports to the
// surface's `problem`.

import { useAtomSet } from "@effect/atom-react";
import type * as Exit from "effect/Exit";
import type * as Atom from "effect/reactivity/Atom";
import { useCall } from "./calls.ts";
import { exitFailure } from "./registry.ts";
import {
  archiveSessionAtom,
  createSessionAtom,
  renameSessionAtom,
  type SessionPlace,
  unarchiveSessionAtom,
} from "./sessions.ts";

export interface SessionActions {
  /** Register a new Session and open it. */
  readonly create: (where?: SessionPlace) => Promise<string | null>;
  readonly rename: (id: string, title: string) => Promise<string | null>;
  readonly archive: (id: string) => Promise<string | null>;
  readonly unarchive: (id: string) => Promise<string | null>;
}

/**
 * The actions of a surface whose `problem` is the failure of its last new Session, archive or unarchive: it is cleared
 * as one starts and set to why it failed (the Registry's message), if it did.
 */
export const useSessionActions = (problem: Atom.Writable<string | null>): SessionActions => {
  const setProblem = useAtomSet(problem);
  const create = useCall(createSessionAtom);
  const rename = useCall(renameSessionAtom);
  const archive = useCall(archiveSessionAtom);
  const unarchive = useCall(unarchiveSessionAtom);

  const shown =
    <Arg>(action: (arg: Arg) => Promise<Exit.Exit<unknown, unknown>>) =>
    (arg: Arg) => {
      setProblem(null);

      return action(arg).then((exit) => {
        const failure = exitFailure(exit);

        setProblem(failure);

        return failure;
      });
    };

  return {
    create: (where = {}) => shown(create)(where),
    rename: (id, title) => rename({ id, title }).then(exitFailure),
    archive: shown(archive),
    unarchive: shown(unarchive),
  };
};
