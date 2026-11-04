// @effect-diagnostics asyncFunction:off -- the commit callbacks are pi-durable Promise code, as the Harness's own are.
// Forks and Clones over the Session's open Harness (GLOSSARY.md → Fork, Clone; ADR-0017): the source's side, which
// answers what a Fork carries and its entries a page at a time, and the new Session's, which appends them and takes
// the rest. The main Worker drives both (`fillSession`). What is copied, in plain functions, is `fork.ts`'s.
import { ContextDoc } from "@cloudpid/extensions/context";
import { TodoDoc } from "@cloudpid/extensions/todo";
import type { McpQuestionCopies, McpQuestionCopy } from "@cloudpid/extensions/mcp";
import type { AttachedResource, McpAppCopies, McpAppCopy, McpPromptData } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type Conversation,
  type Cursor,
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
import type { Mutable } from "effect/Types";
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
  toolResultIds,
} from "./fork.ts";
import {
  isOwnerMessage,
  ownerMessagePrompt,
  ownerMessageResources,
  ownerMessageText,
} from "./tree.ts";
import { type AgentPick, PICK_KEY, pickAsOf } from "./pick.ts";
import type { SettingsKv } from "./settings.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Set while the Session is being filled as a Fork or Clone, in the Session's key-value storage: the IDs its entries
 * were given, by the source's entry ID. A Session import sets it too (`import`: its entries are never copied a page at
 * a time, so it keeps no IDs), so that it takes no message and no move until the import ends.
 */
const FILL_KEY = "fork-copy";

type Filling = {
  readonly ids: Readonly<Record<string, number>>;
  readonly import?: true;
  /** The translation a Session import is writing, noted before its first page so that a run again can tell it is the same one. */
  readonly translation?: WrittenTranslation;
  /** A Session import's entries are all in the root (`importTranslated`). */
  readonly written?: true;
};

/** What identifies a translation across runs: its version (`TRANSLATOR_VERSION`) and how many entries it makes. */
export type WrittenTranslation = { readonly version: number; readonly count: number };

/** How many of the root's entries a resumed import reads back at a time: an entry can be 5 MB, so a page stays small. */
const READBACK_ENTRIES = 8;

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

/** Why a Session that is importing a local pi Session refuses a message or a move. */
export const STILL_IMPORTING =
  "This Session is still importing a local pi Session; try again when the import has ended.";

/** Why a Session whose files are being carried refuses a message. */
const CARRYING =
  "This Session's files are being carried to a new workspace for a Fork or Clone; try again shortly.";

/** Whether the Session that keeps `kv` is being filled as a Fork or Clone, and takes no message yet. */
export const isFilling = (kv: SettingsKv): boolean =>
  (kv.get<Filling | null>(FILL_KEY) ?? null) !== null;

/** Whether the Session that keeps `kv` is importing a local pi Session: its Workspace is readied only once that ends. */
export const isImporting = (kv: SettingsKv): boolean =>
  (kv.get<Filling | null>(FILL_KEY) ?? null)?.import === true;

/** Why the Session that keeps `kv` takes no message or move while it is filled, or nothing when it is not being filled. */
export const fillingRefusal = (kv: SettingsKv): string | undefined => {
  const filling = kv.get<Filling | null>(FILL_KEY) ?? null;

  if (filling === null) return undefined;

  return filling.import === true ? STILL_IMPORTING : STILL_FILLING;
};

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
  /** The Session's App records: a Fork or Clone carries those of the calls it copies (`McpAppsService`). */
  readonly apps?: McpAppCopies | undefined;
  /** The Session's settled question records: a Fork or Clone carries those of the calls it copies (`McpQuestionsService.copies`). */
  readonly questions?: McpQuestionCopies | undefined;
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
      const filling = fillingRefusal(kv);

      if (filling !== undefined) return yield* refuse(filling);

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
      let mcpPrompt: McpPromptData | undefined;
      let resources: ReadonlyArray<AttachedResource> | undefined;

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
          mcpPrompt = ownerMessagePrompt(entry);
          resources = ownerMessageResources(entry);
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

      const plan: Mutable<ForkPlan> = {
        conversationId: conversation.id,
        through,
        text,
        agent: structuredClone(agent),
        pick: pickAsOf(options.picked(), agent),
        context: notes === undefined ? null : structuredClone(notes),
        todo: todo === undefined ? null : structuredClone(todo),
      };

      if (mcpPrompt !== undefined) plan.mcpPrompt = mcpPrompt;

      if (resources !== undefined) plan.resources = resources;

      return plan;
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
      Effect.map((page) => {
        const { apps, questions } = options;

        // The records of the calls whose results the page holds go with it, so no page is larger than the RPC allows.
        return exportPage(
          page.items,
          page.next !== undefined,
          apps === undefined ? undefined : (entry) => apps.copiesFor(toolResultIds(entry)),
          questions === undefined
            ? undefined
            : (entry) => questions.copiesFor(toolResultIds(entry)),
        );
      }),
    );

  /** Start filling this new Session as a Fork or Clone: it takes no message until `importFinish`. */
  const importStart = options.root.pipe(
    Effect.andThen(Effect.sync(() => kv.put(FILL_KEY, { ids: {} } satisfies Filling))),
  );

  /**
   * Append a page of the source's entries to the root conversation, renumbered, and keep the App records it carries (a
   * source from before App records sends none) as the root conversation's.
   */
  const importEntries = (
    entries: ReadonlyArray<EntryRecord>,
    apps?: ReadonlyArray<McpAppCopy>,
    questions?: ReadonlyArray<McpQuestionCopy>,
  ) =>
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

      if (apps !== undefined && apps.length > 0) {
        yield* Effect.sync(() => options.apps?.adopt(apps, ROOT_CONVERSATION_ID));
      }

      // A source from before question records sends none.
      if (questions !== undefined && questions.length > 0) {
        yield* Effect.sync(() => options.questions?.adopt(questions, ROOT_CONVERSATION_ID));
      }

      kv.put(FILL_KEY, {
        ids: Record.fromEntries(Arr.map([...ids], ([key, value]) => [String(key), value] as const)),
      } satisfies Filling);
    });

  /** Start filling this new Session as a Session import: it takes no message and no move until `importFinish`. */
  const importBegin = options.root.pipe(
    Effect.andThen(
      Effect.sync(() => kv.put(FILL_KEY, { ids: {}, import: true } satisfies Filling)),
    ),
  );

  /**
   * Write a Session import's translated entries to the root conversation, a page at a time. Their IDs are 1 to N in order
   * (`Translation.count`), and each head and edit names one: each is renumbered as its page is appended.
   *
   * The entries land in whole or not at all as far as anything can see: a page is one commit, and until the import ends
   * the Session takes no message and no move (`importing`), so nothing runs from a root that holds only some of
   * them (a viewer sees it filling); an import that is cancelled, expires or is given up deletes the Session with them. A translation that
   * is cut off part way is run again (it is a function of the file, so its pages are the same), and finds the entries the
   * root already has by reading their IDs back, a few at a time: it appends only the rest, with the heads and edits of
   * the first ones still naming the entries they named. The translation is noted before its first page (its version and
   * how many entries it makes), and a run again that finds another (a deploy changed the translator between the runs) or a
   * root with more entries than it makes does not resume: it answers why, and the import is given up. The flag `written`
   * is set once the last page is in, so a retry after it only has to end the import.
   */
  const importTranslated = (
    pages: Iterable<ReadonlyArray<EntryRecord>>,
    translation: WrittenTranslation,
  ) =>
    Effect.gen(function* () {
      const filling = kv.get<Filling | null>(FILL_KEY) ?? null;

      if (filling?.import !== true) return yield* refuse("This Session is not importing.");

      const noted = filling.translation;
      const root = yield* options.root;

      /** The entry the root gave each translated one, by the translation's own ID (its position, from 1). */
      const ids = new Map<number, number>();

      let cursor: Cursor | undefined;
      let first = true;

      do {
        const page = yield* attempt("entries", () =>
          root.entries({ order: "ascending" }, READBACK_ENTRIES, cursor, context),
        );

        if (first) {
          first = false;

          if (page.items.length === 0) {
            // Nothing is written, whatever a run that was cut off before its first commit noted: this translation is the one.
            if (
              noted === undefined ||
              noted.version !== translation.version ||
              noted.count !== translation.count
            ) {
              kv.put(FILL_KEY, { ...filling, translation } satisfies Filling);
            }

            break;
          }

          if (noted === undefined) {
            // Entries and no note: an earlier version wrote them whole, in one transaction, so they are all there.
            kv.put(FILL_KEY, { ...filling, written: true } satisfies Filling);

            return undefined;
          }

          // Only now are there entries that this run would build on, so only now must it be the translation that wrote them.
          if (noted.version !== translation.version || noted.count !== translation.count) {
            return `The translation that was being written (version ${String(noted.version)}, ${String(noted.count)} entries) is not the one this run makes (version ${String(translation.version)}, ${String(translation.count)} entries), so the entries already written cannot be resumed.`;
          }
        }

        for (const entry of page.items) ids.set(ids.size + 1, entry.id);

        if (ids.size > translation.count) {
          return `The root conversation holds more entries than the ${String(translation.count)} the translation makes, so the entries already written cannot be resumed.`;
        }

        cursor = page.next;
      } while (cursor !== undefined);

      for (const page of pages) {
        const fresh = Arr.filter(page, (entry) => entry.id > ids.size);

        if (fresh.length === 0) continue;

        yield* attempt("importEntries", () =>
          harness.commit(async (tx) => {
            for (const entry of fresh) {
              const appended = await tx.appendEntry(ROOT_CONVERSATION_ID, copiedDraft(entry, ids));

              ids.set(entry.id, appended.id);
            }
          }, context),
        );
      }

      kv.put(FILL_KEY, { ...filling, translation, written: true } satisfies Filling);

      return undefined;
    });

  /**
   * Whether every translated entry of a Session import is in the root (see `importTranslated`): the flag says so, and so
   * does a root that has entries while no translation was noted, which an earlier version wrote whole in one transaction
   * before it was cut off.
   */
  const importWritten = Effect.gen(function* () {
    const filling = kv.get<Filling | null>(FILL_KEY) ?? null;

    if (filling?.import !== true) return false;

    if (filling.written === true) return true;

    if (filling.translation !== undefined) return false;

    const root = yield* options.root;

    const page = yield* attempt("entries", () =>
      root.entries({ order: "ascending" }, 1, undefined, context),
    );

    return page.items.length > 0;
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
      const filling = fillingRefusal(kv);

      if (filling !== undefined) return filling;

      const hold = kv.get<Hold | null>(HOLD_KEY) ?? null;

      return hold !== null && now < hold.until ? CARRYING : undefined;
    }),
  );

  return {
    forkSource,
    exportEntries,
    importStart,
    importBegin,
    importEntries,
    importTranslated,
    importWritten,
    importFinish,
    releaseFork,
    refusal,
    filling: Effect.sync(() => isFilling(kv)),
  };
};
