// What the owner does to a Session from the list or its page, as promises a button awaits: each resolves to null when it
// worked, or to why it did not, for the surface it was asked on to show.

import { useAtomSet } from "@effect/atom-react";
import type { SessionRecord } from "@cloudpid/protocol";
import * as Exit from "effect/Exit";
import { useMemo } from "react";
import { exitFailure } from "./registry.ts";
import {
  archiveSessionAtom,
  createSessionAtom,
  deleteSessionAtom,
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
  readonly delete: (id: string) => Promise<string | null>;
}

export const useSessionActions = (): SessionActions => {
  const create = useAtomSet(createSessionAtom, { mode: "promiseExit" });
  const rename = useAtomSet(renameSessionAtom, { mode: "promiseExit" });
  const archive = useAtomSet(archiveSessionAtom, { mode: "promiseExit" });
  const unarchive = useAtomSet(unarchiveSessionAtom, { mode: "promiseExit" });
  const remove = useAtomSet(deleteSessionAtom, { mode: "promiseExit" });

  return useMemo(
    () => ({
      create: (where = {}) =>
        create(where).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
      rename: (id, title) => rename({ id, title }).then(exitFailure),
      archive: (id) => archive(id).then(exitFailure),
      unarchive: (id) => unarchive(id).then(exitFailure),
      delete: (id) => remove(id).then(exitFailure),
    }),
    [create, rename, archive, unarchive, remove],
  );
};
