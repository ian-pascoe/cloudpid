// One Diff pane's state as atoms (ADR-0011), made when the Pane mounts (a `ScopedAtom`) and gone when it unmounts: what
// the owner folded and where the Pane is held (`pane-ui.ts`), with a place asked for from elsewhere (`diffTargetAtom`)
// taken in; the source it shows (the Changes, or a repo's This branch) and, for This branch, its Comparison; its files;
// the owner's Refresh; and the list asked for again as it opens. What loads the files' contents is in the Pane's lazy
// chunk (`view-atoms.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a constructor of a Pane's atoms, not a combinator.

import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import type { BranchSource, Comparison, ComparisonError, RepoChanges } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { messageOf } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { changesAtom, sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "../session/conversation-key.ts";
import type { SessionCommandError } from "../session/client.ts";
import { branchSourceOf, CHANGES_SOURCE, comparisonRepos, type PaneSource } from "./branch.ts";
import { changesTotals, type ChangesTotals } from "./changes.ts";
import { foldedFiles, paneFilesOf, type PaneFile } from "./pane-files.ts";
import {
  INITIAL_PANE_UI,
  reducePaneUi,
  withTarget,
  type PaneUi,
  type PaneUiAction,
} from "./pane-ui.ts";
import { diffTargetAtom } from "./target.ts";

/**
 * Where the Comparison of the repo This branch shows stands: asked for, being made, the Container being started for it, made,
 * not made for a reason (an error state), or not asked for at all (a failure of the request itself).
 */
export type BranchView =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly repo: string }
  | { readonly kind: "starting"; readonly repo: string }
  | { readonly kind: "ready"; readonly comparison: Comparison }
  | { readonly kind: "error"; readonly repo: string; readonly error: ComparisonError }
  | { readonly kind: "failed"; readonly repo: string; readonly message: string };

/** What the Pane draws its files from: the Changes' repos, or the one repo of a Comparison. */
export interface PaneList {
  readonly repos: readonly RepoChanges[];
  /** The Comparison, when the Pane shows This branch and has it. */
  readonly comparison: Comparison | undefined;
  /** The source drafts on the Comparison's files are written against. */
  readonly branch: BranchSource | undefined;
  /** How many lists the Pane has had from the Changes: a Comparison's files are fixed by its commits, so it has none. */
  readonly listing: number;
}

/** What `compare` is asked: a repo's Comparison, by the owner's own action (which may start the Container) or not. */
export interface CompareAsk {
  readonly repo: string;
  /** The owner's pick or Refresh: a stopped Container may be started for it. */
  readonly manual: boolean;
  /** Fetch the base again (the header's Refresh). */
  readonly fetch: boolean;
}

const NO_REPOS: readonly RepoChanges[] = [];

/** The atoms of one Diff pane. */
export interface PaneAtoms {
  /** The Changes it shows: the Session's on its page, a subagent conversation's on a Subagent page. */
  readonly changes: ConversationKey;
  /** What the owner folded and where the Pane is held; a place asked for (`diffTargetAtom`) is taken in. */
  readonly ui: Atom.Writable<PaneUi, PaneUiAction>;
  /** The source shown. A place asked for from elsewhere (a Call diff's file) is in the Changes. */
  readonly source: Atom.Writable<PaneSource, PaneSource>;
  /** The repos the picker lists, each with its HEAD; null until the Session answers. */
  readonly sources: Atom.Atom<
    AsyncResult.AsyncResult<import("@cloudpid/protocol").ComparisonSources, SessionCommandError>
  >;
  /** The Comparison of the repo This branch shows. */
  readonly branchView: Atom.Atom<BranchView>;
  /** Make the Comparison of a repo; the owner's pick or Refresh may start the Container for it. */
  readonly compare: Atom.Writable<AsyncResult.AsyncResult<void, SessionCommandError>, CompareAsk>;
  /** Mounted while the Pane is: compares again when the shown repo's HEAD moved (never starting the Container). */
  readonly following: Atom.Atom<AsyncResult.AsyncResult<void>>;
  readonly list: Atom.Atom<PaneList>;
  readonly files: Atom.Atom<readonly PaneFile[]>;
  readonly totals: Atom.Atom<ChangesTotals>;
  readonly folded: Atom.Atom<ReadonlySet<string>>;
  /** Mounted while the Pane is: it asks the Session to list the Changes again as the Pane opens. */
  readonly opened: Atom.Atom<AsyncResult.AsyncResult<void>>;
  /** The owner's Refresh: lists the Changes again, starting the Container if a repo needs it. */
  readonly refresh: Atom.Writable<AsyncResult.AsyncResult<void, SessionCommandError>, void>;
}

/** The atoms of a Diff pane on the Changes `changes` names. */
export const paneAtomsOf = (changes: ConversationKey): PaneAtoms => {
  const { sessionId, conversationId } = changes;
  const target = diffTargetAtom(changes);
  const own = Atom.make<PaneUi>(INITIAL_PANE_UI);
  const chosen = Atom.make<PaneSource>(CHANGES_SOURCE);

  const ui = Atom.writable(
    (get): PaneUi => {
      const asked = get(target);

      return asked === null ? get(own) : withTarget(get(own), asked);
    },
    (ctx, action: PaneUiAction) => {
      const asked = ctx.get(target);
      const mine = ctx.get(own);

      ctx.set(own, reducePaneUi(asked === null ? mine : withTarget(mine, asked), action));

      if (asked !== null) {
        ctx.set(target, null);
        ctx.set(chosen, CHANGES_SOURCE);
      }
    },
  );

  const source = Atom.writable(
    (get): PaneSource => (get(target) === null ? get(chosen) : CHANGES_SOURCE),
    (ctx, next: PaneSource) => {
      ctx.set(chosen, next);
    },
  );

  const sources = appRuntime.atom((get) => {
    // A Subagent page's Pane shows its subagent's Workspace, which This branch does not cover (the Session's Workspace
    // makes the Comparisons): it lists no repo for it.
    if (conversationId !== undefined) return Effect.succeed({ repos: [] });

    // Asked again as the Changes are listed: a commit moves a repo's HEAD, and a repo's branch is named by it.
    get(changesAtom(changes));

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.comparisonSources));
  });

  const branchView = Atom.make<BranchView>({ kind: "idle" });

  const compare = appRuntime.fn((ask: CompareAsk, get) =>
    Effect.gen(function* () {
      const client = yield* get.result(sessionClientAtom(sessionId));
      const before = get(branchView);

      // What was shown stays while the next is made, unless it is another repo's.
      if (!(before.kind === "ready" && before.comparison.repo === ask.repo)) {
        get.set(branchView, { kind: "loading", repo: ask.repo });
      }

      let result = yield* client.compare({ repo: ask.repo, fetch: ask.fetch });

      // Only the owner's own action starts a stopped Container.
      if (ask.manual && result.status === "error" && result.error.kind === "needs_container") {
        get.set(branchView, { kind: "starting", repo: ask.repo });
        result = yield* client.compare({ repo: ask.repo, startContainer: true, fetch: ask.fetch });
      }

      get.set(
        branchView,
        result.status === "ok"
          ? { kind: "ready", comparison: result.comparison }
          : { kind: "error", repo: ask.repo, error: result.error },
      );
    }).pipe(
      // A request that supersedes this one interrupts it: that is not a failure.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() => {
            get.set(branchView, { kind: "failed", repo: ask.repo, message: messageOf(cause) });
          }),
      ),
    ),
  );

  // The shown repo's HEAD as the Changes know it: a primitive, so what reads it runs only when the HEAD moves.
  const shownHead = Atom.make((get): string | null => {
    const shown = get(source);

    if (shown.kind !== "branch") return null;

    return (
      get(changesAtom(changes))?.repos.find(({ repo }) => repo === shown.repo)?.head.commit ??
      null
    );
  });

  const following = appRuntime.atom((get) => {
    const shown = get(source);
    const head = get(shownHead);
    const view = get.once(branchView);

    if (
      shown.kind === "branch" &&
      head !== null &&
      view.kind === "ready" &&
      view.comparison.repo === shown.repo &&
      head !== view.comparison.head &&
      head !== view.comparison.behind
    ) {
      get.set(compare, { repo: shown.repo, manual: false, fetch: false });
    }

    return Effect.void;
  });

  const list = Atom.make((get): PaneList => {
    const shown = get(source);

    if (shown.kind === "changes") {
      const listed = get(changesAtom(changes));
      const only = shown.repo;

      return {
        repos:
          only === undefined
            ? (listed?.repos ?? NO_REPOS)
            : (listed?.repos ?? NO_REPOS).filter(({ repo }) => repo === only),
        comparison: undefined,
        branch: undefined,
        listing: listed?.listing ?? 0,
      };
    }

    const view = get(branchView);

    if (view.kind !== "ready" || view.comparison.repo !== shown.repo) {
      return { repos: [], comparison: undefined, branch: undefined, listing: 0 };
    }

    return {
      repos: comparisonRepos(view.comparison),
      comparison: view.comparison,
      branch: branchSourceOf(view.comparison),
      listing: 0,
    };
  });

  const files = Atom.make((get) => {
    const { repos, branch } = get(list);

    return paneFilesOf(repos, branch);
  });

  const totals = Atom.make((get) => changesTotals(get(list).repos));
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

  return {
    changes,
    ui,
    source,
    sources,
    branchView,
    compare,
    following,
    list,
    files,
    totals,
    folded,
    opened,
    refresh,
  };
};

/** The atoms of the Diff pane mounted here; its provider takes the key of the Changes it shows. */
export const DiffPaneScope = ScopedAtom.make((changes: ConversationKey) =>
  Atom.make(paneAtomsOf(changes)),
);
