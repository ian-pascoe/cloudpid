// Leaving the page of a Session that is gone: its socket closed saying the Session was deleted, here or on another
// device (`sessionGoneAtom` says which).

import * as Atom from "effect/reactivity/Atom";
import { sessionGoneAtom } from "../app-state.ts";
import { sessionStatusAtom } from "../session/atoms.ts";

/** While read, leaves Session `sessionId`'s page with a notice once its status turns `deleted`. */
export const leaveWhenDeletedAtom = Atom.family((sessionId: string) =>
  Atom.readable((get) => {
    get.mount(sessionGoneAtom);
    get.mount(sessionStatusAtom(sessionId));
    // Immediate: a status that was already `deleted` when the page first read this counts too.
    get.subscribe(
      sessionStatusAtom(sessionId),
      (status) => {
        if (status === "deleted") get.set(sessionGoneAtom, sessionId);
      },
      { immediate: true },
    );
  }),
);
