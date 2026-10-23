// The Session tree, Forks and Clones as atoms (GLOSSARY.md → Session tree, Fork, Clone): the tree the Session sends,
// asked again whenever it may have changed; moving the active branch, with the summary prompt the settings may skip;
// and making a Fork or Clone, which then opens with the owner's message in its composer.

import { NEW_WORKSPACE, SAME_WORKSPACE, type BranchSummaryRequest } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { replying } from "../calls.ts";
import { changing, RegistryClient } from "../registry.ts";
import { pathAtom, sessionPath } from "../router.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom, sessionStateAtom } from "../session/atoms.ts";
import { settingsStateAtom } from "../settings.ts";

/**
 * What the Session tree is asked again after: the active branch changing or a branch made, a message added or answered
 * on the active branch, a Run starting or ending, a new socket.
 */
const treeStaleAtom = Atom.family((sessionId: string) =>
  Atom.map(
    sessionStateAtom(sessionId),
    (state) =>
      `${state.treeVersion}|${state.activeBranch}|${state.view.messages.length}|${state.view.running}|${state.status}`,
  ),
);

/** Session `sessionId`'s tree, asked for while something reads it, and again whenever it may have changed. */
export const sessionTreeAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) => {
    get(treeStaleAtom(sessionId));

    return get.result(sessionClientAtom(sessionId)).pipe(Effect.flatMap((client) => client.tree));
  }),
);

/**
 * Text for a Session's root composer, by Session id: the owner's message the active branch moved to before, or a Fork was made before. The
 * composer takes it, before what was typed, as it opens or at once if it is open.
 */
export const composerPrefillAtom = Atom.make<Readonly<Record<string, string>>>({}).pipe(
  Atom.keepAlive,
);

/** Put `text` in Session `sessionId`'s root composer. */
const prefill = (get: Atom.FnContext, sessionId: string, text: string | null) => {
  if (text === null || text.trim() === "") return;

  get.set(composerPrefillAtom, { ...get(composerPrefillAtom), [sessionId]: text });
};

/** Whether the settings say not to ask for a summary when a branch is left (`branchSummary.skipPrompt`). */
export const skipSummaryPromptAtom = Atom.map(
  settingsStateAtom,
  (state) => state?.settings.branchSummary.skipPrompt ?? false,
);

/** A point of the Session tree: just before an owner's message, or just after an entry. */
export interface TreePoint {
  readonly entryId: number;
  readonly position: "before" | "at";
}

/** Where to move the active branch, with what summary of the branch left. */
export interface TreeMove extends TreePoint {
  readonly summary?: BranchSummaryRequest | undefined;
}

/**
 * Move Session `sessionId`'s active branch (`/tree`, the Branch button); an owner's message it was moved before goes back in the
 * composer. Fails with why the Session refused it.
 */
export const navigateAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    replying(({ entryId, position, summary }: TreeMove, get: Atom.FnContext) =>
      get.result(sessionClientAtom(sessionId)).pipe(
        Effect.flatMap((client) => client.navigate(entryId, position, summary)),
        Effect.tap((navigated) =>
          Effect.sync(() => {
            prefill(get, sessionId, navigated.text);
          }),
        ),
      ),
    ),
    { concurrent: true },
  ),
);

/** Make a Session branch the active one as it stands: the chevrons. */
export const switchBranchAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    replying((conversationId: number, get: Atom.FnContext) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.switchBranch(conversationId))),
    ),
    { concurrent: true },
  ),
);

/** A Fork (from a point) or a Clone (none) of a Session, in its Workspace or a new one on `branch`. */
export interface ForkRequest {
  readonly source: string;
  readonly point?: TreePoint | undefined;
  readonly newWorkspace?: boolean | undefined;
  readonly branch?: string | undefined;
}

/** What `forkSession` is sent: a key is left out rather than undefined. */
interface ForkSessionPayload {
  source: string;
  entryId?: number;
  position?: TreePoint["position"];
  workspace: typeof SAME_WORKSPACE | typeof NEW_WORKSPACE;
  branch?: string;
}

/**
 * Make a Fork or Clone and open it, with the owner's message it was made before in its composer; the lists ask again.
 * Fails with the Registry's reason, and then nothing was made.
 */
export const forkSessionAtom = appRuntime.fn(
  replying(({ source, point, newWorkspace = false, branch }: ForkRequest, get: Atom.FnContext) => {
    const request: ForkSessionPayload = {
      source,
      workspace: newWorkspace ? NEW_WORKSPACE : SAME_WORKSPACE,
    };

    const named = branch?.trim() ?? "";

    if (point !== undefined) {
      request.entryId = point.entryId;
      request.position = point.position;
    }

    if (newWorkspace && named !== "") request.branch = named;

    return RegistryClient.use((registry) => registry("forkSession", request)).pipe(
      Effect.tap((forked) =>
        Effect.sync(() => {
          prefill(get, forked.session.id, forked.text);
          get.set(pathAtom, sessionPath(forked.session.id));
        }),
      ),
      changing(["sessions", "workspaces"]),
    );
  }),
  { concurrent: true },
);

/** A move waiting for the owner to say whether to carry a summary of the branch left. */
export interface PendingMove extends TreePoint {
  readonly sessionId: string;
}

/** The move the summary dialog asks about, or null. */
export const pendingMoveAtom = Atom.make<PendingMove | null>(null);

/** A Fork or Clone in a new Workspace waiting for the owner to name its branch, or null. */
export const pendingForkAtom = Atom.make<Omit<ForkRequest, "newWorkspace" | "branch"> | null>(null);

/** `/fork` without a message: the picker of the owner's messages is open, for a Fork here or in a new Workspace. */
export const forkPickerAtom = Atom.make<{ readonly newWorkspace: boolean } | null>(null);

/** Whether a Fork or Clone is being made: the Registry answers once the new Session is filled, so one at a time. */
export const forkingAtom = Atom.make(false);
