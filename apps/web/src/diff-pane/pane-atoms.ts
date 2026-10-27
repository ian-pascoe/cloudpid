// One Diff pane's state as atoms (ADR-0011), made when the Pane mounts (a `ScopedAtom`) and gone when it unmounts: what
// the owner folded and where the Pane is held (`pane-ui.ts`), with a place asked for from elsewhere (`diffTargetAtom`)
// taken in; its files; the owner's Refresh; and the list asked for again as it opens. What loads the files' contents is
// in the Pane's lazy chunk (`view-atoms.ts`).
// @effect-diagnostics missingPipeableSignature:off -- a constructor of a Pane's atoms, not a combinator.

import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { changesAtom, sessionClientAtom } from "../session/atoms.ts";
import type { ChangesKey } from "../session/changes-key.ts";
import type { SessionCommandError } from "../session/client.ts";
import { foldedFiles, paneFilesOf, type PaneFile } from "./pane-files.ts";
import {
  INITIAL_PANE_UI,
  reducePaneUi,
  withTarget,
  type PaneUi,
  type PaneUiAction,
} from "./pane-ui.ts";
import { diffTargetAtom } from "./target.ts";

/** The atoms of one Diff pane. */
export interface PaneAtoms {
  /** The Changes it shows: the Session's on its page, a subagent conversation's on a Subagent page. */
  readonly changes: ChangesKey;
  /** What the owner folded and where the Pane is held; a place asked for (`diffTargetAtom`) is taken in. */
  readonly ui: Atom.Writable<PaneUi, PaneUiAction>;
  readonly files: Atom.Atom<readonly PaneFile[]>;
  readonly folded: Atom.Atom<ReadonlySet<string>>;
  /** Mounted while the Pane is: it asks the Session to list the Changes again as the Pane opens. */
  readonly opened: Atom.Atom<AsyncResult.AsyncResult<void>>;
  /** The owner's Refresh: lists the Changes again, starting the Container if a repo needs it. */
  readonly refresh: Atom.Writable<AsyncResult.AsyncResult<void, SessionCommandError>, void>;
}

/** The atoms of a Diff pane on the Changes `changes` names. */
export const paneAtomsOf = (changes: ChangesKey): PaneAtoms => {
  const { sessionId, conversationId } = changes;
  const target = diffTargetAtom(changes);
  const own = Atom.make<PaneUi>(INITIAL_PANE_UI);

  const ui = Atom.writable(
    (get): PaneUi => {
      const asked = get(target);

      return asked === null ? get(own) : withTarget(get(own), asked);
    },
    (ctx, action: PaneUiAction) => {
      const asked = ctx.get(target);
      const mine = ctx.get(own);

      ctx.set(own, reducePaneUi(asked === null ? mine : withTarget(mine, asked), action));

      if (asked !== null) ctx.set(target, null);
    },
  );

  const files = Atom.make((get) => paneFilesOf(get(changesAtom(changes))?.repos ?? []));
  const folded = Atom.make((get) => foldedFiles(get(files), get(ui).overrides));

  // Opening the Pane lists the Changes again (never starting the Container).
  const opened = appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) => Effect.ignore(client.refreshChanges(false, conversationId))),
      ),
  );

  const refresh = appRuntime.fn((_: void, get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.refreshChanges(true, conversationId))),
  );

  return { changes, ui, files, folded, opened, refresh };
};

/** The atoms of the Diff pane mounted here; its provider takes the key of the Changes it shows. */
export const DiffPaneScope = ScopedAtom.make((changes: ChangesKey) =>
  Atom.make(paneAtomsOf(changes)),
);
