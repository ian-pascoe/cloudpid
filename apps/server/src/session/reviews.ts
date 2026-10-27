// Reviews (`docs/spec.md` → Diffs and review → Annotations and Reviews): the owner's drafts sent as one message, through
// the composer's own `submit` (with `annotations`, the drafts' IDs). The Session takes the drafts, refuses the send when
// one is gone, checks those on the Changes a last time, renders the Markdown the model gets after the summary, and places
// the message; the drafts are deleted once it is taken, and come back when Stop withdraws it before it was placed. It
// also checks the drafts on the Changes after each listing, and drops the drafts addressed to a deleted subagent.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- plain storage reads under Effect.sync, and pi-durable's Promise calls.
import type {
  Annotation,
  AnnotationDraft,
  ChangeFile,
  Comparison,
  RepoChanges,
} from "@cloudpid/protocol";
import { renderReview, resolvePath, WORKSPACE_ROOT } from "@cloudpid/protocol";
import { Harness } from "@cloudpid/effect-durable";
import { SubagentsDoc } from "@cloudpid/extensions/subagents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type SubmissionId,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Types from "effect/Types";
import {
  type AnnotationStorage,
  AnnotationStore,
  type AnnotationStoreService,
} from "./annotations.ts";
import { SessionChanges } from "./changes.ts";
import { SessionComparisons } from "./comparisons.ts";
import { attempt, SessionError } from "./errors.ts";
import { type Prompt, SessionHost } from "./host.ts";
import {
  checked,
  checkQuote,
  comparedFile,
  listedFile,
  type QuoteCheck,
  sideLines,
} from "./outdated.ts";

const context = BACKGROUND_CONTEXT;

/** Why a Review was refused: a draft it names is gone, or goes elsewhere (another client sent or deleted it). */
export const DRAFTS_CHANGED = "Your drafts changed: check them and send again";

/** The Reviews not yet placed, by submission: kept until each settles, so a withdrawn one's drafts come back. */
const PENDING_KEY = "cloudpid:reviews-pending";

/** The IDs of the drafts a pending Review sent. */
const sentKey = (submissionId: number) => `cloudpid:review:${submissionId}`;

/** One draft a pending Review sent, as it was sent: one key a draft, as the drafts themselves are kept. */
const sentDraftKey = (submissionId: number, id: string) => `cloudpid:review:${submissionId}:${id}`;

/** The submissions recent Reviews became, by `requestId`, so a Review sent again finds the first. */
const REQUESTS_KEY = "cloudpid:review-requests";

/** How many `requestId`s are kept. */
const KEPT_REQUESTS = 50;

/** How many files a check reads at once. */
const CHECK_READS = 4;

/**
 * A draft's file as a check finds it: not to be judged (`unknown`), no longer listed (`gone`), or read by `read`, with how
 * a quote's check settles the draft (`after`).
 */
type Located =
  | { readonly kind: "unknown" }
  | { readonly kind: "gone" }
  | {
      readonly kind: "file";
      readonly read: Effect.Effect<ChangeFile, SessionError>;
      readonly after: (before: Annotation, result: QuoteCheck) => Annotation;
    };

/** A Review as `submit` sends it: the summary, and the IDs of the drafts it sends. */
export type ReviewPrompt = Omit<Prompt, "review"> & { readonly annotations: ReadonlyArray<string> };

export type SessionReviewsService = {
  /** Send drafts `annotations` with the summary `input` as one Review, and answer its submission ID. */
  readonly submit: (prompt: ReviewPrompt) => Effect.Effect<number, SessionError>;
  /**
   * Save `draft` (`AnnotationStore.save`), a Call diff's path made absolute first: the model may have given its call a
   * path relative to the directory its conversation works in.
   */
  readonly save: (draft: AnnotationDraft) => Effect.Effect<void, SessionError>;
  /** Delete the drafts addressed to a subagent that no longer exists. */
  readonly prune: Effect.Effect<void>;
  /**
   * A Comparison of a repo's branch was made for a client (a new head, or a refresh that moved the merge-base): check the
   * drafts on This branch against its pair, and move those that pass to it. A Comparison that is marked `behind` is the
   * last one made, not the head's, and changes nothing.
   */
  readonly compared: (comparison: Comparison) => Effect.Effect<void>;
};

/** The Session's Reviews. */
export class SessionReviews extends Context.Service<SessionReviews, SessionReviewsService>()(
  "@cloudpid/server/session/reviews/SessionReviews",
) {}

/** A submission's ID as the host answers it. */
// SAFETY: the host's submission IDs are pi-durable's, which it hands out as numbers.
const asSubmission = (id: number): SubmissionId => id as SubmissionId;

/** Whether `draft` goes to a conversation that exists: the active branch, or a subagent the Subagents document lists. */
const addressedToLive =
  (conversations: Readonly<Record<string, string>>) =>
  (draft: Annotation): boolean =>
    draft.conversationId === undefined || conversations[String(draft.conversationId)] !== undefined;

/** The Session's Reviews over its storage; build it once per instance. */
export const sessionReviewsLayer = (
  storage: AnnotationStorage,
): Layer.Layer<
  SessionReviews,
  never,
  SessionHost | SessionChanges | SessionComparisons | AnnotationStore | Harness
> =>
  Layer.effect(
    SessionReviews,
    Effect.gen(function* () {
      const host = yield* SessionHost;
      const changes = yield* SessionChanges;
      const comparisons = yield* SessionComparisons;
      const store = yield* AnnotationStore;
      const harness = yield* Harness;
      const scope = yield* Effect.scope;
      const run = Effect.runForkWith(yield* Effect.context<never>());
      // One check at a time, the last one before a send included, so two never write over each other.
      const checking = Semaphore.withPermit(Semaphore.makeUnsafe(1));
      // One Review at a time, so two clients sending the same drafts send them once.
      const sending = Semaphore.withPermit(Semaphore.makeUnsafe(1));

      const pending = (): number[] => storage.get<number[]>(PENDING_KEY) ?? [];

      const requests = (): Record<string, number> =>
        storage.get<Record<string, number>>(REQUESTS_KEY) ?? {};

      /**
       * What a check finds of `drafts`, grouped by file (`groupOf`, undefined for a draft that is not being checked): each
       * file is found by `locate` and read once, for every draft on it; one that cannot be read leaves its drafts as they
       * are. Each draft it changes is answered, before and after.
       */
      const checkFiles = (
        drafts: ReadonlyArray<Annotation>,
        groupOf: (draft: Annotation) => string | undefined,
        locate: (first: Annotation) => Located,
      ) => {
        const files = new Map<string, Annotation[]>();

        for (const draft of drafts) {
          const key = groupOf(draft);

          if (key !== undefined) files.set(key, [...(files.get(key) ?? []), draft]);
        }

        return Effect.forEach(
          files.values(),
          (onFile) => {
            const [first] = onFile;

            if (first === undefined) return Effect.succeed([]);

            const located = locate(first);

            if (located.kind === "unknown") return Effect.succeed([]);

            if (located.kind === "gone") {
              return Effect.succeed(
                onFile.map((before) => ({
                  before,
                  after: checked(before, { kind: "gone" }, null),
                })),
              );
            }

            return located.read.pipe(
              Effect.map((file) =>
                onFile.flatMap((before) => {
                  const lines = sideLines(before, file);

                  return lines === undefined
                    ? []
                    : [{ before, after: located.after(before, checkQuote(before, lines)) }];
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("Reading a file to check its drafts failed", error).pipe(
                  Effect.as([]),
                ),
              ),
            );
          },
          { concurrency: CHECK_READS },
        ).pipe(Effect.map((found) => found.flat()));
      };

      /** What a check finds of `drafts` (those on the Changes) against `repos`: each one it changes, before and after. */
      const findings = (drafts: ReadonlyArray<Annotation>, repos: ReadonlyArray<RepoChanges>) =>
        checkFiles(
          drafts,
          (draft) =>
            draft.source.kind === "changes" ? `${draft.source.repo}\u0000${draft.path}` : undefined,
          (first): Located => {
            const listed = listedFile(first, repos);

            if (listed.kind !== "file") return listed;

            const at = { repo: listed.repo.repo, path: listed.entry.path };

            return {
              kind: "file",
              // The Session's own Workspace's Changes: the drafts are the Session page's.
              read: changes.file(
                undefined,
                listed.entry.oldPath === undefined ? at : { ...at, oldPath: listed.entry.oldPath },
              ),
              after: (before, result) => checked(before, result, listed.repo.head.commit),
            };
          },
        );

      /**
       * What a check finds of the drafts `onRepo` (on This branch of one repo) against `comparison`: the ones written
       * against another pair of commits, each read once in the new pair's file. They move to the pair when their quote holds,
       * and are marked when it does not; a file the Comparison no longer lists marks them gone.
       */
      const againstComparison = (comparison: Comparison, onRepo: ReadonlyArray<Annotation>) => {
        // A list marked `behind` is the last one made, for a head the repo has left: it says nothing of the new one. Nor
        // does one of a pull request that is closed or merged: it is the last result kept, marked.
        if (
          comparison.behind !== undefined ||
          (comparison.pull !== undefined && comparison.pull.state !== "open")
        ) {
          return Effect.succeed([]);
        }

        return checkFiles(
          onRepo,
          (draft) =>
            (draft.source.kind === "branch" || draft.source.kind === "pull") &&
            (draft.source.mergeBase !== comparison.mergeBase ||
              draft.source.head !== comparison.head)
              ? draft.path
              : undefined,
          (first): Located => {
            const compared = comparedFile(first, comparison);

            if (compared.kind !== "file") return compared;

            const { entry } = compared;

            const at = {
              repo: comparison.repo,
              mergeBase: comparison.mergeBase,
              head: comparison.head,
              path: entry.path,
            };

            return {
              kind: "file",
              read: comparisons.file(
                entry.oldPath === undefined ? at : { ...at, oldPath: entry.oldPath },
              ),
              after: (before, result) => checked(before, result, null, comparison),
            };
          },
        );
      };

      /**
       * The HEAD of each repo whose Comparison the drafts were last checked against, or that failed, so a listing of the
       * Changes does not make the same Comparison again (and run the Container's command again) for a HEAD it has seen.
       */
      const comparedAt = new Map<string, string>();

      /**
       * What a check finds of the drafts on This branch: for each repo with some, its Comparison as the Workspace has it now
       * (made again if the Container runs, else the last one, which changes nothing); never starting the Container.
       */
      const branchFindings = (
        drafts: ReadonlyArray<Annotation>,
        repos: ReadonlyArray<RepoChanges>,
      ) => {
        const byRepo = new Map<string, Annotation[]>();

        for (const draft of drafts) {
          if (draft.source.kind !== "branch") continue;

          byRepo.set(draft.source.repo, [...(byRepo.get(draft.source.repo) ?? []), draft]);
        }

        return Effect.forEach(
          byRepo,
          ([repo, onRepo]) =>
            Effect.gen(function* () {
              const head = repos.find((each) => each.repo === repo)?.head.commit ?? null;

              // What this repo's drafts are written against, with its HEAD: a check that has seen both has nothing new.
              const pairs = new Set(
                onRepo.flatMap((draft) =>
                  draft.source.kind === "branch"
                    ? [`${draft.source.mergeBase}:${draft.source.head}`]
                    : [],
                ),
              );

              const seen = [head ?? "", ...pairs].join(" ");

              if (comparedAt.get(repo) === seen) return [];

              const made = yield* comparisons
                .compare({ repo, startContainer: false, fetch: false })
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Comparing to check the drafts failed", error).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );

              // Only a Comparison the Container made, or one that failed for good, is remembered: a stopped Container
              // answers the last list, and the next check may find it running.
              if (made === undefined || made.status === "error") {
                if (made === undefined || made.error.kind !== "needs_container")
                  comparedAt.set(repo, seen);

                return [];
              }

              if (made.comparison.behind === undefined) comparedAt.set(repo, seen);

              return yield* againstComparison(made.comparison, onRepo);
            }),
          { concurrency: 1 },
        ).pipe(Effect.map((found) => found.flat()));
      };

      /** Check `drafts` against `repos` and put what was found in place, under the one permit; answer what was found. */
      const checkAndKeep = (drafts: ReadonlyArray<Annotation>, repos: ReadonlyArray<RepoChanges>) =>
        Effect.all([findings(drafts, repos), branchFindings(drafts, repos)]).pipe(
          Effect.map(([onChanges, onBranch]) => [...onChanges, ...onBranch]),
          Effect.tap((found) => store.checked(found)),
          checking,
        );

      /**
       * A Comparison was made for a client: check the drafts on its repo's branch against it, or on its pull request (the
       * same repo and number).
       */
      const compared = (comparison: Comparison) =>
        store.list.pipe(
          Effect.flatMap((drafts) =>
            againstComparison(
              comparison,
              drafts.filter(({ source }) =>
                comparison.pull === undefined
                  ? source.kind === "branch" && source.repo === comparison.repo
                  : source.kind === "pull" &&
                    source.repo === comparison.repo &&
                    source.number === comparison.pull.number,
              ),
            ),
          ),
          Effect.tap((found) => store.checked(found)),
          checking,
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("Checking the drafts failed", cause)),
        );

      const check = (repos: ReadonlyArray<RepoChanges>) =>
        store.list.pipe(Effect.flatMap((drafts) => checkAndKeep(drafts, repos)));

      /** Which drafts go to a conversation that still exists, as the Subagents document says now. */
      const live = attempt("subagents", () => harness.harness.snapshot(SubagentsDoc, context)).pipe(
        Effect.map((state) => addressedToLive(state?.conversations ?? {})),
      );

      // After each listing of the Changes, in the background: the clients see the drafts move or marked.
      const stop = changes.observe((list) => {
        run(
          check(list.repos).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Checking the drafts failed", cause)),
          ),
        );
      });

      yield* Effect.addFinalizer(() => Effect.sync(stop));

      /** Forget pending Review `submissionId`, bringing its drafts back when it was withdrawn before it was placed. */
      const settleOne = (submissionId: number) =>
        attempt("submission", async () => {
          const submission = await harness.harness.submission(asSubmission(submissionId), context);

          return submission === undefined ? undefined : await submission.status(context);
        }).pipe(
          Effect.flatMap((record) => {
            if (record?.status === "queued") return Effect.void;

            const ids = storage.get<string[]>(sentKey(submissionId)) ?? [];

            const sent = ids.flatMap((id) => {
              const draft = storage.get<Annotation>(sentDraftKey(submissionId, id));

              return draft === undefined ? [] : [draft];
            });

            const withdrawn = record?.status === "unanswered" && record.entry === undefined;

            // Only those that still go somewhere: a subagent deleted while its Review waited takes its drafts with it.
            const restored = withdrawn
              ? live.pipe(Effect.flatMap((keep) => store.restore(sent.filter(keep))))
              : Effect.void;

            return restored.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  for (const id of ids) storage.delete(sentDraftKey(submissionId, id));
                  storage.delete(sentKey(submissionId));
                  storage.put(
                    PENDING_KEY,
                    pending().filter((id) => id !== submissionId),
                  );
                }),
              ),
            );
          }),
        );

      /** Once Review `submissionId` settles (placed, answered or withdrawn), settle it here too. */
      const followUp = (submissionId: number) =>
        attempt("submission", async () => {
          const submission = await harness.harness.submission(asSubmission(submissionId), context);

          if (submission !== undefined) await submission.wait(context);
        }).pipe(
          Effect.andThen(settleOne(submissionId)),
          Effect.catchCause((cause) => Effect.logWarning("Following a Review failed", cause)),
          Effect.forkIn(scope),
          Effect.asVoid,
        );

      const refused = (message: string) => SessionError.make({ operation: "review", message });

      const submit = (prompt: ReviewPrompt) =>
        Effect.gen(function* () {
          const { annotations: ids, ...rest } = prompt;

          // Sent again (a client that saw no answer): the Session finds the first, whose drafts are gone by now.
          const known = rest.requestId === undefined ? undefined : requests()[rest.requestId];

          if (known !== undefined) return yield* host.submit(rest);

          const drafts = yield* store.take(ids);

          if (drafts === undefined) return yield* refused(DRAFTS_CHANGED);

          // The drafts go where the Review does: the active branch's, or this subagent's.
          const active = yield* host.activeBranch;

          const targetOf = (id: number | undefined) =>
            id === undefined || id === active ? undefined : id;

          if (
            drafts.some((draft) => targetOf(draft.conversationId) !== targetOf(rest.conversationId))
          ) {
            return yield* refused(DRAFTS_CHANGED);
          }

          // The last check, against the files as they are now (and This branch's Comparison, as the Workspace has it).
          const onChanges = drafts.some((draft) => draft.source.kind !== "call");
          const listed = onChanges ? yield* changes.fresh : undefined;
          const found = yield* checkAndKeep(drafts, listed?.repos ?? []);

          const final = drafts.map(
            (draft) => found.find(({ before }) => before.id === draft.id)?.after ?? draft,
          );

          // A send that fails after the message is placed leaves the drafts: sent again with its `requestId`, as the
          // composer does, the host finds the first submission rather than placing a second.
          const submissionId = yield* host.submit({ ...rest, review: renderReview(final) });

          // What follows is written at once, with no wait between: the drafts it sent (one key each, as the drafts are),
          // the Review pending until it settles, and its `requestId`.
          yield* Effect.sync(() => {
            for (const draft of final) storage.put(sentDraftKey(submissionId, draft.id), draft);
            storage.put(
              sentKey(submissionId),
              final.map((draft) => draft.id),
            );
            storage.put(PENDING_KEY, [...pending(), submissionId]);

            if (rest.requestId !== undefined) {
              const kept = Object.entries({ ...requests(), [rest.requestId]: submissionId }).slice(
                -KEPT_REQUESTS,
              );

              storage.put(REQUESTS_KEY, Object.fromEntries(kept));
            }
          });

          // Deleted as taken: one saved again while the Review was sent keeps its new text.
          yield* store.removeSent(drafts);
          yield* followUp(submissionId);

          return submissionId;
        }).pipe(sending);

      const prune = live.pipe(
        Effect.flatMap((keep) => store.prune(keep)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Dropping a deleted subagent's drafts failed", cause),
        ),
      );

      // Reviews an eviction left pending: settled once they settle.
      yield* Effect.forEach(pending(), followUp, { discard: true });

      const save = (draft: AnnotationDraft) =>
        Effect.gen(function* () {
          const { source } = draft;

          const relative =
            source.kind === "call" &&
            (!draft.path.startsWith("/") ||
              (draft.oldPath !== undefined && !draft.oldPath.startsWith("/")));

          if (!relative) return yield* store.save(draft);

          // A conversation not yet given a Workspace works at its root, as a Session does at first.
          const cwd = (yield* host.directory(source.conversationId)) ?? WORKSPACE_ROOT;

          const resolved: Types.Mutable<AnnotationDraft> = {
            ...draft,
            path: resolvePath(cwd, draft.path),
          };

          if (draft.oldPath !== undefined) resolved.oldPath = resolvePath(cwd, draft.oldPath);

          return yield* store.save(resolved);
        });

      return { submit, save, prune, compared } satisfies SessionReviewsService;
    }),
  );

/**
 * An extension that deletes the drafts addressed to a subagent once `subagent_delete` has deleted it: the drafts on its
 * Call diffs, which went to it. Install it after the extension that brings the tool.
 */
export const annotationsPruningTools = (
  tools: ReadonlyArray<ToolRegistration>,
  store: Pick<AnnotationStoreService, "prune">,
): Extension =>
  defineExtension({
    name: "annotations",
    wraps: tools.flatMap((tool) =>
      tool.name === "subagent_delete"
        ? [
            wrapTool(tool, (wrapped) => ({
              ...wrapped,
              execute: async (args, api, context) => {
                try {
                  return await wrapped.execute(args, api, context);
                } finally {
                  const state = await Effect.runPromise(
                    attempt("subagents", () => api.snapshot(SubagentsDoc, context)).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          "Reading the subagents to drop a deleted one's drafts failed",
                          cause,
                        ).pipe(Effect.as(undefined)),
                      ),
                    ),
                  );

                  if (state !== undefined) {
                    await Effect.runPromise(store.prune(addressedToLive(state.conversations)));
                  }
                }
              },
            })),
          ]
        : [],
    ),
  });
