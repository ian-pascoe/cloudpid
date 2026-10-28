// This branch on the Session socket (docs/architecture/diffs-and-review.md → Comparisons): the Session's Workspace serves the
// picker's repos, a repo's Comparison and a file's two sides, and the Session passes each on to the client that asked.
// These are request commands, not a watch: a Comparison is fixed once its SHAs are. Only a `compare` that says so
// (`startContainer`, the owner's pick or Refresh) may start a stopped Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import type { ChangeFile, CompareResult, ComparisonSources } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SessionError } from "./errors.ts";

/** What `compare` asks of the Workspace: a repo's Comparison, the Container started only when `startContainer`. */
export type CompareQuery = {
  readonly repo: string;
  /** Compare this open pull request instead of the branch. */
  readonly pull?: number | undefined;
  readonly startContainer: boolean;
  readonly fetch: boolean;
};

/** One file of a Comparison: `path` in `repo` between the merge-base and the head, and a rename's old path. */
export type ComparisonFileQuery = {
  readonly repo: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly path: string;
  readonly oldPath?: string;
};

/** Where Comparisons come from: the Session's Workspace, in the directory the Session works in. */
export type ComparisonsSource = {
  /** The picker's repos, with their open pull requests when `pulls`; null with no Workspace. */
  readonly sources: (pulls: boolean) => Promise<ComparisonSources | null>;
  readonly compare: (query: CompareQuery) => Promise<CompareResult>;
  readonly file: (query: ComparisonFileQuery) => Promise<ChangeFile>;
};

export type SessionComparisonsService = {
  /** The repos the picker lists, each with its HEAD (and open pull requests, with `pulls`); none with no Workspace. */
  readonly sources: (pulls: boolean) => Effect.Effect<ComparisonSources, SessionError>;
  /** A repo's This branch Comparison, or why there is none (an error result is an answer, not a failure). */
  readonly compare: (query: CompareQuery) => Effect.Effect<CompareResult, SessionError>;
  /** One file's two sides. It never starts the Container. */
  readonly file: (query: ComparisonFileQuery) => Effect.Effect<ChangeFile, SessionError>;
};

/** The Session's Comparisons. */
export class SessionComparisons extends Context.Service<
  SessionComparisons,
  SessionComparisonsService
>()("@cloudpid/server/session/comparisons/SessionComparisons") {}

const failed =
  (operation: string) =>
  (cause: unknown): SessionError =>
    SessionError.make({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });

/** The Session's Comparisons over `source`. */
export const sessionComparisonsLayer = (
  source: ComparisonsSource,
): Layer.Layer<SessionComparisons> =>
  Layer.succeed(SessionComparisons, {
    sources: (pulls) =>
      Effect.tryPromise({
        try: async () => (await source.sources(pulls)) ?? { repos: [] },
        catch: failed("comparisonSources"),
      }),
    compare: (query) =>
      Effect.tryPromise({ try: () => source.compare(query), catch: failed("compare") }),
    file: (query) =>
      Effect.tryPromise({ try: () => source.file(query), catch: failed("comparisonFile") }),
  });
