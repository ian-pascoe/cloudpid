// @effect-diagnostics asyncFunction:off -- the task graph watch is pi-durable Promise code, as the Harness's own callbacks are.
// Hosts one pi-durable Harness in a Session Durable Object, the way pi-durable's own `test-workers/worker.ts` does:
// opened over the object's SQLite storage and woken by its alarm (ADR-0002). The Harness stays native Promise code,
// reached through the `Harness` facade and `Effect.tryPromise` (ADR-0003). The object builds both services once, as
// one Layer kept in a `ManagedRuntime`.
import { Harness, type HarnessError, openHarness } from "@cloudpid/effect-durable";
import {
  isAgentConversation,
  EMPTY_SUBAGENTS_STATE as EMPTY_STATE,
  stopConversation,
  SubagentsDoc,
  type SubagentsState,
} from "@cloudpid/extensions/subagents";
import { clearTodoList, TodoDoc, type TodoState } from "@cloudpid/extensions/todo";
import { ContextDoc, MAX_ROLLOVER_FOCUS, ownerRollover } from "@cloudpid/extensions/context";
import {
  discoverPrompts,
  isPromptSource,
  type PromptTemplate,
} from "@cloudpid/extensions/prompt-templates";
import {
  discoverSkills,
  isSkillSource,
  type Skill,
  type SkillsError,
} from "@cloudpid/extensions/skills-discovery";
import {
  type BranchSummaryRequest,
  type Catalog,
  type CommandOutcome,
  type FileMatches,
  type HistoryPage,
  type Navigated,
  type SessionTree,
  type SessionUsage,
  type ContainerUsage,
  type TaskGraphSummary,
  type TodoTask,
  USER_ENTRY_KIND,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { formatModelId, isModelId } from "@cloudpid/config";
import { limitEventImages, SNAPSHOT_IMAGES } from "@cloudpid/extensions/browser";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type Agent,
  type AgentChange,
  AgentDoc,
  type AgentState,
  type DocumentWatch,
  type EntryId,
  type EntryRecord,
  type ModelRef,
  type AgentEvent,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EnvTarget,
  type Extension,
  type HarnessOptions,
  InboxDoc,
  type InputSubmissionDraft,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  type TaskGraph,
  type UserInput,
  type WatchEnd,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  type DurableObjectSqliteStorage,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type * as Types from "effect/Types";
import type { PushEvent } from "../push/notification.ts";
import {
  harnessSettings,
  SessionSettings,
  type SessionSettingsValues,
  type SettingsKv,
} from "./settings.ts";
import {
  type Ledger,
  limitingModels,
  recordTitleUsage,
  sessionTotals,
  usageMessage,
} from "./spend.ts";
import { catalogOf, MAX_EXPORT_BYTES, markdownExport } from "./commands.ts";
import { expandMessage, mayExpand } from "./expand.ts";
import { historyPage } from "./history.ts";
import {
  EXCLUDED_NAMES,
  fileCandidates,
  type FileIndex,
  fileIndex,
  FileListingError,
  FileListings,
  fileListingsLayer,
  LISTING_WALK_TIMEOUT_MS,
  matchFiles,
  MAX_LISTED_ENTRIES,
} from "./file-search.ts";
import { inputProblem, storedBytes } from "./input-guard.ts";
import { SessionRegistry, type SessionStatus } from "./status.ts";
import { summarizeTaskGraph } from "./task-graph.ts";
import { EXCHANGE_ENTRIES, firstExchange, titleTask } from "./titles.ts";
import {
  abandonedEntries,
  activateBranch,
  BRANCH_SUMMARY_KIND,
  type BranchEntries,
  branchIds,
  buildSessionTree,
  EMPTY_TREE,
  isOwnerMessage,
  ownerMessageText,
  planNavigation,
  SessionTreeDoc,
  type SessionTreeState,
  tipOf,
} from "./tree.ts";
import { summarizeBranch, summaryMessage } from "./branch-summary.ts";
import {
  copiedDraft,
  copyAgent,
  EXPORT_PAGE_ENTRIES,
  type ExportPage,
  exportPage,
  type ForkPlan,
} from "./fork.ts";

const context = BACKGROUND_CONTEXT;

/** How often the alarm wakes the object while work is live, so a run an eviction cut off resumes. */
export const HEARTBEAT_MS = 60_000;

/** How long a report to the Registry may take before it counts as failed. */
export const REPORT_TIMEOUT: Duration.Input = "5 seconds";

/**
 * How long a notification may take. The Registry gives each push service 5 seconds, 16 at a time, so this holds for up
 * to 64 subscribed browsers; a Session that gave up sooner would send the same notification again.
 */
export const NOTIFY_TIMEOUT: Duration.Input = "20 seconds";

/** The submissions the owner made whose Run's end has not been notified yet, in the Session's key-value storage. */
const NOTIFY_KEY = "notify-submissions";

/** The conversations whose `/compact` waits for their Run to end, in the Session's key-value storage. */
const COMPACT_KEY = "pending-compactions";

/**
 * Set while the Session is being filled as a Fork or Clone, in the Session's key-value storage: the IDs its copies were
 * given, by the source's entry ID.
 */
const COPY_KEY = "fork-copy";

type Copy = { readonly ids: Readonly<Record<string, number>> };

/** Why a Session being filled refuses a message. */
const STILL_COPYING =
  "This Session is still being copied from the one it was made from; try again shortly.";

/** How many entries a Session branch's read takes at a time. */
const BRANCH_PAGE = 500;

/** How many entries `/export` reads at a time. */
const EXPORT_PAGE = 500;

/** The agent of a conversation that never had one written: pi-durable's defaults throughout. */
const NO_AGENT: AgentState = {};

/**
 * How long finding the Skills and templates a submitted message names, and reading them, may take before the message
 * goes as typed: the owner's message waits on it, and so do the messages sent after it.
 */
export const EXPAND_TIMEOUT: Duration.Input = "5 seconds";

/** The longest focus `/compact` takes, as long as a Rollover's: it is added to the summarizer's instructions. */
const MAX_COMPACT_FOCUS = MAX_ROLLOVER_FOCUS;

/** Why a submission went unanswered by the owner's own doing: stopping a Run is not news. */
const SILENT_REASONS: ReadonlySet<string> = new Set(["aborted", "reset"]);

const isSettled = (record: SubmissionRecord): boolean =>
  record.status === "done" || record.status === "unanswered";

/**
 * What the owner should hear of the submissions that settled: a failure if any went unanswered for a reason other than
 * their stopping it (with its text), otherwise that a Run finished; nothing when all were stopped.
 */
const outcomeOf = (settled: ReadonlyArray<SubmissionRecord>): PushEvent | undefined => {
  const failed = Arr.findFirst(
    settled,
    (record) => record.status === "unanswered" && !SILENT_REASONS.has(record.reason),
  );

  if (Option.isSome(failed) && failed.value.status === "unanswered") {
    const { detail, reason } = failed.value;

    return { kind: "failed", reason: Predicate.isString(detail) ? detail : reason };
  }

  return Arr.some(settled, (record) => record.status === "done") ? { kind: "finished" } : undefined;
};

/**
 * What the alarm is armed for. pi-durable 1.3.0 has no `Harness.wake()`, so the host derives `active` from the live
 * tasks. Once `onWake` ships this becomes pi-durable's `Wake` (`{ active, at? }`): `wake` returns `harness.wake()`,
 * `HarnessOptions.onWake` runs `arm`, and `arm` also arms for the earliest sleep `at`.
 */
type Wake = { readonly active: boolean };

/**
 * The parts of a Durable Object's `ctx.storage` the host uses: its SQLite database, its key-value store and its alarm.
 * Narrow on purpose, so `@cloudflare/workers-types`' module and global declarations of the storage both fit it cheaply.
 */
export type SessionStorage = DurableObjectSqliteStorage & {
  readonly kv: SettingsKv;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type SessionHostOptions<R = never> = {
  /** The object's `ctx.storage`. */
  readonly storage: SessionStorage;
  /**
   * The models every conversation's requests go through, or an Effect that builds them from the Session's services
   * (such as models that scrub requests with its `Secrets`).
   */
  readonly models: Models | Effect.Effect<Models, never, R>;
  /**
   * Reset the object (`ctx.abort`). Called when a storage error closes the Harness: the next event starts a new
   * instance, which reopens it.
   */
  readonly reset: (reason: string) => void;
  /** The extensions the Session's conversations run with, installed before any work resumes. */
  readonly extensions: Effect.Effect<readonly Extension[], never, Harness | SessionSettings | R>;
  /**
   * Extensions that follow the settings: after a read that brought new values, given the extensions installed, the
   * values now and those before, it returns the ones to install over those of the same name (none when what they follow
   * did not change). pi-durable's wraps are pure, so a setting that decides what an extension wraps (the offered
   * tools) is applied by installing it again, which takes effect from the next phase pi-durable starts, never in the
   * middle of one. A model's tool call spans two phases, though (the generation, then the call), so a read that lands
   * between them can defer a tool the request offered: that call fails as unavailable, and the model can load the tool
   * with `tool_search` and call it again.
   */
  readonly reload?:
    | ((
        installed: readonly Extension[],
        values: SessionSettingsValues,
        previous: SessionSettingsValues,
      ) => readonly Extension[])
    | undefined;
  /**
   * When the object must wake although no work is live, such as when a held Secret expires; the alarm is deleted when
   * this is undefined too.
   */
  readonly wakeAt?: Effect.Effect<number | undefined, never, R>;
  /**
   * Runs whenever the object settles with no work live, so state a call left behind can be cleared, such as a Secret
   * request whose call was abandoned while the object was evicted.
   */
  readonly onIdle?: Effect.Effect<void, never, R>;
  /** Builds a conversation's execution environment for each use (`HarnessOptions.env`): the Session's Workspace. */
  readonly env?: HarnessOptions["env"];
  /**
   * Builds a conversation's environment for the composer's lookups (its catalog and `@` menu), which only read files
   * and must not wait for what `env` waits for, such as the Session's Workspace being readied. Defaults to `env`.
   */
  readonly lookupEnv?: HarnessOptions["env"];
  /**
   * What the Session's Workspace's Containers have cost, read with its usage (null: none ran, or the Session has no
   * Workspace). A read that fails leaves it out of that message.
   */
  readonly containerUsage?: (() => Promise<ContainerUsage | null>) | undefined;
  /** How long a report to the Registry may take before it counts as failed. Defaults to `REPORT_TIMEOUT`. */
  readonly reportTimeout?: Duration.Input;
  /** How long a submitted message's expansion may take before it goes as typed. Defaults to `EXPAND_TIMEOUT`. */
  readonly expandTimeout?: Duration.Input;
};

/** User input for the active branch, or for the conversation of one of its subagents. */
export type Prompt = {
  /** The conversation to submit to: the active branch's by default, or a live subagent's; anything else fails. */
  readonly conversationId?: ConversationId;
  /** Submitting the same `requestId` again finds the first submission. */
  readonly requestId?: string;
  readonly input: UserInput;
  /** What the input does while the conversation is busy; pi-durable queues it as a follow-up by default. */
  readonly whenBusy?: NonNullable<InputSubmissionDraft["whenBusy"]>;
};

/** One of the Session's Slash commands, as the owner typed it. */
export type SlashCommand = {
  /** Its name, without the `/`. */
  readonly name: string;
  readonly args: string;
  /** The conversation it is for: the active branch's by default, or a live subagent's. */
  readonly conversationId?: ConversationId;
};

/** What the composer's `@` menu asks for. */
export type FileSearch = {
  /** What follows the `@`. */
  readonly query: string;
  /** The conversation whose directory to search: the active branch's by default, or a live subagent's. */
  readonly conversationId?: ConversationId;
};

/** What the transcript asks of a conversation's earlier History. */
export type HistoryRequest = {
  /** The entry the page ends before. */
  readonly before: number;
  /** The conversation: the active branch's by default, or a live subagent's. */
  readonly conversationId?: ConversationId;
};

/** What an abort reaches. */
export type AbortOptions = {
  /** The conversation to abort: the active branch's by default. */
  readonly conversationId?: ConversationId;
  /** Also stop every subagent below it, and drop the reports they held. */
  readonly subagents?: boolean;
};

/** Where `/tree` goes: just before an owner's message, or just after an entry, with a summary of the branch left or none. */
export type NavigateRequest = {
  readonly entryId: number;
  readonly position: "before" | "at";
  readonly summary?: BranchSummaryRequest;
};

/** What a Fork or Clone asks its source for: the point (none: the latest, a Clone), and whether a Run may be going on. */
export type ForkSourceRequest = {
  readonly entryId?: number;
  readonly position?: "before" | "at";
  /** Refuse while the active branch's Run is in progress: a Clone, or a Fork that carries the files. */
  readonly idle: boolean;
};

/** A page of the entries a Fork copies: those of `conversationId`'s path after `after` (none: from the start) through `through`. */
export type ExportRequest = {
  readonly conversationId: number;
  readonly through: number;
  readonly after: number | null;
};

/** The longest a change to the task graph waits before it is sent. */
export const TASK_GRAPH_INTERVAL: Duration.Input = "250 millis";

/** The longest a change to the Session's usage waits before it is sent. */
export const USAGE_INTERVAL: Duration.Input = "500 millis";

/** How long to wait before reading the Subagents document again after a read failed. */
const TASK_GRAPH_RETRY: Duration.Input = "1 second";

export type Answer =
  | { readonly status: "answered"; readonly submissionId: number; readonly text: string }
  | { readonly status: "unanswered"; readonly submissionId: number; readonly reason: string };

/** A Harness or Durable Object storage call failed. */
export class SessionError extends Schema.TaggedError<
  SessionError,
  { readonly brand: unique symbol }
>()("SessionError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type SessionHostService = {
  /** Durably admit `prompt` to its conversation (the active branch's by default) and return its submission ID. */
  readonly submit: (prompt: Prompt) => Effect.Effect<number, SessionError>;
  /** Submit `prompt` and wait for its answer. */
  readonly prompt: (prompt: Prompt) => Effect.Effect<Answer, SessionError>;
  /** The alarm handler: keep the heartbeat while work is live, and resume it. */
  readonly alarm: Effect.Effect<void, SessionError>;
  /** Whether no task is live and no submission is unsettled. Reads only: it never starts work. */
  readonly idle: Effect.Effect<boolean, SessionError>;
  /** The root conversation's ID; the root is created when absent. */
  readonly root: Effect.Effect<ConversationId, SessionError>;
  /** The active branch's conversation ID (GLOSSARY.md → Session branch); the root is created when absent. */
  readonly activeBranch: Effect.Effect<ConversationId, SessionError>;
  /** Whether the Session is still being filled from the one it is a Fork or Clone of. */
  readonly copying: Effect.Effect<boolean>;
  /** The Session tree: every branch's entries a client shows, and the active branch. */
  readonly tree: Effect.Effect<SessionTree, SessionError>;
  /**
   * Move the active branch to a point of the Session tree (`/tree`), making the branch when needed, with a summary of
   * the branch left when asked. Refused while the active branch is busy.
   */
  readonly navigate: (request: NavigateRequest) => Effect.Effect<Navigated, SessionError>;
  /** Make Session branch `conversationId` the active branch as it stands. Refused while the active branch is busy. */
  readonly switchBranch: (conversationId: ConversationId) => Effect.Effect<void, SessionError>;
  /** Stop everything the Session runs: every branch, and every subagent. For an archived or deleted Session. */
  readonly stopEverything: Effect.Effect<void, SessionError>;
  /** What a Fork or Clone of this Session carries besides the entries (`ForkPlan`). */
  readonly forkSource: (request: ForkSourceRequest) => Effect.Effect<ForkPlan, SessionError>;
  /** A page of the entries a Fork or Clone of this Session copies. */
  readonly exportEntries: (request: ExportRequest) => Effect.Effect<ExportPage, SessionError>;
  /** Start filling this new Session as a Fork or Clone: it takes no message until `importFinish`. */
  readonly importStart: Effect.Effect<void, SessionError>;
  /** Append a page of the source's entries to the root conversation, renumbered. */
  readonly importEntries: (
    entries: ReadonlyArray<EntryRecord>,
  ) => Effect.Effect<void, SessionError>;
  /** Take the agent and documents the plan carries, and take messages from then on. */
  readonly importFinish: (plan: ForkPlan) => Effect.Effect<void, SessionError>;
  /**
   * Pick the root agent's model and thinking level (the active branch's), from its next request on: a field left out
   * stays as it is, and `null` clears it, so the root follows the default in the settings again. The pick is kept across evictions.
   */
  readonly configure: (change: AgentChange) => Effect.Effect<void, SessionError>;
  /**
   * Read the settings now and bring the active branch's agent to the default in force, unless the Session picked its own, so
   * what a client is shown is what the next request runs on.
   */
  readonly sync: Effect.Effect<void, SessionError>;
  /** Which of its model and thinking level the Session picked itself; the rest follows the default. */
  readonly picks: Effect.Effect<Picks>;
  /**
   * Abort the work of the active branch, or of the conversation `conversationId` names (anything else fails),
   * and withdraw its queued input, once it is idle. Subagents below it keep working unless `subagents` is true.
   */
  readonly abort: (options?: AbortOptions) => Effect.Effect<void, SessionError>;
  /**
   * Close the Harness: admission is sealed and the commits it admitted settle, so nothing writes the storage after. Every
   * later call fails; the object is reset before it serves another. For a Session being deleted.
   */
  readonly close: Effect.Effect<void, SessionError>;
  /**
   * A summary of the Session's task graph: the current one first, then one after each change that alters it, at most one
   * every `TASK_GRAPH_INTERVAL`. Fails when the Harness ends its watch.
   */
  readonly taskGraph: Stream.Stream<TaskGraphSummary, SessionError>;
  /**
   * What the Session has spent (every conversation's, subagents' and the title call's) and its limit: how it stands,
   * then each change, at most one every `USAGE_INTERVAL`. Fails when the Harness ends its watch.
   */
  readonly usage: Stream.Stream<SessionUsage, SessionError>;
  /**
   * Conversation `conversationId`'s agent events, unchanged: a batch holding its `snapshot`, then a batch per commit.
   * Fails when the conversation cannot be watched, and when the Harness ends the watch.
   */
  readonly events: (
    conversationId: ConversationId,
  ) => Stream.Stream<ReadonlyArray<AgentEvent>, SessionError>;
  /**
   * Conversation `conversationId`'s Todo List: how it stands, then each change that alters it. Fails when the
   * conversation cannot be watched, and when the Harness ends the watch.
   */
  readonly todos: (
    conversationId: ConversationId,
  ) => Stream.Stream<ReadonlyArray<TodoTask>, SessionError>;
  /**
   * What the composer of the active branch, or of the subagent's that `conversationId` names, offers: the Session's
   * Slash commands, and the Prompt templates and Skills of the conversation's directory, nearest first.
   */
  readonly catalog: (conversationId?: ConversationId) => Effect.Effect<Catalog, SessionError>;
  /** Run one of the Session's Slash commands (`SESSION_COMMANDS`); one that cannot run fails with why, for the owner. */
  readonly command: (command: SlashCommand) => Effect.Effect<CommandOutcome, SessionError>;
  /**
   * The files and folders of the conversation's directory that best match `search.query`, relative to it, for the
   * composer's `@` menu: from a gitignore-aware listing of the directory held for `LISTING_TTL` (`file-search.ts`). A
   * conversation without an environment, or whose environment cannot list files, has none; a listing that fails fails.
   */
  readonly files: (search: FileSearch) => Effect.Effect<FileMatches, SessionError>;
  /**
   * A page of the History of the active branch, or of the conversation `conversationId` names, before entry
   * `before`, oldest first (`historyPage`): what a transcript shows of the Context Windows its snapshot left out.
   */
  readonly history: (request: HistoryRequest) => Effect.Effect<HistoryPage, SessionError>;
};

/** What the Session DO answers with: its Harness, prompted and woken. */
export class SessionHost extends Context.Service<SessionHost, SessionHostService>()(
  "@cloudpid/server/session/host/SessionHost",
) {}

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => SessionError.make({ operation, message: String(cause) }),
  });

const fromHarness = Effect.mapError((error: HarnessError) =>
  SessionError.make({ operation: error.operation, message: error.message }),
);

/** Why a watch of agent events ended. */
const watchEnded = (end: WatchEnd): string =>
  "error" in end
    ? `Watch ended (${end.reason}): ${String(end.error)}`
    : `Watch ended (${end.reason})`;

/** Which of the root conversation's model and thinking level the Session picked, rather than follows the default. */
export type Picks = { readonly model: boolean; readonly thinkingLevel: boolean };

/** The model and thinking level a Session picked itself, in its storage. */
type Pick = { readonly model?: ModelRef; readonly thinkingLevel?: ModelThinkingLevel };

const PICK_KEY = "agent-pick";

/**
 * What a Fork keeps picked: the fields its source picks, each as the branch ran with it at the point (`agent`), so a
 * pick changed since is the one in force then. The fields the source leaves to the default follow it in the Fork too.
 */
const pickAsOf = (pick: Pick, agent: AgentState): Pick => {
  const model = pick.model === undefined ? undefined : (agent.model ?? pick.model);

  const thinkingLevel =
    pick.thinkingLevel === undefined ? undefined : (agent.thinkingLevel ?? pick.thinkingLevel);

  return withChange({}, { model: model ?? null, thinkingLevel: thinkingLevel ?? null });
};

/** `pick` with `change` applied: a field left out stays, `null` clears it. */
const withChange = (pick: Pick, change: AgentChange): Pick => {
  const next: Types.Mutable<Pick> = {};
  const model = change.model === undefined ? pick.model : (change.model ?? undefined);

  const thinkingLevel =
    change.thinkingLevel === undefined ? pick.thinkingLevel : (change.thinkingLevel ?? undefined);

  if (model !== undefined) next.model = model;

  if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;

  return next;
};

/** Whether a conversation's resolved agent is already the `want`ed one. */
const sameAgent = (have: Agent, want: AgentChange): boolean =>
  have.model?.provider === want.model?.provider &&
  have.model?.modelId === want.model?.modelId &&
  have.thinkingLevel === want.thinkingLevel;

/** The alarm heartbeat's next time. */
const heartbeat = Clock.currentTimeMillis.pipe(Effect.map((now) => now + HEARTBEAT_MS));

/** Open the Harness on the object's `storage`, under the `pi_` prefix, after arming a fallback alarm. */
const openSessionHarness = Effect.fn("openSessionHarness")(function* <R>(
  options: SessionHostOptions<R>,
) {
  const { storage } = options;
  const settings = yield* SessionSettings;

  // A fallback before anything can fail: an object whose open or recovery fails is started again.
  const fallback = yield* heartbeat;
  const current = yield* attempt("getAlarm", () => storage.getAlarm());

  if (current === null || current > fallback) {
    yield* attempt("setAlarm", () => storage.setAlarm(fallback));
  }

  const piStorage = yield* attempt("openStorage", () =>
    openDurableObjectSqliteStorage(storage, { prefix: "pi_" }),
  );

  const models = Effect.isEffect(options.models) ? yield* options.models : options.models;

  /** The open Harness, once it is: a request made before that, by nothing yet, is not held to the limit. */
  let opened: Ledger | undefined;

  // Every request the Harness makes (generations, summaries, a subagent's) is held to the Session's spend limit, read at
  // the request. The title call is not: it goes through `options.models` as they are, and its cost is counted.
  const run = Effect.runForkWith(yield* Effect.context<never>());

  const limited = limitingModels(models, {
    // The limit is off while the ledgers cannot be read: say so, or it would be off without a trace.
    failed: (reason) => {
      run(
        Effect.logWarning("Reading the Session's spend failed; the request goes through", reason),
      );
    },
    limit: () => settings.current().spendLimit,
    spent: async () =>
      opened === undefined ? undefined : (await sessionTotals(opened, storage.kv)).cost,
  });

  const harnessOptions = { models: limited, settings: harnessSettings(settings) };

  const harness = yield* openHarness(
    piStorage,
    options.env === undefined ? harnessOptions : { ...harnessOptions, env: options.env },
  ).pipe(fromHarness);

  opened = harness.harness;

  // A storage error closes the Harness for good; reset the object so the next event reopens it.
  yield* Effect.sync(
    () =>
      void harness.harness.closed.then((end) => {
        if (end.reason === "failed") options.reset(`Harness failed: ${String(end.error)}`);
      }),
  );

  return harness;
});

/** Install the Session's extensions in the open Harness and resume interrupted work. */
const startSessionHost = Effect.fn("startSessionHost")(function* <R>(
  options: SessionHostOptions<R>,
) {
  const { storage } = options;
  const harness = yield* Harness;
  const registry = yield* SessionRegistry;
  const settings = yield* SessionSettings;
  const scope = yield* Scope.Scope;
  const services = yield* Effect.context<R>();
  const models = Effect.isEffect(options.models) ? yield* options.models : options.models;

  /** When the object must wake although no work is live. */
  const wakeAt =
    options.wakeAt === undefined
      ? Effect.undefined
      : Effect.provideContext(options.wakeAt, services);

  const onIdle =
    options.onIdle === undefined ? Effect.void : Effect.provideContext(options.onIdle, services);

  // Before anything resumes, so resumed tool calls find their tools.
  const installed = yield* options.extensions;

  for (const extension of installed) yield* harness.install(extension);

  /** The settings the extensions were last built for. */
  let built = settings.current();

  /** What watches of the Session's usage run when it or its limit changes outside the Harness's ledgers. */
  const usageListeners = new Set<() => void>();

  /** Read the settings, and install the extensions that follow them again when they changed. */
  const refreshSettings = settings.refresh.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const values = settings.current();

        if (values === built) return;

        const previous = built;

        built = values;

        // A limit changed in the settings reaches the clients that watch the usage even if the Session sits idle.
        if (values.spendLimit !== previous.spendLimit) {
          for (const listener of usageListeners) listener();
        }

        if (options.reload === undefined) return;

        for (const extension of options.reload(installed, values, previous)) {
          yield* harness.install(extension);
        }
      }),
    ),
  );

  // Alarm decisions run one at a time, so an idle check never deletes the heartbeat a concurrent submit just armed.
  const serially = Semaphore.withPermit(yield* Semaphore.make(1));

  // Submissions are admitted in the order they arrive: a message that waits on its expansion's Workspace calls holds back
  // the ones sent after it, which would otherwise be admitted first.
  const inArrivalOrder = Semaphore.withPermit(yield* Semaphore.make(1));

  const { kv } = storage;

  /** What this Session picked: a field is absent while the Session follows the default. */
  const picked = (): Pick => {
    const kept = kv.get<Pick>(PICK_KEY) ?? {};

    // A model the settings no longer accept is ignored: the Session follows the default rather than fail every request.
    return kept.model === undefined || isModelId(formatModelId(kept.model))
      ? kept
      : withChange(kept, { model: null });
  };

  /** The agent the root conversation runs with: what the Session picked, then the default in the settings. */
  const wanted = (): AgentChange => {
    const { agent } = settings.current();
    const pick = picked();

    return {
      model: pick.model ?? agent.model,
      thinkingLevel: pick.thinkingLevel ?? agent.thinkingLevel,
    };
  };

  // The agent applies when the root is created: a new Session starts on the default in force.
  const root = Effect.suspend(() => harness.root(wanted())).pipe(fromHarness);

  /** The Session tree as the Session keeps it: the root conversation active until a branch is made. */
  const treeState = attempt("snapshot", () =>
    harness.harness.snapshot(SessionTreeDoc, context),
  ).pipe(Effect.map((state): SessionTreeState => state ?? EMPTY_TREE));

  /** The active branch's conversation (GLOSSARY.md → Session branch); the root is created when absent. */
  const active = root.pipe(
    Effect.andThen(treeState),
    Effect.flatMap(({ active: id }) =>
      id === ROOT_CONVERSATION_ID
        ? root
        : attempt("conversation", () =>
            // SAFETY: a conversation ID `activateBranch` wrote.
            harness.harness.conversation(id as ConversationId, context),
          ).pipe(Effect.filterOrElse(Predicate.isNotUndefined, () => root)),
    ),
  );

  /** Bring the active branch's agent to the one it wants, so its next request runs on it; nothing is written when it does. */
  const applyAgent = Effect.gen(function* () {
    const conversation = yield* active;
    const want = wanted();
    const have = yield* attempt("agent", () => conversation.agent(context));

    if (sameAgent(have, want)) return;

    yield* attempt("configure", () => conversation.configure(want, context));
  });

  const inspect = harness.inspect.pipe(fromHarness);

  /**
   * Names the Session after its first answer (`docs/spec.md` → Client and protocol → Titles). The root's first message
   * and answer come from its first entries; a first Run so long that its answer is past them is named by its message.
   */
  const titles = titleTask({
    kv,
    models,
    // The call is counted in the Session's spend, though no conversation holds it.
    onUsage: (usage) => {
      recordTitleUsage(kv, usage);

      for (const listener of usageListeners) listener();
    },
    // The `small` role's model; the Session's own (its pick, else the default) when the roles hold none.
    model: () =>
      settings.current().subagents.roles.small?.model ??
      picked().model ??
      settings.current().agent.model,
    registry,
    exchange: Effect.gen(function* () {
      const conversation = yield* root;

      const page = yield* attempt("titleEntries", () =>
        conversation.commit(
          (tx) =>
            tx.scanEntries(
              { conversationId: conversation.id, order: "ascending" },
              EXCHANGE_ENTRIES,
            ),
          context,
        ),
      );

      const exchange = firstExchange(page.items);

      return exchange?.answer === undefined && page.items.length < EXCHANGE_ENTRIES
        ? undefined
        : exchange;
    }),
  });

  /**
   * Whether this instance admitted a root submission and so follows its answers itself (`titleAfter`): the title is then
   * attempted once per answer, and the idle settle below leaves it alone. An instance that only resumed work
   * (`wakeAndResume`) has no such follower, so the idle settle names the Session when that work ends.
   */
  let followingAnswers = false;

  /** Once `submission` is answered, name the Session beside the Run, which never waits for it. Lost with the object; a later answer tries again. */
  const titleAfter = (submission: Submission) =>
    titles.done()
      ? Effect.void
      : Effect.sync(() => {
          followingAnswers = true;
        }).pipe(
          Effect.andThen(attempt("wait", () => submission.wait(context))),
          Effect.flatMap((settled) => (settled.status === "done" ? titles.run : Effect.void)),
          Effect.ignore,
          Effect.forkIn(scope),
          Effect.asVoid,
        );

  /**
   * Live work keeps the heartbeat, as pi-durable main's `wake()` counts it: a task no installed definition can run
   * never becomes runnable by waking, and a waiting task counts through the live tasks it waits on.
   */
  const wake: Effect.Effect<Wake, SessionError> = inspect.pipe(
    Effect.map(({ tasks }) => ({
      active: Arr.some(
        tasks,
        (task) => task.state.kind !== "blocked" && task.state.kind !== "waiting",
      ),
    })),
  );

  const armHeartbeat = heartbeat.pipe(
    Effect.flatMap((at) => attempt("setAlarm", () => storage.setAlarm(at))),
  );

  /** What the Registry was last told, by this instance. Unknown at first, so a new instance tells it. */
  let reported: SessionStatus | undefined;

  /**
   * Tell the Registry `status` unless it was just told, and say whether it now has it. A report that fails or takes
   * too long counts as failed, so a slow Registry cannot stall prompts or the constructor.
   */
  const report = (status: SessionStatus): Effect.Effect<boolean> =>
    reported === status
      ? Effect.succeed(true)
      : registry.report(status).pipe(
          Effect.timeout(options.reportTimeout ?? REPORT_TIMEOUT),
          Effect.andThen(
            Effect.sync(() => {
              reported = status;

              return true;
            }),
          ),
          Effect.catchCause((cause) =>
            // The Registry may have applied it before failing, so what it holds is unknown again.
            Effect.logWarning("Registry status report failed", cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reported = undefined;

                  return false;
                }),
              ),
            ),
          ),
        );

  /** The alarm once no work is live: deleted, unless the object must wake later anyway. */
  const rest = wakeAt.pipe(
    Effect.flatMap((at) =>
      at === undefined
        ? attempt("deleteAlarm", () => storage.deleteAlarm())
        : attempt("setAlarm", () => storage.setAlarm(at)),
    ),
  );

  const arm = (next: Wake) =>
    next.active
      ? // The heartbeat first: a report that cannot be made must not leave live work unwoken.
        armHeartbeat.pipe(Effect.andThen(report("running")), Effect.asVoid)
      : // Report before deleting the heartbeat: an unreported end keeps it, to report again.
        onIdle.pipe(
          Effect.andThen(report("idle")),
          Effect.flatMap((told) => (told ? rest : armHeartbeat)),
        );

  /** Reconcile the alarm and the Registry with what is live now. */
  const settle = wake.pipe(Effect.flatMap(arm), serially);

  /** The submissions whose Run's end is yet to be notified. */
  const pendingNotices = (): SubmissionId[] => kv.get<SubmissionId[]>(NOTIFY_KEY) ?? [];

  /** Tell the owner, but never fail or stall: a notification is not worth a prompt. Says whether it went out. */
  const notifyOwner = (event: PushEvent): Effect.Effect<boolean> =>
    registry.notify(event).pipe(
      Effect.timeout(NOTIFY_TIMEOUT),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Notifying the owner failed", cause).pipe(Effect.as(false)),
      ),
    );

  /** Alone, so a Run's end is never notified twice by two settles at once. */
  const notifying = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  /**
   * Notify the owner of the Runs their submissions started that have ended: one push for all that settled together,
   * failed if any failed. Submissions still unsettled wait for a later call, as do ones a failed notification could
   * not tell. It runs outside the alarm lock, so a slow push never holds up a prompt.
   */
  const notifyRunEnds = Effect.gen(function* () {
    const ids = pendingNotices();

    if (ids.length === 0) return;

    const records = yield* Effect.forEach(ids, (id) =>
      attempt("submission", async () => {
        const submission = await harness.harness.submission(id, context);

        return submission === undefined ? null : await submission.status(context);
      }),
    );

    // A submission the Harness no longer has is dropped without a word.
    const ended = Arr.filter(
      Arr.zip(ids, records),
      ([, record]) => record === null || isSettled(record),
    );

    if (ended.length === 0) return;

    const event = outcomeOf(
      Arr.getSomes(Arr.map(ended, ([, record]) => Option.fromNullOr(record))),
    );

    if (event !== undefined && !(yield* notifyOwner(event))) return;

    const endedIds = new Set(Arr.map(ended, ([id]) => id));

    kv.put(
      NOTIFY_KEY,
      Arr.filter(pendingNotices(), (id) => !endedIds.has(id)),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Run notifications failed", cause)),
    notifying,
  );

  /** Whether a fiber is waiting for the Session to go idle. */
  let waiting = false;

  /**
   * Once the work now live is done, settle: nobody need be waiting on it for the Registry to hear it ended. One waiter
   * covers every submission, since it ends when the whole Session is idle; it belongs to the layer's scope.
   */
  const settleWhenIdle = Effect.suspend(() => {
    if (waiting) return Effect.void;

    waiting = true;

    return harness.waitForIdle.pipe(
      // Cleared before settling, so a submit that lands meanwhile starts the next waiter.
      Effect.ensuring(
        Effect.sync(() => {
          waiting = false;
        }),
      ),
      Effect.andThen(settle),
      Effect.andThen(notifyRunEnds),
      // Also here, so a first Run an eviction cut short is named once the next instance has finished it.
      Effect.andThen(Effect.suspend(() => (followingAnswers ? Effect.void : titles.run))),
      Effect.ignore,
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  // Armed before `resume()` runs anything, as for any call that can start work. The work it resumes runs under its span.
  const wakeAndResume = wake.pipe(
    Effect.flatMap(arm),
    Effect.andThen(harness.resume.pipe(Effect.withSpan("session.resume"))),
    Effect.andThen(settleWhenIdle),
    serially,
  );

  /**
   * The conversation the owner addresses: the active branch's when `conversationId` is left out, otherwise a Session
   * branch's or a live subagent's. Anything else fails, so a client cannot reach a conversation that is not an agent's.
   */
  const addressed = (conversationId: ConversationId | undefined) =>
    conversationId === undefined
      ? active
      : conversationId === ROOT_CONVERSATION_ID
        ? root
        : attempt("agent", () =>
            isAgentConversation(harness.harness, conversationId, context),
          ).pipe(
            Effect.filterOrFail(
              (known) => known,
              () =>
                SessionError.make({
                  operation: "agent",
                  message: `Conversation ${conversationId} is not the root or a subagent of this Session`,
                }),
            ),
            Effect.andThen(
              attempt("conversation", () => harness.harness.conversation(conversationId, context)),
            ),
            Effect.filterOrFail(Predicate.isNotUndefined, () =>
              SessionError.make({
                operation: "agent",
                message: `Conversation ${conversationId} does not exist`,
              }),
            ),
          );

  /** End `span` as `exit` says. */
  const endSpan = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>) =>
    Clock.currentTimeNanos.pipe(Effect.map((now) => span.end(now, exit)));

  /**
   * Admit a submission as the `session.run` span: it starts with the submission and ends when the submission settles,
   * and the Run's work (its requests and tool calls) is started under it, so a trace shows the Run whole. A Run an
   * eviction cuts off has no end; its resumed work is under `session.resume`.
   */
  const tracedRun = (
    conversationId: ConversationId,
    submit: Effect.Effect<Submission, SessionError>,
  ) =>
    Effect.makeSpan("session.run", { attributes: { "conversation.id": conversationId } }).pipe(
      Effect.flatMap((span) =>
        submit.pipe(
          Effect.withParentSpan(span),
          Effect.tap((submission) =>
            attempt("wait", () => submission.wait(context)).pipe(
              Effect.tap((settled) =>
                Effect.sync(() => {
                  span.attribute("submission.id", submission.id);
                  span.attribute("run.outcome", settled.reason ?? settled.status);
                }),
              ),
              Effect.exit,
              Effect.flatMap((exit) => endSpan(span, exit)),
              Effect.forkIn(scope),
            ),
          ),
          Effect.onError((cause) => endSpan(span, Exit.failCause(cause))),
        ),
      ),
    );

  /**
   * Admit `draft` to conversation `conversationId` (the root's by default). `named` says whether the Session may be
   * named after it: only the owner's own messages to the root name it, a subagent's conversation being the root's own
   * work and a Rollover request not being the owner's words.
   */
  const admitDraft = (
    conversationId: ConversationId | undefined,
    draft: InputSubmissionDraft,
    named: boolean,
  ): Effect.Effect<Submission, SessionError> => {
    const toRoot = conversationId === undefined;

    // A subagent keeps the agent it was started with; only the active branch follows the settings and the owner's pick.
    const target = toRoot ? applyAgent.pipe(Effect.andThen(active)) : addressed(conversationId);

    // The next request runs on the settings in force now. The read stays out of the lock, so a slow Registry never holds
    // up the alarm or a status report.
    return refreshSettings.pipe(
      // Another conversation is checked before arming: a bad ID must not report the Session running to the Registry.
      Effect.andThen(toRoot ? Effect.succeed(target) : Effect.map(target, Effect.succeed)),
      Effect.flatMap((resolved) =>
        // Arm before admitting work: an object that dies after the commit is still woken.
        arm({ active: true }).pipe(
          Effect.andThen(resolved),
          Effect.flatMap((conversation) =>
            tracedRun(
              conversation.id,
              attempt("submit", () => conversation.submit(draft, context)),
            ),
          ),
          // The owner hears how this Run ends, even after an eviction: the submission is kept until it is told.
          Effect.tap((submission) =>
            Effect.sync(() => {
              kv.put(NOTIFY_KEY, Arr.dedupe([...pendingNotices(), submission.id]));
            }),
          ),
          serially,
        ),
      ),
      Effect.tap(settleWhenIdle),
      Effect.tap((submission) => (toRoot && named ? titleAfter(submission) : Effect.void)),
    );
  };

  /**
   * The execution environment of `conversation`, in its own `cwd`: the Session's Workspace. For a `lookup` (the
   * composer's catalog and `@` menu), the one `lookupEnv` builds.
   */
  const environment = (conversation: Conversation, { lookup = false } = {}) =>
    Effect.suspend(() => {
      const build = lookup ? (options.lookupEnv ?? options.env) : options.env;

      if (build === undefined) return Effect.undefined;

      return attempt("agent", () => conversation.agent(context)).pipe(
        Effect.flatMap((agent) =>
          attempt("env", async () => {
            const target: Types.Mutable<EnvTarget> = {
              conversationId: conversation.id,
              read: harness.harness,
            };

            // A conversation's own `cwd`, as pi-durable builds its environment for a tool call.
            if (agent.cwd !== undefined) target.cwd = agent.cwd;

            return build(target, context);
          }),
        ),
      );
    });

  const fromDiscovery = Effect.mapError((error: SkillsError) =>
    SessionError.make({ operation: "discover", message: error.message }),
  );

  /** The Skills a conversation in `env` can name, those the model is not offered too. */
  const skillsIn = (env: ExecutionEnv): Effect.Effect<ReadonlyArray<Skill>, SessionError> =>
    isSkillSource(env)
      ? attempt("skills", () => env.discoverSkills(context))
      : discoverSkills(env).pipe(fromDiscovery);

  /** The Prompt templates of a conversation in `env`. */
  const templatesIn = (
    env: ExecutionEnv,
  ): Effect.Effect<ReadonlyArray<PromptTemplate>, SessionError> =>
    isPromptSource(env)
      ? attempt("prompts", () => env.discoverPrompts(context))
      : discoverPrompts(env).pipe(fromDiscovery);

  /** Whether `conversation`'s agent can roll over: it has the `context_rollover` tool, which a subagent never has. */
  const canRollOver = (conversation: Conversation) =>
    attempt("agent", () => conversation.agent(context)).pipe(
      Effect.map((agent) => Arr.some(agent.tools, (tool) => tool.name === "context_rollover")),
    );

  /** `found`, or none when it fails: the composer still offers the rest. */
  const orNone = <A>(what: string, found: Effect.Effect<ReadonlyArray<A>, SessionError>) =>
    found.pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Listing the ${what} for the composer failed`, error).pipe(
          Effect.as<ReadonlyArray<A>>([]),
        ),
      ),
    );

  /**
   * What `conversation`'s composer offers: the Session's commands, and its directory's templates and Skills. A Workspace
   * that cannot be asked leaves the templates or Skills out, not the commands.
   */
  const catalogFor = (conversation: Conversation) =>
    Effect.all(
      [
        canRollOver(conversation),
        environment(conversation, { lookup: true }).pipe(
          Effect.flatMap((env) =>
            env === undefined
              ? Effect.succeed<readonly [ReadonlyArray<Skill>, ReadonlyArray<PromptTemplate>]>([
                  [],
                  [],
                ])
              : Effect.all(
                  [orNone("Skills", skillsIn(env)), orNone("templates", templatesIn(env))],
                  {
                    concurrency: 2,
                  },
                ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Listing the composer's templates and Skills failed", error).pipe(
              Effect.as<readonly [ReadonlyArray<Skill>, ReadonlyArray<PromptTemplate>]>([[], []]),
            ),
          ),
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([rollover, [skills, templates]]) => catalogOf(skills, templates, rollover)));

  const listings = yield* FileListings;

  /** The paths `env` offers the `@` menu from its directory, held per file namespace and directory. */
  const pathsIn = (env: ExecutionEnv) => {
    const list = env.listFiles?.bind(env);

    if (list === undefined) return Effect.succeed<FileIndex>([]);

    const options = {
      exclude: EXCLUDED_NAMES,
      maxEntries: MAX_LISTED_ENTRIES,
      timeoutMs: LISTING_WALK_TIMEOUT_MS,
    };

    const listed = Effect.tryPromise({
      try: () => list(".", options, context),
      catch: (cause) => FileListingError.make({ message: String(cause) }),
    }).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.value)
          : Effect.fail(FileListingError.make({ message: result.error.message })),
      ),
      Effect.tap(({ entries, truncated }) =>
        truncated
          ? Effect.logWarning("The @ menu's listing of a directory was cut off at its bounds", {
              directory: env.cwd,
              entries: entries.length,
            })
          : Effect.void,
      ),
      Effect.map(({ entries }) => fileIndex(fileCandidates(entries, env.cwd))),
    );

    return listings
      .get(`${env.id}:${env.cwd}`, listed)
      .pipe(
        Effect.mapError((error) =>
          SessionError.make({ operation: "files", message: error.message }),
        ),
      );
  };

  /** What `conversation`'s `@` menu offers for `query`. */
  const filesFor = (conversation: Conversation, query: string) =>
    environment(conversation, { lookup: true }).pipe(
      Effect.flatMap((env) => (env === undefined ? Effect.succeed([]) : pathsIn(env))),
      Effect.map((paths): FileMatches => ({ paths: matchFiles(query, paths) })),
    );

  /** The typed text of `input`: the text itself, or its first text block. */
  const typedText = (input: UserInput): string | undefined =>
    Predicate.isString(input)
      ? input
      : Arr.findFirst(input, (block) => block.type === "text").pipe(
          Option.map((block) => (block.type === "text" ? block.text : "")),
          Option.getOrUndefined,
        );

  /** `input` with its typed text replaced by `content`. */
  const withText = (input: UserInput, content: string): UserInput => {
    if (Predicate.isString(input)) return content;

    const at = Option.getOrUndefined(Arr.findFirstIndex(input, (block) => block.type === "text"));

    return Arr.map(input, (block, index) =>
      index === at ? { type: "text" as const, text: content } : block,
    );
  };

  /**
   * The draft of the owner's `prompt`: its input as the model gets it. A message that names a Skill or a Prompt template
   * of the conversation's directory is expanded, and placed as a `cloudpid.user` entry keeping what the owner typed
   * (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md). A message the Workspace cannot be asked about
   * goes as typed.
   */
  const draftOf = (prompt: Prompt): Effect.Effect<InputSubmissionDraft, SessionError> => {
    const { conversationId, input, ...rest } = prompt;
    const typed = typedText(input);
    const plain: InputSubmissionDraft = { type: "input", content: input, ...rest };

    if (typed === undefined || !mayExpand(typed)) return Effect.succeed(plain);

    const expansion = (conversation: Conversation) =>
      environment(conversation).pipe(
        Effect.flatMap((env) =>
          env === undefined
            ? Effect.undefined
            : Effect.all([skillsIn(env), templatesIn(env)], { concurrency: 2 }).pipe(
                Effect.flatMap(([skills, templates]) =>
                  attempt("expand", () =>
                    expandMessage(typed, {
                      skills,
                      templates,
                      read: async (path) => {
                        const read = await env.readTextFile(path, context);

                        return read.ok ? read.value : undefined;
                      },
                    }),
                  ),
                ),
                // What it named but could not expand is in the log: the owner sees no Skill beside the message.
                Effect.tap(({ unexpanded }) =>
                  Effect.forEach(unexpanded, (why) =>
                    Effect.logWarning(`A message was not expanded with what it names: ${why}`),
                  ),
                ),
                Effect.map(({ expansion }) => expansion),
              ),
        ),
        Effect.timeoutOrElse({
          duration: options.expandTimeout ?? EXPAND_TIMEOUT,
          orElse: () =>
            Effect.fail(
              SessionError.make({ operation: "expand", message: "The Workspace took too long" }),
            ),
        }),
        // The Workspace could not be asked in time: the message goes as typed rather than not at all.
        Effect.catch((error) =>
          Effect.logWarning("Expanding a message failed; it goes as typed", error).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    // A conversation that is neither the root nor a subagent fails here, as the submit would.
    return addressed(conversationId).pipe(
      Effect.flatMap(expansion),
      Effect.map((expanded): InputSubmissionDraft =>
        expanded === undefined
          ? plain
          : {
              ...plain,
              content: withText(input, expanded.content),
              entry: {
                kind: USER_ENTRY_KIND,
                data: { display: expanded.data.display, skills: [...expanded.data.skills] },
              },
            },
      ),
    );
  };

  /**
   * Refuse `draft` when the Session could not store it: an image the providers do not take, or a message that would not
   * fit one row, alone or in the conversation's inbox beside the messages waiting there (`input-guard.ts`). Its
   * expansion is in it, so what is measured is what would be written. Run in arrival order, so the inbox read is not
   * outgrown by a message admitted meanwhile.
   */
  const guard = (conversationId: ConversationId | undefined, draft: InputSubmissionDraft) =>
    Effect.suspend(() => {
      const refused = (message: string) => SessionError.make({ operation: "submit", message });

      // The row pi-durable writes is the entry (its model message, from `content`, and its kind and data, from `entry`) or
      // the inbox document holding it, both as JSON; `{ content, entry }` is that JSON but for a few fields (IDs, the
      // timestamp, the role), which the 100 KB between `MAX_STORED_INPUT_BYTES` and the 2 MB cap leaves room for.
      const alone = inputProblem(draft, 0);

      if (alone !== undefined) return Effect.fail(refused(alone));

      return addressed(conversationId).pipe(
        Effect.flatMap((conversation) =>
          attempt("snapshot", () => harness.harness.snapshot(InboxDoc, conversation.id, context)),
        ),
        Effect.flatMap((inbox) => {
          const queued = inbox === undefined || inbox.items.length === 0 ? 0 : storedBytes(inbox);
          const problem = inputProblem(draft, queued);

          return problem === undefined ? Effect.void : Effect.fail(refused(problem));
        }),
      );
    });

  /** Whether the Session is being filled as a Fork or Clone, and takes no message yet. */
  const isCopying = (): boolean => (kv.get<Copy | null>(COPY_KEY) ?? null) !== null;

  const admit = (prompt: Prompt): Effect.Effect<Submission, SessionError> =>
    (isCopying()
      ? Effect.fail(SessionError.make({ operation: "submit", message: STILL_COPYING }))
      : draftOf(prompt)
    ).pipe(
      Effect.tap((draft) => guard(prompt.conversationId, draft)),
      Effect.flatMap((draft) => admitDraft(prompt.conversationId, draft, true)),
      inArrivalOrder,
    );

  const answer = Effect.fn("SessionHost.prompt")(function* (prompt: Prompt) {
    const submission = yield* admit(prompt);
    const settled = yield* attempt("wait", () => submission.wait(context));

    // The run is over: drop the heartbeat unless other work is live.
    yield* settle;

    if (settled.status !== "done" || settled.type !== "input") {
      return {
        status: "unanswered",
        submissionId: submission.id,
        reason: settled.reason ?? settled.status,
      } satisfies Answer;
    }

    const conversation = yield* addressed(prompt.conversationId);

    const entry = yield* attempt("answer", () =>
      conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context),
    );

    const message = entry?.model?.[0];

    const text =
      message?.role === "assistant"
        ? Arr.join(
            Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
            "",
          )
        : "";

    return { status: "answered", submissionId: submission.id, text } satisfies Answer;
  });

  /** A failure the owner's Slash command reports to the composer. */
  const refuse = (message: string) => SessionError.make({ operation: "command", message });

  /** The conversations whose `/compact` waits for their Run to end, with the focus asked for. */
  const pendingCompactions = (): Readonly<Record<string, string>> =>
    kv.get<Record<string, string>>(COMPACT_KEY) ?? {};

  /** Admit a manual compaction of `conversationId`, with `focus` as its summary's additional focus. */
  const startCompaction = (conversationId: ConversationId, focus: string) =>
    attempt("conversation", () => harness.harness.conversation(conversationId, context)).pipe(
      Effect.filterOrFail(Predicate.isNotUndefined, () =>
        refuse(`Conversation ${conversationId} does not exist.`),
      ),
      Effect.flatMap((conversation) =>
        arm({ active: true }).pipe(
          Effect.andThen(
            attempt("compact", () =>
              conversation.compact(focus === "" ? undefined : focus, context),
            ),
          ),
          serially,
        ),
      ),
      Effect.tap(settleWhenIdle),
    );

  /**
   * Once `conversationId` is idle, run the compaction its `/compact` asked for, if no other waiter took it first. The
   * request is in storage until it starts, so an instance that was evicted meanwhile starts it again.
   */
  const compactWhenIdle = (conversationId: ConversationId) =>
    attempt("waitForIdle", async () => {
      await (await harness.harness.conversation(conversationId, context))?.waitForIdle(context);
    }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const { [String(conversationId)]: focus, ...others } = pendingCompactions();

          if (focus === undefined) return Effect.void;

          kv.put(COMPACT_KEY, others);

          return startCompaction(conversationId, focus);
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("A /compact after a Run failed", cause)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  /** `/compact [focus]`: now when the conversation is idle, otherwise once its Run ends. */
  const compact = (conversation: Conversation, focus: string) =>
    focus.length > MAX_COMPACT_FOCUS
      ? Effect.fail(refuse(`Keep the compaction focus to ${MAX_COMPACT_FOCUS} characters.`))
      : compactChecked(conversation, focus);

  const compactChecked = (conversation: Conversation, focus: string) =>
    attempt("snapshot", () => harness.harness.snapshot(LiveDoc, conversation.id, context)).pipe(
      Effect.flatMap((live): Effect.Effect<CommandOutcome, SessionError> => {
        if (live?.run === undefined) {
          return startCompaction(conversation.id, focus).pipe(
            Effect.as({ notice: "Compacting the context." }),
          );
        }

        return Effect.sync(() =>
          kv.put(COMPACT_KEY, { ...pendingCompactions(), [String(conversation.id)]: focus }),
        ).pipe(
          Effect.andThen(compactWhenIdle(conversation.id)),
          Effect.as({ notice: "The context is compacted once the run ends." }),
        );
      }),
    );

  /** `/rollover [focus]`: the Rollover request, steered into the Run, with the owner's focus for the Handoff. */
  const rollover = (conversation: Conversation, focus: string) =>
    focus.length > MAX_ROLLOVER_FOCUS
      ? Effect.fail(refuse(`Keep the Rollover focus to ${MAX_ROLLOVER_FOCUS} characters.`))
      : canRollOver(conversation).pipe(
          Effect.filterOrFail(
            (can) => can,
            () => refuse("This conversation cannot roll over: it has no context_rollover tool."),
          ),
          Effect.andThen(Effect.all([Clock.currentTimeMillis, Random.nextInt])),
          Effect.flatMap(([now, random]) =>
            admitDraft(conversation.id, ownerRollover(focus, `${now}-${random}`), false).pipe(
              inArrivalOrder,
            ),
          ),
          Effect.as({ notice: "Asked the agent to roll over." } satisfies CommandOutcome),
        );

  /** `/todo clear`. */
  const clearTodos = (conversation: Conversation, args: string) =>
    args === "clear"
      ? attempt("todo", () =>
          harness.harness.commit((tx) => clearTodoList(tx, conversation.id), context),
        ).pipe(
          Effect.map((cleared): CommandOutcome => ({
            notice:
              cleared === 0
                ? "The Todo List is already empty."
                : `Cleared ${cleared} ${cleared === 1 ? "Task" : "Tasks"}.`,
          })),
        )
      : Effect.fail(refuse("/todo takes clear."));

  /**
   * `conversation`'s whole History as Markdown, oldest first, across its Context Windows: each page is rendered as it is
   * read, and an export that grows past `MAX_EXPORT_BYTES` is given up before the rest is read.
   */
  const historyMarkdown = (conversation: Conversation) =>
    Effect.gen(function* () {
      const built = markdownExport(conversation.id, DateTime.formatIso(yield* DateTime.now));
      let cursor: Cursor | undefined;

      do {
        const page = yield* attempt("entries", () =>
          conversation.entries({ order: "ascending" }, EXPORT_PAGE, cursor, context),
        );

        if (!built.add(page.items)) {
          return yield* refuse(
            `The History is over ${MAX_EXPORT_BYTES / 1024 / 1024} MiB, too large to export in one file.`,
          );
        }

        cursor = page.next;
      } while (cursor !== undefined);

      return built.markdown();
    });

  /** `/export`: the whole History as Markdown, for the client to download. */
  const exportHistory = (conversation: Conversation) =>
    historyMarkdown(conversation).pipe(
      Effect.map((content): CommandOutcome => ({
        notice: "Exported the History.",
        file: {
          name: `conversation-${conversation.id}-history.md`,
          mimeType: "text/markdown",
          content,
        },
      })),
    );

  const runCommand = (request: SlashCommand) =>
    addressed(request.conversationId).pipe(
      Effect.flatMap((conversation): Effect.Effect<CommandOutcome, SessionError> => {
        const args = request.args.trim();

        switch (request.name) {
          case "compact":
            return compact(conversation, args);
          case "rollover":
            return rollover(conversation, args);
          case "todo":
            return clearTodos(conversation, args);
          case "export":
            return args === ""
              ? exportHistory(conversation)
              : Effect.fail(refuse("/export takes no argument."));
          default:
            return Effect.fail(refuse(`The Session has no /${request.name} command.`));
        }
      }),
    );

  /** The Session's task graph as summaries; one per change, the first being how it stands. */
  const taskGraphSummaries = Stream.callback<TaskGraphSummary, SessionError>((queue) =>
    Effect.flatMap(Effect.context<never>(), (services) =>
      Effect.acquireRelease(
        attempt("watchTaskGraph", async () => {
          const run = Effect.runForkWith(services);
          const graph = await harness.harness.watchTaskGraph(context);
          let latest: TaskGraph = graph.value;
          let doc: DocumentWatch<SubagentsState> | undefined;
          // Summaries are made one at a time, in the order the changes came.
          let chain: Promise<void> = Promise.resolve();
          let stopped = false;

          const publish = (): void => {
            if (stopped) return;

            chain = chain.then(async () => {
              try {
                const state = await harness.harness.snapshot(SubagentsDoc, context);

                Queue.offerUnsafe(queue, summarizeTaskGraph(latest, state ?? EMPTY_STATE));
              } catch (error) {
                // One failed read must not wedge the queue or leave the panel stale: log it and read again shortly.
                run(
                  Effect.logWarning("Task graph summary failed", error).pipe(
                    Effect.andThen(Effect.sleep(TASK_GRAPH_RETRY)),
                    Effect.andThen(Effect.sync(publish)),
                  ),
                );
              }
            });
          };

          /** Follow the Subagents document, which does not exist until the first spawn and changes alone when an idle agent is deleted. */
          const followDoc = async () => {
            if (doc !== undefined) return;

            doc = await harness.harness.watchDoc(SubagentsDoc, context);
            doc?.start(() => {
              publish();

              return Promise.resolve();
            });
          };

          await followDoc();
          publish();
          graph.start(async (value) => {
            latest = value;
            await followDoc();
            publish();
          });
          void graph.closed.then((end) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                SessionError.make({ operation: "watchTaskGraph", message: watchEnded(end) }),
              ),
            ),
          );

          return {
            graph,
            doc: () => doc,
            stop: () => {
              stopped = true;
            },
          };
        }),
        (watch) =>
          Effect.promise(async () => {
            watch.stop();
            await watch.graph.stop();
            await watch.doc()?.stop();
          }),
      ),
    ),
  ).pipe(
    // A burst of changes is one summary, and a change that alters nothing a client shows is none.
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, TASK_GRAPH_INTERVAL),
    Stream.map((summaries) => summaries[summaries.length - 1]!),
    Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
  );

  /** What the Workspace's Containers have cost, or null when it is not known: its failure only leaves it out. */
  const readContainerUsage = async (
    warn: (message: string) => void,
  ): Promise<ContainerUsage | null> => {
    try {
      return (await options.containerUsage?.()) ?? null;
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));

      return null;
    }
  };

  /** The Session's usage and limit; one per change, the first being how it stands. */
  const usageUpdates = Stream.callback<SessionUsage, SessionError>((queue) =>
    Effect.flatMap(Effect.context<never>(), (services) =>
      Effect.acquireRelease(
        attempt("watchUsage", async () => {
          const run = Effect.runForkWith(services);
          // Usage is committed with each response, so a request that ends changes the task graph after it.
          const graph = await harness.harness.watchTaskGraph(context);
          let stopped = false;
          // One read of the ledgers at a time: a change that comes meanwhile asks for one more read when this ends, however
          // many came, so a burst of work costs one scan at a time and never a backlog.
          let reading = false;
          let changed = false;

          const publish = (): void => {
            if (stopped) return;

            if (reading) {
              changed = true;

              return;
            }

            reading = true;
            void (async () => {
              try {
                do {
                  changed = false;

                  try {
                    const [totals, container] = await Promise.all([
                      sessionTotals(harness.harness, kv),
                      readContainerUsage((message) => {
                        run(Effect.logWarning("Container usage read failed", message));
                      }),
                    ]);

                    if (!stopped) {
                      Queue.offerUnsafe(
                        queue,
                        usageMessage(totals, settings.current().spendLimit, container),
                      );
                    }
                  } catch (error) {
                    // One failed read must not stop the watch: the next change reads again.
                    run(Effect.logWarning("Usage read failed", error));
                  }
                } while (changed && !stopped);
              } finally {
                reading = false;
              }
            })();
          };

          usageListeners.add(publish);
          publish();
          graph.start(() => {
            publish();

            return Promise.resolve();
          });
          void graph.closed.then((end) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(SessionError.make({ operation: "watchUsage", message: watchEnded(end) })),
            ),
          );

          return {
            graph,
            stop: () => {
              stopped = true;
              usageListeners.delete(publish);
            },
          };
        }),
        (watch) =>
          Effect.promise(async () => {
            watch.stop();
            await watch.graph.stop();
          }),
      ),
    ),
  ).pipe(
    // A burst of changes is one message, and a change that alters nothing a client shows is none.
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, USAGE_INTERVAL),
    Stream.map((updates) => updates[updates.length - 1]!),
    Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
  );

  const events = (conversationId: ConversationId) =>
    Stream.callback<ReadonlyArray<AgentEvent>, SessionError>((queue) =>
      Effect.acquireRelease(
        attempt("watch", () =>
          // pi-durable fails the watch of a conversation it does not have.
          watchEvents(harness.harness, conversationId, context),
        ),
        (watch) => Effect.promise(() => watch.stop()),
      ).pipe(
        Effect.andThen((watch) =>
          Effect.sync(() => {
            // The screenshots a snapshot carries are bounded: it is one socket message, whose size is capped. A snapshot
            // that comes later in a batch, to a client that fell behind, is bounded the same.
            Queue.offerUnsafe(queue, limitEventImages([watch.snapshot], SNAPSHOT_IMAGES));
            watch.start((batch) => {
              Queue.offerUnsafe(queue, limitEventImages(batch, SNAPSHOT_IMAGES));

              return Promise.resolve();
            });
            void watch.closed.then((end) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(SessionError.make({ operation: "watch", message: watchEnded(end) })),
              ),
            );
          }),
        ),
      ),
    );

  /** The Tasks a Todo document holds, as clients are sent them. */
  const tasksOf = (state: Readonly<TodoState> | null): ReadonlyArray<TodoTask> =>
    Arr.map(state?.tasks ?? [], (task) => {
      const sent: Types.Mutable<TodoTask> = { id: task.id, title: task.title, status: task.status };

      if (task.description !== undefined) sent.description = task.description;

      return sent;
    });

  const todos = (conversationId: ConversationId) =>
    Stream.callback<ReadonlyArray<TodoTask>, SessionError>((queue) =>
      Effect.acquireRelease(
        attempt("watchTodos", async () => {
          // A document exists once its conversation first used it, and only an existing one can be watched. Most watches
          // find it; the first of a conversation that never used the tool makes the empty list.
          if ((await harness.harness.snapshot(TodoDoc, conversationId, context)) === undefined) {
            await harness.harness.commit(async (tx) => {
              await tx.doc(TodoDoc, conversationId);
            }, context);
          }

          const watch = await harness.harness.watchDoc(TodoDoc, conversationId, context);

          if (watch === undefined) throw new Error("the Todo List document is missing");

          Queue.offerUnsafe(queue, tasksOf(watch.value));
          watch.start((state) => {
            Queue.offerUnsafe(queue, tasksOf(state));

            return Promise.resolve();
          });
          void watch.closed.then((end) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(SessionError.make({ operation: "watchTodos", message: watchEnded(end) })),
            ),
          );

          return watch;
        }),
        (watch) => Effect.promise(() => watch.stop()),
      ),
    ).pipe(
      // The document also changes with its revision alone, which no client shows.
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    );

  /** Why `conversation` cannot leave its place in the Session tree now, or nothing when it can. */
  const busyReason = (conversation: Conversation) =>
    Effect.all([
      attempt("snapshot", () => harness.harness.snapshot(LiveDoc, conversation.id, context)),
      attempt("snapshot", () => harness.harness.snapshot(InboxDoc, conversation.id, context)),
    ]).pipe(
      Effect.map(([live, inbox]): string | undefined => {
        if (live?.run !== undefined) return "a Run is in progress";

        if ((live?.compactions?.length ?? 0) > 0) return "the context is being compacted";

        if ((inbox?.items.length ?? 0) > 0) return "messages wait to be placed";

        if (pendingCompactions()[String(conversation.id)] !== undefined) {
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
      attempt("conversation", () => harness.harness.conversation(id, context)).pipe(
        Effect.flatMap((conversation) =>
          conversation === undefined
            ? Effect.succeed<BranchEntries[]>([])
            : attempt("conversation", () =>
                harness.harness.commit((tx) => tx.conversation(id), context),
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

  const sessionTree = Effect.gen(function* () {
    yield* root;

    const state = yield* treeState;

    return buildSessionTree(yield* readBranches(state), state);
  });

  /**
   * `/tree`: move the active branch to the point `request` names, forking or switching as `planNavigation` says, with a
   * summary of the branch left when asked. Messages wait meanwhile, so none lands on the branch being left.
   */
  const navigate = (request: NavigateRequest) =>
    Effect.gen(function* () {
      if (isCopying()) return yield* refuse(STILL_COPYING);

      const current = yield* active;

      yield* refuseWhileBusy(current);

      const state = yield* treeState;
      const branches = yield* readBranches(state);
      const plan = planNavigation(branches, state, request.entryId, request.position);

      if ("refused" in plan) return yield* refuse(plan.refused);

      const entry = Arr.findFirst(
        Arr.flatMap(branches, (branch) => branch.entries),
        (each) => each.id === request.entryId,
      );

      const text =
        request.position === "before" && Option.isSome(entry)
          ? ownerMessageText(entry.value)
          : null;

      const moving = plan.kind !== "switch" || plan.conversationId !== current.id;

      if (!moving) return { conversationId: current.id, text } satisfies Navigated;

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

      const abandoned =
        request.summary === undefined ? [] : abandonedEntries(branches, current.id, point);

      const model = wanted().model ?? null;
      const asked = abandoned.length === 0 ? undefined : request.summary;

      if (asked !== undefined && model === null) {
        return yield* refuse("There is no model to summarize the branch with.");
      }

      const summary =
        asked === undefined || model === null
          ? undefined
          : yield* summarizeBranch(models, model, abandoned, asked.instructions, (usage) => {
              // The call is in no conversation's ledger: the Session keeps it with the title calls'.
              recordTitleUsage(kv, usage);

              for (const listener of usageListeners) listener();
            }).pipe(Effect.mapError((error) => refuse(error.message)));

      const now = yield* Clock.currentTimeMillis;

      const target = yield* attempt("navigate", () =>
        harness.harness.commit(async (tx) => {
          const ownerless = { ownership: { kind: "ownerless" } } as const;
          let id: ConversationId;

          if (plan.kind === "switch") {
            id = plan.conversationId;
          } else if (plan.kind === "fork") {
            id = (await tx.forkConversation(plan.from, plan.at, ownerless)).id;
          } else {
            // Before the Session's first message: a branch of no entries, with the root's agent.
            id = (await tx.createConversation(ownerless)).id;
            copyAgent(
              await tx.doc(AgentDoc, id),
              structuredClone(await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)),
            );
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

  const switchBranch = (conversationId: ConversationId) =>
    Effect.gen(function* () {
      const current = yield* active;

      if (current.id === conversationId) return;

      yield* refuseWhileBusy(current);

      const state = yield* treeState;

      if (!Arr.contains(branchIds(state), conversationId)) {
        return yield* refuse(`Conversation ${conversationId} is not a Session branch.`);
      }

      const now = yield* Clock.currentTimeMillis;

      yield* attempt("switchBranch", () =>
        harness.harness.commit((tx) => activateBranch(tx, conversationId, now), context),
      );
    }).pipe(inArrivalOrder);

  /** Stop every Session branch, and every subagent below the active one's (all of them). */
  const stopEverything = Effect.gen(function* () {
    const current = yield* active;

    yield* attempt("abort", () =>
      stopConversation(harness.harness, current.id, { subagents: true }, context),
    );

    for (const id of branchIds(yield* treeState)) {
      if (id === current.id) continue;

      yield* attempt("abort", async () => {
        await (await harness.harness.conversation(id, context))?.abort(context);
      });
    }
  });

  const forkSource = (request: ForkSourceRequest) =>
    Effect.gen(function* () {
      const conversation = yield* active;

      // A Clone, or a Fork that carries the files, takes the branch as it stands: not while it is about to change.
      const busy = request.idle ? yield* busyReason(conversation) : undefined;

      if (busy !== undefined) {
        return yield* refuse(
          `The session cannot be copied while ${busy}: stop it or wait for it to end.`,
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

      if (request.entryId === undefined) {
        through = (yield* newest(undefined, 1))[0]?.id ?? null;
      } else {
        const [entry, before] = yield* newest(request.entryId, 2);

        if (entry?.id !== request.entryId) {
          return yield* refuse(`Entry ${request.entryId} is not on the active branch.`);
        }

        if (request.position === "before") {
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
        attempt("snapshot", () =>
          through === null
            ? harness.harness.snapshot(AgentDoc, conversation.id, context)
            : // SAFETY: an entry of the active branch's path.
              harness.harness.snapshotAsOf(AgentDoc, conversation.id, through as EntryId, context),
        ),
        attempt("snapshot", () => harness.harness.snapshot(ContextDoc, conversation.id, context)),
        attempt("snapshot", () => harness.harness.snapshot(TodoDoc, conversation.id, context)),
      ]);

      return {
        conversationId: conversation.id,
        through,
        text,
        agent: structuredClone(agent ?? NO_AGENT),
        pick: pickAsOf(picked(), agent ?? NO_AGENT),
        context: notes === undefined ? null : structuredClone(notes),
        todo: todo === undefined ? null : structuredClone(todo),
      } satisfies ForkPlan;
    });

  const exportEntries = (request: ExportRequest) =>
    // SAFETY: the conversation the plan named, a pi-durable conversation ID.
    attempt("conversation", () =>
      harness.harness.conversation(request.conversationId as ConversationId, context),
    ).pipe(
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

  const importStart = root.pipe(
    Effect.andThen(Effect.sync(() => kv.put(COPY_KEY, { ids: {} } satisfies Copy))),
  );

  const importEntries = (entries: ReadonlyArray<EntryRecord>) =>
    Effect.gen(function* () {
      const copy = kv.get<Copy | null>(COPY_KEY) ?? null;

      if (copy === null) {
        return yield* refuse("This Session is not being copied.");
      }

      const ids = new Map(
        Arr.map(Record.toEntries(copy.ids), ([key, value]) => [Number(key), value] as const),
      );

      yield* attempt("importEntries", () =>
        harness.harness.commit(async (tx) => {
          for (const entry of entries) {
            const appended = await tx.appendEntry(ROOT_CONVERSATION_ID, copiedDraft(entry, ids));

            ids.set(entry.id, appended.id);
          }
        }, context),
      );

      kv.put(COPY_KEY, {
        ids: Record.fromEntries(Arr.map([...ids], ([key, value]) => [String(key), value] as const)),
      } satisfies Copy);
    });

  const importFinish = (plan: ForkPlan) =>
    attempt("importFinish", () =>
      harness.harness.commit(async (tx) => {
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
          // What the source's context showed of the list named its own entries: the copy shows it afresh.
          todo.shown = null;
          todo.changedBy = [];
        }
      }, context),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          kv.put(PICK_KEY, plan.pick);
          kv.put(COPY_KEY, null);
        }),
      ),
    );

  yield* wakeAndResume;

  // A `/compact` that was waiting for a Run when the last instance went away waits again.
  for (const key of Record.keys(pendingCompactions())) {
    // SAFETY: the keys are the IDs of conversations a `/compact` was addressed to, written above.
    yield* compactWhenIdle(Number(key) as ConversationId);
  }

  return {
    submit: (prompt) => admit(prompt).pipe(Effect.map((submission) => submission.id)),
    prompt: answer,
    alarm: wakeAndResume,
    idle: inspect.pipe(
      Effect.map(({ tasks, submissions }) => tasks.length === 0 && submissions.length === 0),
    ),
    root: Effect.map(root, (conversation) => conversation.id),
    activeBranch: Effect.map(active, (conversation) => conversation.id),
    copying: Effect.sync(isCopying),
    tree: sessionTree,
    navigate,
    switchBranch,
    stopEverything,
    forkSource,
    exportEntries,
    importStart,
    importEntries,
    importFinish,
    configure: (change) =>
      refreshSettings.pipe(
        Effect.andThen(
          Effect.sync(() => kv.put(PICK_KEY, withChange(picked(), change))).pipe(
            Effect.andThen(applyAgent),
            serially,
          ),
        ),
      ),
    sync: refreshSettings.pipe(Effect.andThen(applyAgent.pipe(serially))),
    picks: Effect.sync(() => {
      const pick = picked();

      return { model: pick.model !== undefined, thinkingLevel: pick.thinkingLevel !== undefined };
    }),
    abort: (options = {}) =>
      addressed(options.conversationId).pipe(
        Effect.flatMap((conversation) =>
          attempt("abort", () =>
            stopConversation(
              harness.harness,
              conversation.id,
              { subagents: options.subagents === true },
              context,
            ),
          ),
        ),
      ),
    close: attempt("close", () => harness.harness.close(context)),
    taskGraph: taskGraphSummaries,
    usage: usageUpdates,
    events,
    todos,
    catalog: (conversationId) => addressed(conversationId).pipe(Effect.flatMap(catalogFor)),
    command: runCommand,
    files: ({ query, conversationId }) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) => filesFor(conversation, query)),
      ),
    history: ({ before, conversationId }) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) =>
          historyPage(
            (maxEntryId, limit, cursor) =>
              attempt("entries", () =>
                conversation.entries({ order: "descending", maxEntryId }, limit, cursor, context),
              ),
            before,
          ),
        ),
      ),
  } satisfies SessionHostService;
});

/**
 * The Session's services over the object's storage: its `Harness` and its `SessionHost`. Building it opens the
 * Harness and resumes interrupted work, so build it once, from the object's constructor inside
 * `blockConcurrencyWhile`.
 */
export const sessionHostLayer = <R = never>(
  options: SessionHostOptions<R>,
): Layer.Layer<SessionHost | Harness, SessionError, SessionRegistry | SessionSettings | R> =>
  Layer.effect(SessionHost, startSessionHost(options)).pipe(
    Layer.provide(fileListingsLayer()),
    Layer.provideMerge(Layer.effect(Harness, openSessionHarness(options))),
  );
