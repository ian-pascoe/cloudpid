// @effect-diagnostics asyncFunction:off -- the commit callbacks are pi-durable Promise code, as the Harness's own are.
// The Session tree's moves over the Session's open Harness (GLOSSARY.md → Session tree, ADR-0017): which Session branch
// is active, the tree a client shows, `/tree`'s navigation and the chevrons' switch, and stopping every branch. What the
// tree is made of, in plain functions over pi-durable's records, is `tree.ts`'s.
import { stopConversation } from "@cloudpid/extensions/subagents";
import type { BranchSummaryRequest, Navigated, SessionTree, TreePoint } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, Usage } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AgentDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness as PiHarness,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { summarizeBranch, summaryMessage } from "./branch-summary.ts";
import { attempt, refuse, type SessionError } from "./errors.ts";
import { copyAgent } from "./fork.ts";
import {
  abandonedEntries,
  activateBranch,
  BRANCH_SUMMARY_KIND,
  type BranchEntries,
  branchIds,
  buildSessionTree,
  EMPTY_TREE,
  ownerMessageText,
  planNavigation,
  SessionTreeDoc,
  type SessionTreeState,
  tipOf,
} from "./tree.ts";

const context = BACKGROUND_CONTEXT;

/** How many entries a Session branch's read takes at a time. */
const BRANCH_PAGE = 500;

/** Where `/tree` goes: a point of the Session tree, with a summary of the branch left or none. */
export type NavigateRequest = TreePoint & { readonly summary?: BranchSummaryRequest };

/** What the Session tree's moves take from the Session host. */
export type BranchesOptions = {
  readonly harness: PiHarness;
  /** The root conversation, created when absent. */
  readonly root: Effect.Effect<Conversation, SessionError>;
  readonly models: Models;
  /** The agent the active branch runs with: a branch summary is made with its model. */
  readonly wanted: () => AgentChange;
  /** Count a branch summary's usage in the Session's spend: no conversation's ledger holds it. */
  readonly onUsage: (usage: Usage) => void;
  /** The conversations whose `/compact` waits for their Run to end. */
  readonly pendingCompactions: () => Readonly<Record<string, string>>;
  /** Why the Session cannot move now (it is still being filled as a Fork or Clone), if it cannot. */
  readonly refusal: () => string | undefined;
  /** Runs `effect` in turn with the owner's messages, so none lands on a branch being left. */
  readonly inArrivalOrder: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/** The Session tree's moves, and the reads the Session host shares with them. */
export const sessionBranches = (options: BranchesOptions) => {
  const { harness, root, inArrivalOrder } = options;

  /** The Session tree as the Session keeps it: the root conversation active until a branch is made. */
  const treeState = attempt("snapshot", () => harness.snapshot(SessionTreeDoc, context)).pipe(
    Effect.map((state): SessionTreeState => state ?? EMPTY_TREE),
  );

  /** The active branch's conversation (GLOSSARY.md → Session branch); the root is created when absent. */
  const active = root.pipe(
    Effect.andThen(treeState),
    Effect.flatMap(({ active: id }) =>
      id === ROOT_CONVERSATION_ID
        ? root
        : attempt("conversation", () =>
            // SAFETY: a conversation ID `activateBranch` wrote.
            harness.conversation(id as ConversationId, context),
          ).pipe(Effect.filterOrElse(Predicate.isNotUndefined, () => root)),
    ),
  );

  /** Why `conversation` cannot leave its place in the Session tree now, or nothing when it can. */
  const busyReason = (conversation: Conversation) =>
    Effect.all([
      attempt("snapshot", () => harness.snapshot(LiveDoc, conversation.id, context)),
      attempt("snapshot", () => harness.snapshot(InboxDoc, conversation.id, context)),
    ]).pipe(
      Effect.map(([live, inbox]): string | undefined => {
        if (live?.run !== undefined) return "a Run is in progress";

        if ((live?.compactions?.length ?? 0) > 0) return "the context is being compacted";

        if ((inbox?.items.length ?? 0) > 0) return "messages wait to be placed";

        if (options.pendingCompactions()[String(conversation.id)] !== undefined) {
          return "a /compact waits for the Run to end";
        }

        return undefined;
      }),
    );

  /** Fail with why the active branch cannot be left now, if it cannot. */
  const refuseWhileBusy = (conversation: Conversation) =>
    busyReason(conversation).pipe(
      Effect.flatMap((reason) =>
        reason === undefined
          ? Effect.void
          : Effect.fail(
              refuse(
                `The Session tree cannot be navigated while ${reason}: stop it or wait for it to end.`,
              ),
            ),
      ),
    );

  /** Every entry of `conversation`'s own after `after` (none: from its start), oldest first. */
  const entriesAfter = (conversation: Conversation, after: EntryId | undefined) =>
    Effect.gen(function* () {
      const all: EntryRecord[] = [];
      let cursor: Cursor | undefined;

      do {
        const page = yield* attempt("entries", () =>
          conversation.entries(
            after === undefined
              ? { order: "ascending" }
              : // SAFETY: the entry after `after`, which is in the Session's ID space.
                { order: "ascending", minEntryId: (after + 1) as EntryId },
            BRANCH_PAGE,
            cursor,
            context,
          ),
        );

        all.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);

      return all;
    });

  /** Each Session branch with its own entries: those after the entry it was forked at. */
  const readBranches = (state: SessionTreeState) =>
    Effect.forEach(branchIds(state), (id) =>
      attempt("conversation", () => harness.conversation(id, context)).pipe(
        Effect.flatMap((conversation) =>
          conversation === undefined
            ? Effect.succeed<BranchEntries[]>([])
            : attempt("conversation", () =>
                harness.commit((tx) => tx.conversation(id), context),
              ).pipe(
                Effect.flatMap((record) =>
                  entriesAfter(conversation, record?.parent?.at).pipe(
                    Effect.map((entries): BranchEntries[] => [
                      record?.parent === undefined
                        ? { id, entries }
                        : { id, parent: record.parent, entries },
                    ]),
                  ),
                ),
              ),
        ),
      ),
    ).pipe(Effect.map(Arr.flatten));

  const tree: Effect.Effect<SessionTree, SessionError> = Effect.gen(function* () {
    yield* root;

    const state = yield* treeState;

    return buildSessionTree(yield* readBranches(state), state);
  });

  /** The branch summary `request` asks for of the branch being left, `abandoned`; none when it asks for none. */
  const summaryOf = (
    abandoned: ReadonlyArray<EntryRecord>,
    request: BranchSummaryRequest | undefined,
  ) =>
    Effect.gen(function* () {
      if (request === undefined || abandoned.length === 0) return undefined;

      const model = options.wanted().model ?? null;

      if (model === null)
        return yield* refuse("There is no model to summarize the Session branch with.");

      return yield* summarizeBranch(
        options.models,
        model,
        abandoned,
        request.instructions,
        options.onUsage,
      ).pipe(Effect.mapError((error) => refuse(error.message)));
    });

  /**
   * `/tree`: move the active branch to the point `request` names, forking or switching as `planNavigation` says, with a
   * summary of the branch left when asked. Messages wait meanwhile, so none lands on the branch being left.
   */
  const navigate = (request: NavigateRequest) =>
    Effect.gen(function* () {
      const refusal = options.refusal();

      if (refusal !== undefined) return yield* refuse(refusal);

      const current = yield* active;

      yield* refuseWhileBusy(current);

      const state = yield* treeState;
      const branches = yield* readBranches(state);
      const plan = planNavigation(branches, state, request);

      if ("refused" in plan) return yield* refuse(plan.refused);

      const entry = Arr.findFirst(
        Arr.flatMap(branches, (branch) => branch.entries),
        (each) => each.id === request.entryId,
      );

      const text =
        request.position === "before" && Option.isSome(entry)
          ? ownerMessageText(entry.value)
          : null;

      if (plan.kind === "switch" && plan.conversationId === current.id) {
        return { conversationId: current.id, text } satisfies Navigated;
      }

      const point = Match.value(plan).pipe(
        Match.discriminatorsExhaustive("kind")({
          switch: ({ conversationId }) =>
            Option.match(
              Arr.findFirst(branches, (branch) => branch.id === conversationId),
              { onNone: () => null, onSome: tipOf },
            ),
          fork: ({ at }): number | null => at,
          fresh: () => null,
        }),
      );

      const summary = yield* summaryOf(
        request.summary === undefined ? [] : abandonedEntries(branches, current.id, point),
        request.summary,
      );

      // Before the Session's first message the new branch has no entry to take its agent from: it takes the one of the
      // branch left. Read as a snapshot: a transaction's document is a tracking proxy, which `structuredClone` refuses.
      const agent =
        plan.kind === "fresh"
          ? yield* attempt("snapshot", () => harness.snapshot(AgentDoc, current.id, context))
          : undefined;

      const now = yield* Clock.currentTimeMillis;

      const target = yield* attempt("navigate", () =>
        harness.commit(async (tx) => {
          const ownerless = { ownership: { kind: "ownerless" } } as const;
          let id: ConversationId;

          if (plan.kind === "switch") {
            id = plan.conversationId;
          } else if (plan.kind === "fork") {
            id = (await tx.forkConversation(plan.from, plan.at, ownerless)).id;
          } else {
            // Before the Session's first message: a branch of no entries, with the agent of the branch left.
            id = (await tx.createConversation(ownerless)).id;

            if (agent !== undefined) copyAgent(await tx.doc(AgentDoc, id), agent);
          }

          if (summary !== undefined) {
            await tx.appendEntry(id, {
              kind: BRANCH_SUMMARY_KIND,
              model: [summaryMessage(summary, now)],
              data: { notice: "Branch summary" },
            });
          }

          await activateBranch(tx, id, now);

          return id;
        }, context),
      );

      return { conversationId: target, text } satisfies Navigated;
    }).pipe(inArrivalOrder);

  /** Make Session branch `conversationId` the active branch as it stands (the chevrons). */
  const switchBranch = (conversationId: ConversationId) =>
    Effect.gen(function* () {
      const current = yield* active;

      if (current.id === conversationId) return;

      yield* refuseWhileBusy(current);

      if (!Arr.contains(branchIds(yield* treeState), conversationId)) {
        return yield* refuse(`Conversation ${conversationId} is not a Session branch.`);
      }

      const now = yield* Clock.currentTimeMillis;

      yield* attempt("switchBranch", () =>
        harness.commit((tx) => activateBranch(tx, conversationId, now), context),
      );
    }).pipe(inArrivalOrder);

  /** Stop every Session branch, and every subagent below the active one's (all of them). */
  const stopEverything = Effect.gen(function* () {
    const current = yield* active;

    yield* attempt("abort", () =>
      stopConversation(harness, current.id, { subagents: true }, context),
    );

    for (const id of branchIds(yield* treeState)) {
      if (id === current.id) continue;

      yield* attempt("abort", async () => {
        await (await harness.conversation(id, context))?.abort(context);
      });
    }
  });

  return { treeState, active, busyReason, tree, navigate, switchBranch, stopEverything };
};
