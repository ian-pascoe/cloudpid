// The Changes a Session's page, or a Subagent page, watches while it is open (`docs/spec.md` → Diffs and review → Diff
// pane): their totals, read by the Session details, the New pane and the Diff pane, and a new listing asked for each
// time the owner comes back to the page (`page-return.ts`). Each is kept by the Changes' key (`conversation-key.ts`).

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { changesAtom, sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "../session/conversation-key.ts";
import { changesTotals } from "./changes.ts";
import { browserPage, refreshOnReturn } from "./page-return.ts";

/** The totals of the Changes `key` names; reading them keeps the Changes watched. */
export const changesTotalsAtom = Atom.family((key: ConversationKey) =>
  Atom.make((get) => changesTotals(get(changesAtom(key))?.repos ?? [])),
);

/** While mounted, the Changes `key` names are listed again each time the owner comes back to the page. */
export const changesOnReturnAtom = Atom.family(({ sessionId, conversationId }: ConversationKey) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) =>
          refreshOnReturn(browserPage, Effect.ignore(client.refreshChanges(false, conversationId))),
        ),
      ),
  ),
);
