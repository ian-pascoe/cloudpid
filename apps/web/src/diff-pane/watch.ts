// The Changes the Session's page watches while it is open (`docs/spec.md` → Diffs and review → Diff pane): their totals,
// read by the Session details, the New pane and the Diff pane, and a new listing asked for each time the owner
// comes back to the page (`page-return.ts`).

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { changesAtom, sessionClientAtom } from "../session/atoms.ts";
import { changesTotals } from "./changes.ts";
import { browserPage, refreshOnReturn } from "./page-return.ts";

/** The totals of Session `sessionId`'s Changes; reading them keeps the Changes watched. */
export const changesTotalsAtom = Atom.family((sessionId: string) =>
  Atom.make((get) => changesTotals(get(changesAtom(sessionId))?.repos ?? [])),
);

/** While mounted, Session `sessionId`'s Changes are listed again each time the owner comes back to the page. */
export const changesOnReturnAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) =>
          refreshOnReturn(browserPage, Effect.ignore(client.refreshChanges(false))),
        ),
      ),
  ),
);
