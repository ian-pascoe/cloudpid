// One Diff pane's state as atoms (ADR-0011), made when the Pane mounts (a `ScopedAtom`) and gone when it unmounts: what
// the owner folded and where the Pane is held (`pane-ui.ts`), with a place asked for from elsewhere (`diffTargetAtom`)
// taken in; the source it shows (the Changes, or a repo's This branch) and, for This branch, its Comparison; its files;
// the owner's Refresh; and the list asked for again as it opens. What loads the files' contents is in the Pane's lazy
// chunk (`view-atoms.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a constructor of a Pane's atoms, not a combinator.

import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import type {
  BranchSource,
  Comparison,
  ComparisonError,
  LastRun,
  PullSource,
  RepoChanges,
  RunDiff,
} from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { messageOf } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { changesAtom, lastRunAtom, sessionClientAtom, viewedAtom } from "../session/atoms.ts";
import type { ConversationKey } from "../session/conversation-key.ts";
import type { SessionCommandError } from "../session/client.ts";
import {
  branchSourceOf,
  CHANGES_SOURCE,
  comparisonRepos,
  type PaneSource,
  pullSourceOf,
  RUN_SOURCE,
} from "./branch.ts";
import { changesTotals, type ChangesTotals } from "./changes.ts";
import { foldedFiles, paneFilesOf, type PaneFile, viewedFileIds } from "./pane-files.ts";
import {
  INITIAL_PANE_UI,
  reducePaneUi,
  withTarget,
  type PaneUi,
  type PaneUiAction,
} from "./pane-ui.ts";
import { browserPage, refreshOnReturn } from "./page-return.ts";
import { type DiffTarget, diffTargetAtom } from "./target.ts";

/**
 * Where the Comparison of the repo This branch shows (or of its pull request `pull`) stands: asked for, being made, the
 * Container being started for it, made, not made for a reason (an error state), or not asked for at all (a failure of the
 * request itself).
 */
export type BranchView =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly repo: string; readonly pull?: number | undefined }
  | { readonly kind: "starting"; readonly repo: string; readonly pull?: number | undefined }
  | { readonly kind: "ready"; readonly comparison: Comparison }
  | {
      readonly kind: "error";
      readonly repo: string;
      readonly pull?: number | undefined;
      readonly error: ComparisonError;
    }
  | {
      readonly kind: "failed";
      readonly repo: string;
      readonly pull?: number | undefined;
      readonly message: string;
    };

/** Whether `comparison` is the one `repo` and `pull` (a pull request's number, else This branch) name. */
export const isComparisonOf = (
  comparison: Comparison,
  repo: string,
  pull: number | undefined,
): boolean => comparison.repo === repo && comparison.pull?.number === pull;

/**
 * Where the Run diff the Pane shows when it shows the Last run stands: asked for, made (`diff` null: no Run has written
 * files), or not asked for at all (a failure of the request itself). `listing` counts the lists made, so a live Run's files
 * load again with each.
 */
export type RunView =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly diff: RunDiff | null; readonly listing: number }
  | { readonly kind: "failed"; readonly message: string };

/** What the Pane draws its files from: the Changes' repos, the one repo of a Comparison, or the Last run's repos. */
export interface PaneList {
  readonly repos: readonly RepoChanges[];
  /** The Last run, when the Pane shows it and has its Run diff. */
  readonly run: LastRun | undefined;
  /** The Comparison, when the Pane shows This branch and has it. */
  readonly comparison: Comparison | undefined;
  /** The source drafts on the Comparison's files are written against. */
  readonly branch: BranchSource | PullSource | undefined;
  /** How many lists the Pane has had from the Changes: a Comparison's files are fixed by its commits, so it has none. */
  readonly listing: number;
}

/** What `compare` is asked: a repo's Comparison, by the owner's own action (which may start the Container) or not. */
export interface CompareAsk {
  readonly repo: string;
  /** The pull request's number; without it, the repo's This branch. */
  readonly pull?: number | undefined;
  /** The owner's pick or Refresh: a stopped Container may be started for it. */
  readonly manual: boolean;
  /** Fetch the base again (the header's Refresh). */
  readonly fetch: boolean;
}

const NO_REPOS: readonly RepoChanges[] = [];

/** The Last run of a page that has none: a Subagent page's. */
const NO_LAST_RUN = Atom.make<LastRun | null>(null);

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
  /**
   * The picker opened: lists the repos and their open pull requests again (the Workspace asks GitHub once per 60 s per
   * repo, however often this is asked).
   */
  readonly pickerOpened: Atom.Writable<number, void>;
  /** What is typed in the picker's filter box over the pull requests. */
  readonly pullFilter: Atom.Writable<string>;
  /** Mounted while the Pane is: when the owner comes back to the page, the pull requests are listed again and the shown one is checked for a new head. */
  readonly returned: Atom.Atom<AsyncResult.AsyncResult<void>>;
  /** The IDs of the shown files whose Viewed box is ticked (pull request Comparisons only). */
  readonly viewed: Atom.Atom<ReadonlySet<string>>;
  /** Tick or untick a Viewed box; the Session then tells every client. */
  readonly setViewed: Atom.Writable<
    AsyncResult.AsyncResult<void, SessionCommandError>,
    {
      readonly repo: string;
      readonly pull: number;
      readonly path: string;
      readonly blob: string | null;
    }
  >;
  /** The Comparison of the repo This branch shows. */
  readonly branchView: Atom.Atom<BranchView>;
  /** The Session's Last run, as the Session last said; null when no Run has written. */
  readonly lastRun: Atom.Atom<LastRun | null>;
  /** The Run diff the Last run shows. */
  readonly runView: Atom.Atom<RunView>;
  /** Ask the Session for the Run diff again (never starting the Container). */
  readonly loadRun: Atom.Writable<AsyncResult.AsyncResult<void, SessionCommandError>, void>;
  /** Mounted while the Pane is: asks for the Run diff as the Pane shows it, and again as the Run moves. */
  readonly followingRun: Atom.Atom<AsyncResult.AsyncResult<void>>;
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

  // The Last run is the Session's: a Subagent page's Pane shows another Workspace's Changes, and has none.
  const askedSource = (asked: DiffTarget): PaneSource =>
    asked.source === "run" && conversationId === undefined ? RUN_SOURCE : CHANGES_SOURCE;

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
        ctx.set(chosen, askedSource(asked));
      }
    },
  );

  const source = Atom.writable(
    (get): PaneSource => {
      const asked = get(target);

      if (asked === null) return get(chosen);

      return askedSource(asked);
    },
    (ctx, next: PaneSource) => {
      ctx.set(chosen, next);
    },
  );

  // The repos' HEADs as the Changes know them: a primitive, so what reads it runs only when a commit or a branch moved,
  // not at every listing of the Changes.
  const heads = Atom.make((get): string =>
    (get(changesAtom(changes))?.repos ?? NO_REPOS)
      .map(({ repo, head }) => [repo, head.commit ?? "", head.branch ?? ""].join("\u0000"))
      .join("\n"),
  );

  // How many times the picker was opened (or the page came back): each lists the repos and pull requests again, which the
  // Workspace keeps 60 s per repo.
  const opens = Atom.make(0);
  const pullFilter = Atom.make("");

  const pickerOpened = Atom.writable(
    (get) => get(opens),
    (ctx) => {
      ctx.set(opens, ctx.get(opens) + 1);
    },
  );

  const sources = appRuntime.atom((get) => {
    // A Subagent page's Pane shows its subagent's Workspace, which This branch and the pull requests do not cover (the
    // Session's Workspace makes the Comparisons): it lists no repo for it.
    // Nor does opening the picker ask.
    if (conversationId !== undefined) return Effect.succeed({ repos: [] });

    // Asked again as a repo's HEAD moves: a commit changes it, and a repo's branch is named by it.
    get(heads);

    get(opens);

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.comparisonSources({ pulls: true })));
  });

  const branchView = Atom.make<BranchView>({ kind: "idle" });

  // How many of the owner's own compares (a pick, a Refresh) run: a count, since one interrupted by the next ends after
  // the next began. Kept alive, and written through the registry rather than the fn's context: a new call disposes the
  // old call's context before it interrupts the old fiber, and a disposed context drops writes, which would leave the
  // count above zero and the Pane never following the HEAD again.
  const manualRunning = Atom.make(0).pipe(Atom.keepAlive);

  const compare = appRuntime.fn((ask: CompareAsk, get) => {
    const count = (change: number) =>
      Effect.flatMap(Effect.service(AtomRegistry.AtomRegistry), (registry) =>
        Effect.sync(() => {
          if (ask.manual) registry.update(manualRunning, (running) => running + change);
        }),
      );

    const made = Effect.gen(function* () {
      const client = yield* get.result(sessionClientAtom(sessionId));
      const before = get(branchView);

      // What was shown stays while the next is made, unless it is another repo's or another pull request's.
      if (!(before.kind === "ready" && isComparisonOf(before.comparison, ask.repo, ask.pull))) {
        get.set(branchView, { kind: "loading", repo: ask.repo, pull: ask.pull });
      }

      let result = yield* client.compare({ repo: ask.repo, pull: ask.pull, fetch: ask.fetch });

      // Only the owner's own action starts a stopped Container: when it needed it, or when the list it was answered is
      // the last one made, for a HEAD the repo has left ("New commits": Refresh).
      if (
        ask.manual &&
        ((result.status === "error" && result.error.kind === "needs_container") ||
          (result.status === "ok" && result.comparison.behind !== undefined))
      ) {
        get.set(branchView, { kind: "starting", repo: ask.repo, pull: ask.pull });
        result = yield* client.compare({
          repo: ask.repo,
          pull: ask.pull,
          startContainer: true,
          fetch: ask.fetch,
        });
      }

      get.set(
        branchView,
        result.status === "ok"
          ? { kind: "ready", comparison: result.comparison }
          : { kind: "error", repo: ask.repo, pull: ask.pull, error: result.error },
      );
    }).pipe(
      // A request that supersedes this one interrupts it: that is not a failure.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() => {
            get.set(branchView, {
              kind: "failed",
              repo: ask.repo,
              pull: ask.pull,
              message: messageOf(cause),
            });
          }),
      ),
    );

    return Effect.acquireUseRelease(
      count(1),
      () => made,
      () => count(-1),
    );
  });

  // The shown repo's HEAD as the Changes know it: a primitive, so what reads it runs only when the HEAD moves.
  const shownHead = Atom.make((get): string | null => {
    const shown = get(source);

    if (shown.kind !== "branch") return null;

    return (
      get(changesAtom(changes))?.repos.find(({ repo }) => repo === shown.repo)?.head.commit ?? null
    );
  });

  const following = appRuntime.atom((get) => {
    const shown = get(source);
    const head = get(shownHead);
    const view = get.once(branchView);

    // Not while the owner's own compare (a Refresh that fetches) runs: it would interrupt it. When that ends this runs
    // again, and follows the HEAD if it moved meanwhile.
    if (get(manualRunning) > 0) return Effect.void;

    if (
      shown.kind === "branch" &&
      head !== null &&
      view.kind === "ready" &&
      isComparisonOf(view.comparison, shown.repo, undefined) &&
      head !== view.comparison.head &&
      head !== view.comparison.behind
    ) {
      get.set(compare, { repo: shown.repo, manual: false, fetch: false });
    }

    return Effect.void;
  });

  // The owner comes back to the page: the pull requests are listed again, and the pull request on show is asked for its
  // head (never starting the Container), so a push brings "New commits: Refresh".
  const returned = appRuntime.atom(() =>
    Effect.gen(function* () {
      const registry = yield* Effect.service(AtomRegistry.AtomRegistry);

      yield* refreshOnReturn(
        browserPage,
        Effect.sync(() => {
          registry.set(opens, registry.get(opens) + 1);

          const shown = registry.get(source);
          const view = registry.get(branchView);

          if (
            shown.kind === "pull" &&
            view.kind === "ready" &&
            isComparisonOf(view.comparison, shown.repo, shown.number) &&
            view.comparison.pull?.state === "open" &&
            registry.get(manualRunning) === 0
          ) {
            registry.set(compare, {
              repo: shown.repo,
              pull: shown.number,
              manual: false,
              fetch: false,
            });
          }
        }),
      );
    }),
  );

  const lastRun = conversationId === undefined ? lastRunAtom(sessionId) : NO_LAST_RUN;
  const runView = Atom.make<RunView>({ kind: "idle" });

  const loadRun = appRuntime.fn((_: void, get) =>
    Effect.gen(function* () {
      const client = yield* get.result(sessionClientAtom(sessionId));
      const before = get(runView);

      // What was shown stays while the next is made.
      if (before.kind !== "ready") get.set(runView, { kind: "loading" });

      const diff = yield* client.runDiff;
      const now = get(runView);

      get.set(runView, {
        kind: "ready",
        diff,
        listing: (now.kind === "ready" ? now.listing : 0) + 1,
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() => {
            get.set(runView, { kind: "failed", message: messageOf(cause) });
          }),
      ),
    ),
  );

  // The Changes' lists, counted only while the Run is live: an ended Run's diff never changes.
  const liveListing = Atom.make((get): number =>
    get(lastRun)?.endedAt === null ? (get(changesAtom(changes))?.listing ?? 0) : 0,
  );

  const followingRun = appRuntime.atom((get) => {
    const shown = get(source);

    if (shown.kind !== "run") return Effect.void;

    // Asked again as the Run starts, copies or ends, and as a live Run's files change. The ask is mounted here, so its
    // writes land whatever else reads it.
    get(lastRun);
    get(liveListing);
    get.mount(loadRun);
    get.set(loadRun, undefined);

    return Effect.void;
  });

  const list = Atom.make((get): PaneList => {
    const shown = get(source);

    if (shown.kind === "run") {
      const view = get(runView);
      const run = get(lastRun);

      if (
        view.kind !== "ready" ||
        view.diff === null ||
        run === null ||
        view.diff.run !== run.run
      ) {
        return { repos: [], run: undefined, comparison: undefined, branch: undefined, listing: 0 };
      }

      return {
        repos: view.diff.repos,
        run,
        comparison: undefined,
        branch: undefined,
        listing: view.diff.live ? view.listing : 0,
      };
    }

    if (shown.kind === "changes") {
      const listed = get(changesAtom(changes));
      const only = shown.repo;

      return {
        repos:
          only === undefined
            ? (listed?.repos ?? NO_REPOS)
            : (listed?.repos ?? NO_REPOS).filter(({ repo }) => repo === only),
        run: undefined,
        comparison: undefined,
        branch: undefined,
        listing: listed?.listing ?? 0,
      };
    }

    const view = get(branchView);

    if (
      view.kind !== "ready" ||
      !isComparisonOf(view.comparison, shown.repo, shown.kind === "pull" ? shown.number : undefined)
    ) {
      return { repos: [], run: undefined, comparison: undefined, branch: undefined, listing: 0 };
    }

    return {
      repos: comparisonRepos(view.comparison),
      run: undefined,
      comparison: view.comparison,
      branch: pullSourceOf(view.comparison) ?? branchSourceOf(view.comparison),
      listing: 0,
    };
  });

  const files = Atom.make((get) => {
    const { repos, branch, run } = get(list);

    return paneFilesOf(repos, branch, run);
  });

  const totals = Atom.make((get) => changesTotals(get(list).repos));
  const viewed = Atom.make((get) => viewedFileIds(get(files), get(viewedAtom(sessionId))));
  const folded = Atom.make((get) => foldedFiles(get(files), get(ui).overrides, get(viewed)));

  const setViewed = appRuntime.fn(
    (box: { repo: string; pull: number; path: string; blob: string | null }, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.setViewed(box))),
  );

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
    pickerOpened,
    pullFilter,
    returned,
    viewed,
    setViewed,
    branchView,
    lastRun,
    runView,
    loadRun,
    followingRun,
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
