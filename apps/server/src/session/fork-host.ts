// @effect-diagnostics asyncFunction:off -- the commit callbacks are pi-durable Promise code, as the Harness's own are.
// Forks and Clones over the Session's open Harness (GLOSSARY.md → Fork, Clone; ADR-0017): the source's side, which
// answers what a Fork carries and its entries a page at a time, and the new Session's, which appends them and takes
// the rest. The main Worker drives both (`fillSession`). What is copied, in plain functions, is `fork.ts`'s.
import { ContextDoc } from "@cloudpid/extensions/context";
import { TodoDoc } from "@cloudpid/extensions/todo";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type HarnessInspection,
  type Harness as PiHarness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { attempt, refuse, type SessionError } from "./errors.ts";
import {
  copiedDraft,
  copyAgent,
  EXPORT_PAGE_ENTRIES,
  type ExportRequest,
  exportPage,
  type ForkPlan,
  type ForkQuiet,
  type ForkSourceRequest,
  NO_AGENT,
} from "./fork.ts";
import { isOwnerMessage, ownerMessageText } from "./tree.ts";
import { type AgentPick, PICK_KEY, pickAsOf } from "./pick.ts";
import type { SettingsKv } from "./settings.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Set while the Session is being filled as a Fork or Clone, in the Session's key-value storage: the IDs its entries
 * were given, by the source's entry ID.
 */
const FILL_KEY = "fork-copy";

type Filling = { readonly ids: Readonly<Record<string, number>> };

/**
 * Set on a source Session while a Fork or Clone carries its files to a new Workspace, in its key-value storage: until
 * when it takes no message, should the main Worker never say the files are carried.
 */
const HOLD_KEY = "fork-hold";

type Hold = { readonly until: number };

/** The longest a source takes no message while its files are carried, in milliseconds. */
const HOLD_LIFETIME_MS = 30 * 60 * 1000;

/** Why a Session being filled refuses a message or a move. */
export const STILL_FILLING =
  "This Session is still being made from the one it was forked or cloned from; try again shortly.";

/** Why a Session whose files are being carried refuses a message. */
const CARRYING =
  "This Session's files are being carried to a new workspace for a Fork or Clone; try again shortly.";

/** Whether the Session that keeps `kv` is being filled as a Fork or Clone, and takes no message yet. */
export const isFilling = (kv: SettingsKv): boolean =>
  (kv.get<Filling | null>(FILL_KEY) ?? null) !== null;

/** What Forks and Clones take from the Session host. */
export type ForksOptions = {
  readonly harness: PiHarness;
  readonly kv: SettingsKv;
  /** The root conversation, created when absent. */
  readonly root: Effect.Effect<Conversation, SessionError>;
  /** The active branch's conversation. */
  readonly active: Effect.Effect<Conversation, SessionError>;
  /** Why `conversation` cannot leave its place in the Session tree now, or nothing when it can. */
  readonly busyReason: (
    conversation: Conversation,
  ) => Effect.Effect<string | undefined, SessionError>;
  /** The Harness's live tasks and unsettled submissions. */
  readonly inspect: Effect.Effect<HarnessInspection, SessionError>;
  /** The conversations whose `/compact` waits for their Run to end. */
  readonly pendingCompactions: () => Readonly<Record<string, string>>;
  /** What the Session picked itself. */
  readonly picked: () => AgentPick;
  /** Runs `effect` in turn with the owner's messages, so none is admitted between a check and what follows it. */
  readonly inArrivalOrder: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/** Both sides of Forks and Clones, and why the Session takes no message while either is under way. */
export const sessionForks = (options: ForksOptions) => {
  const { harness, kv, active, busyReason } = options;

  /** Why the active branch, or with `quiet` "session" anything of the Session, is not at rest; nothing when it is. */
  const restlessness = (quiet: ForkQuiet, conversation: Conversation) =>
    Effect.gen(function* () {
      if (quiet === "none") return undefined;

      const reason = yield* busyReason(conversation);

      if (reason !== undefined || quiet === "branch") return reason;

      const { tasks, submissions } = yield* options.inspect;

      const working =
        Arr.some(tasks, (task) => !task.record.background) ||
        submissions.length > 0 ||
        !Record.isEmptyRecord(options.pendingCompactions());

      return working ? "another branch or a subagent is working" : undefined;
    });

  /**
   * What a Fork or Clone of the active branch carries besides its entries (`ForkPlan`): refused while the Session is
   * itself being filled, and while what `request.quiet` names is not at rest. A source whose files go to a new Workspace
   * takes no message from then on, until `releaseFork`.
   */
  const forkSource = (request: ForkSourceRequest) =>
    Effect.gen(function* () {
      if (isFilling(kv)) return yield* refuse(STILL_FILLING);

      const conversation = yield* active;
      const busy = yield* restlessness(request.quiet, conversation);

      if (busy !== undefined) {
        const made = request.point === undefined ? "cloned" : "forked";
        const where = request.quiet === "session" ? " in a new workspace" : "";

        return yield* refuse(
          `The session cannot be ${made}${where} while ${busy}: stop it or wait for it to end.`,
        );
      }

      /** The newest entries of the active branch's path at or before `max`. */
      const newest = (max: number | undefined, limit: number) =>
        attempt("entries", () =>
          conversation.entries(
            max === undefined
              ? { order: "descending" }
              : // SAFETY: an entry ID of the Session's own.
                { order: "descending", maxEntryId: max as EntryId },
            limit,
            undefined,
            context,
          ),
        ).pipe(Effect.map((page) => page.items));

      let through: number | null;
      let text: string | null = null;

      if (request.point === undefined) {
        through = (yield* newest(undefined, 1))[0]?.id ?? null;
      } else {
        const { entryId, position } = request.point;
        const [entry, before] = yield* newest(entryId, 2);

        if (entry?.id !== entryId) {
          return yield* refuse(`Entry ${entryId} is not on the active branch.`);
        }

        if (position === "before") {
          if (!isOwnerMessage(entry)) {
            return yield* refuse("Only an owner's message can be forked from before it.");
          }

          text = ownerMessageText(entry);
          through = before?.id ?? null;
        } else {
          through = entry.id;
        }
      }

      const [agent, notes, todo] = yield* Effect.all([
        // Before the Session's first message, the agent is pi-durable's default: the Fork takes the settings in force.
        through === null
          ? Effect.succeed(NO_AGENT)
          : attempt("snapshot", () =>
              // SAFETY: an entry of the active branch's path.
              harness.snapshotAsOf(AgentDoc, conversation.id, through as EntryId, context),
            ).pipe(Effect.map((state) => state ?? NO_AGENT)),
        attempt("snapshot", () => harness.snapshot(ContextDoc, conversation.id, context)),
        attempt("snapshot", () => harness.snapshot(TodoDoc, conversation.id, context)),
      ]);

      if (request.quiet === "session") {
        const now = yield* Clock.currentTimeMillis;

        kv.put(HOLD_KEY, { until: now + HOLD_LIFETIME_MS } satisfies Hold);
      }

      return {
        conversationId: conversation.id,
        through,
        text,
        agent: structuredClone(agent),
        pick: pickAsOf(options.picked(), agent),
        context: notes === undefined ? null : structuredClone(notes),
        todo: todo === undefined ? null : structuredClone(todo),
      } satisfies ForkPlan;
    }).pipe(options.inArrivalOrder);

  /** A page of the entries a Fork or Clone copies. */
  const exportEntries = (request: ExportRequest) =>
    attempt("conversation", () => harness.conversation(request.conversationId, context)).pipe(
      Effect.filterOrFail(Predicate.isNotUndefined, () =>
        refuse(`Conversation ${request.conversationId} does not exist.`),
      ),
      Effect.flatMap((conversation) => {
        // SAFETY: entry IDs of the Session's own.
        const maxEntryId = request.through as EntryId;

        const range =
          request.after === null
            ? { order: "ascending" as const, maxEntryId }
            : // SAFETY: the entry after one of the Session's own, in its ID space.
              {
                order: "ascending" as const,
                maxEntryId,
                minEntryId: (request.after + 1) as EntryId,
              };

        return attempt("entries", () =>
          conversation.entries(range, EXPORT_PAGE_ENTRIES, undefined, context),
        );
      }),
      Effect.map((page) => exportPage(page.items, page.next !== undefined)),
    );

  /** Start filling this new Session as a Fork or Clone: it takes no message until `importFinish`. */
  const importStart = options.root.pipe(
    Effect.andThen(Effect.sync(() => kv.put(FILL_KEY, { ids: {} } satisfies Filling))),
  );

  /** Append a page of the source's entries to the root conversation, renumbered. */
  const importEntries = (entries: ReadonlyArray<EntryRecord>) =>
    Effect.gen(function* () {
      const filling = kv.get<Filling | null>(FILL_KEY) ?? null;

      if (filling === null) {
        return yield* refuse("This Session is not being made from another.");
      }

      const ids = new Map(
        Arr.map(Record.toEntries(filling.ids), ([key, value]) => [Number(key), value] as const),
      );

      yield* attempt("importEntries", () =>
        harness.commit(async (tx) => {
          for (const entry of entries) {
            const appended = await tx.appendEntry(ROOT_CONVERSATION_ID, copiedDraft(entry, ids));

            ids.set(entry.id, appended.id);
          }
        }, context),
      );

      kv.put(FILL_KEY, {
        ids: Record.fromEntries(Arr.map([...ids], ([key, value]) => [String(key), value] as const)),
      } satisfies Filling);
    });

  /** Take the agent and documents the plan carries, and take messages from then on. */
  const importFinish = (plan: ForkPlan) =>
    attempt("importFinish", () =>
      harness.commit(async (tx) => {
        copyAgent(await tx.doc(AgentDoc, ROOT_CONVERSATION_ID), plan.agent);

        if (plan.context !== null) {
          const notes = await tx.doc(ContextDoc, ROOT_CONVERSATION_ID);

          notes.notes = structuredClone(plan.context.notes);
          notes.handoff = plan.context.handoff;
        }

        if (plan.todo !== null) {
          const todo = await tx.doc(TodoDoc, ROOT_CONVERSATION_ID);

          todo.nextId = plan.todo.nextId;
          todo.rev = plan.todo.rev + 1;
          todo.tasks = structuredClone(plan.todo.tasks);
          // What the source's context showed of the list named its own entries: the Fork shows it afresh.
          todo.shown = null;
          todo.changedBy = [];
        }
      }, context),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          kv.put(PICK_KEY, plan.pick);
          kv.put(FILL_KEY, null);
        }),
      ),
    );

  /** Take messages again once a Fork or Clone in a new Workspace carried the files. */
  const releaseFork = Effect.sync(() => kv.put(HOLD_KEY, null));

  /** Why the Session takes no message now: it is being filled, or its files are being carried; nothing when it takes them. */
  const refusal = Clock.currentTimeMillis.pipe(
    Effect.map((now): string | undefined => {
      if (isFilling(kv)) return STILL_FILLING;

      const hold = kv.get<Hold | null>(HOLD_KEY) ?? null;

      return hold !== null && now < hold.until ? CARRYING : undefined;
    }),
  );

  return {
    forkSource,
    exportEntries,
    importStart,
    importEntries,
    importFinish,
    releaseFork,
    refusal,
    filling: Effect.sync(() => isFilling(kv)),
  };
};
