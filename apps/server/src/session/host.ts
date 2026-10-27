// @effect-diagnostics asyncFunction:off -- the task graph watch is pi-durable Promise code, as the Harness's own callbacks are.
// Hosts one pi-durable Harness in a Session Durable Object, the way pi-durable's own `test-workers/worker.ts` does:
// opened over the object's SQLite storage and woken by its alarm (ADR-0002). The Harness stays native Promise code,
// reached through the `Harness` facade and `Effect.tryPromise` (ADR-0003). The object builds both services once, as
// one Layer kept in a `ManagedRuntime`.
import { Harness, type HarnessError, openHarness } from "@cloudpid/effect-durable";
import {
  type AgentWorkspace,
  conversationWorkspace,
  deleteAgent,
  isAgentConversation,
  isAgentConversationIn,
  EMPTY_SUBAGENTS_STATE as EMPTY_STATE,
  type OwnerDeletion,
  stopConversation,
  type SubagentWorkspaceHost,
  SubagentsDoc,
  type SubagentsState,
} from "@cloudpid/extensions/subagents";
import { clearTodoList, TodoDoc, type TodoState } from "@cloudpid/extensions/todo";
import { MAX_ROLLOVER_FOCUS, ownerRollover } from "@cloudpid/extensions/context";
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
  type Catalog,
  type CommandOutcome,
  type FileMatches,
  type HistoryPage,
  type Navigated,
  type SessionTree,
  type SessionUsage,
  type ContainerUsage,
  type ContextUsage,
  type TaskGraphSummary,
  type TodoTask,
  type AttachedPage,
  clampPage,
  pageBlock,
  UPLOADS_ROOT,
  USER_ENTRY_KIND,
  userEntryData,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, Usage } from "@earendil-works/pi-ai";
import { limitEventImages, SNAPSHOT_IMAGES } from "@cloudpid/extensions/browser";
import {
  type Agent,
  type AgentChange,
  type DocumentWatch,
  type EntryRecord,
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
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Record from "effect/Record";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type * as Types from "effect/Types";
import type { PushEvent } from "../push/notification.ts";
import { AgentChangeLog } from "@cloudpid/extensions/environment";
import { SettingsReload, type SettingsApplied } from "@cloudpid/extensions/settings";
import { agentChangesNotice, runChanges } from "./agent-changes.ts";
import {
  harnessSettings,
  SessionSettings,
  type SessionSettingsValues,
  type SettingsKv,
} from "./settings.ts";
import {
  type Ledger,
  limitingModels,
  recordUnledgeredUsage,
  sessionTotals,
  usageMessage,
} from "./spend.ts";
import { catalogOf, MAX_EXPORT_BYTES, markdownExport } from "./commands.ts";
import { contextUsageOf } from "./context-usage.ts";
import { attempt, refuse, SessionError } from "./errors.ts";
import { contentText } from "./text.ts";
import { expandMessage, mayExpand } from "./expand.ts";
import { historyPage } from "./history.ts";
import { FileListings, fileListingsLayer, listedPaths, matchFiles } from "./file-search.ts";
import { inputProblem, storedBytes } from "./input-guard.ts";
import { SessionRegistry, type SessionStatus } from "./status.ts";
import { summarizeTaskGraph } from "./task-graph.ts";
import { AgentsReport, sessionAgentsOf } from "./agents-report.ts";
import { EXCHANGE_ENTRIES, firstExchange, titleTask } from "./titles.ts";
import { type NavigateRequest, sessionBranches } from "./branches.ts";
import { branchIds } from "./tree.ts";
import type { ExportPage, ExportRequest, ForkPlan, ForkSourceRequest } from "./fork.ts";
import { isFilling, sessionForks, STILL_FILLING } from "./fork-host.ts";
import { type AgentPick, PICK_KEY, pickedIn, withChange } from "./pick.ts";

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

/** How many entries `/export` reads at a time. */
const EXPORT_PAGE = 500;

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
  /**
   * The extensions the Session's conversations run with, installed before any work resumes. Their Agent changes
   * (`AgentChangeLog`) are kept for the Notification at the end of the Run, and the Settings they change are read
   * again, and the root conversation's agent brought to the default, through `SettingsReload`.
   */
  readonly extensions: Effect.Effect<
    readonly Extension[],
    never,
    Harness | SessionSettings | AgentChangeLog | SettingsReload | R
  >;
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
   * What the Containers of the Session's Workspace and of `subagents`' Workspaces (each Subagent Workspace's object, as
   * the Subagents document has it) have cost, read with its usage (null: none ran, or the Session has no Workspace). A
   * read that fails leaves it out of that message.
   */
  readonly containerUsage?:
    | ((subagents: ReadonlyArray<string>) => Promise<ContainerUsage | null>)
    | undefined;
  /** The Session's Subagent Workspaces, which the owner's delete of a subagent removes. */
  readonly subagentWorkspaces?: SubagentWorkspaceHost | undefined;
  /** How long a report to the Registry may take before it counts as failed. Defaults to `REPORT_TIMEOUT`. */
  readonly reportTimeout?: Duration.Input;
  /** The shortest time between two writes of the subagents to the Registry. Defaults to `AGENTS_REPORT_INTERVAL_MS`. */
  readonly agentsReportMs?: number;
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
  /**
   * Reads the Owner tabs the owner attached (`BrowserPane.attach`, redacted of held Secrets): run as the message is
   * admitted, in arrival order and only when it is new (a resent `requestId` finds the first submission without reading
   * again), so that a later message is not admitted first and a page that closed since cannot fail a message already
   * admitted. What it reads reaches the model as a block of page content after the typed text and the Attachments'
   * paths, and the owner's entry keeps it for the chip.
   */
  readonly attachPages?: Effect.Effect<ReadonlyArray<AttachedPage>, SessionError>;
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

/** The longest a change to the task graph waits before it is sent. */
export const TASK_GRAPH_INTERVAL: Duration.Input = "250 millis";

/** The longest a change to the Session's usage waits before it is sent. */
export const USAGE_INTERVAL: Duration.Input = "500 millis";

/** How long to wait before reading the Subagents document again after a read failed. */
const TASK_GRAPH_RETRY: Duration.Input = "1 second";

export type Answer =
  | { readonly status: "answered"; readonly submissionId: number; readonly text: string }
  | { readonly status: "unanswered"; readonly submissionId: number; readonly reason: string };

export type SessionHostService = {
  /** Durably admit `prompt` to its conversation (the active branch's by default) and return its submission ID. */
  readonly submit: (prompt: Prompt) => Effect.Effect<number, SessionError>;
  /** Submit `prompt` and wait for its answer. */
  readonly prompt: (prompt: Prompt) => Effect.Effect<Answer, SessionError>;
  /** The alarm handler: keep the heartbeat while work is live, and resume it. */
  readonly alarm: Effect.Effect<void, SessionError>;
  /** Whether no task is live and no submission is unsettled. Reads only: it never starts work. */
  readonly idle: Effect.Effect<boolean, SessionError>;
  /**
   * Reconcile the alarm and the Registry with what is live now, as the end of a Run does: for a change outside a Run to
   * when the object must wake (the Browser Pane's use of the browser, which moves its idle close).
   */
  readonly settle: Effect.Effect<void, SessionError>;
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
  /** Take messages again once a Fork or Clone in a new Workspace carried this Session's files. */
  readonly releaseFork: Effect.Effect<void>;
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
   * Delete subagent `agent` with everything below it, as `subagent_delete` with `discard: true` does, Subagent Workspaces
   * included: the owner removed its Subagent Workspace `workspace` from the Environments page, after a confirmation. An
   * agent that does not work in `workspace` is not deleted.
   */
  readonly deleteSubagent: (
    agent: string,
    workspace: string,
  ) => Effect.Effect<OwnerDeletion, SessionError>;
  /**
   * Close the Harness: admission is sealed and the commits it admitted settle, so nothing writes the storage after. Every
   * later call fails; the object is reset before it serves another. For a Session being deleted.
   */
  readonly close: Effect.Effect<void, SessionError>;
  /**
   * The Subagent Workspace conversation `conversationId` works in (its agent's own, or its nearest ancestor's), or
   * undefined for one that works in the Session's Workspace. Fails for a conversation that is no agent's: neither a
   * Session branch (the root agent's) nor a live subagent's.
   */
  readonly workspaceOf: (
    conversationId: ConversationId,
  ) => Effect.Effect<AgentWorkspace | undefined, SessionError>;
  /**
   * `workspaceOf` as it stands, then again each time it changes: a Subagent Workspace given to the conversation's agent
   * or to an ancestor. Fails once the conversation is no agent's (its subagent deleted), or when the Harness ends the
   * watch.
   */
  readonly workspaces: (
    conversationId: ConversationId,
  ) => Stream.Stream<AgentWorkspace | undefined, SessionError>;
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

  /** The Agent changes of the Run, kept until its end notifies them. */
  const changes = runChanges(storage.kv);

  // Before anything resumes, so resumed tool calls find their tools.
  const installed = yield* options.extensions.pipe(
    Effect.provideService(AgentChangeLog, { record: changes.record }),
    Effect.provideService(SettingsReload, { apply: Effect.suspend(() => reloadSettings) }),
  );

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
  const picked = (): AgentPick => pickedIn(kv);

  /** The conversations whose `/compact` waits for their Run to end, with the focus asked for. */
  const pendingCompactions = (): Readonly<Record<string, string>> =>
    kv.get<Record<string, string>>(COMPACT_KEY) ?? {};

  /** Count one of the Session's own model calls (the title call, a branch summary) in its spend. */
  const recordUsage = (usage: Usage): void => {
    recordUnledgeredUsage(kv, usage);

    for (const listener of usageListeners) listener();
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

  const branches = sessionBranches({
    harness: harness.harness,
    root,
    models,
    wanted,
    onUsage: recordUsage,
    pendingCompactions,
    refusal: () => (isFilling(kv) ? STILL_FILLING : undefined),
    inArrivalOrder,
  });

  const { active, treeState } = branches;

  /** Bring the active branch's agent to the one it wants, so its next request runs on it; nothing is written when it does. */
  const applyAgent = Effect.gen(function* () {
    const conversation = yield* active;
    const want = wanted();
    const have = yield* attempt("agent", () => conversation.agent(context));

    if (sameAgent(have, want)) return;

    yield* attempt("configure", () => conversation.configure(want, context));
  });

  /**
   * Read the settings again after the agent changed them, and bring the active branch's agent to the default, so its
   * next request uses it. A read or a write that fails is logged and left: the Session carries on with the settings it
   * last read, and reads them when it next admits input. Says whether the Session picked its own model and level.
   */
  const reloadSettings: Effect.Effect<SettingsApplied> = refreshSettings.pipe(
    Effect.andThen(applyAgent.pipe(serially)),
    Effect.andThen(Effect.suspend(() => usageChanged)),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Reading the settings after an Agent change failed; the Session reads them when it next admits input",
        cause,
      ),
    ),
    Effect.andThen(
      Effect.sync(() => {
        const pick = picked();

        return {
          picked: {
            model: pick.model !== undefined,
            thinkingLevel: pick.thinkingLevel !== undefined,
          },
        };
      }),
    ),
  );

  const inspect = harness.inspect.pipe(fromHarness);

  const forks = sessionForks({
    harness: harness.harness,
    kv,
    root,
    active,
    busyReason: branches.busyReason,
    inspect,
    pendingCompactions,
    picked,
    inArrivalOrder,
  });

  /**
   * Names the Session after its first answer (`docs/spec.md` → Client and protocol → Titles). The root's first message
   * and answer come from its first entries; a first Run so long that its answer is past them is named by its message.
   */
  const titles = titleTask({
    kv,
    models,
    // The call is counted in the Session's spend, though no conversation holds it.
    onUsage: recordUsage,
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

  const runAgents = Effect.runForkWith(yield* Effect.context<never>());
  const writeAgents = Effect.runPromiseWith(yield* Effect.context<never>());

  /**
   * The Session's subagents as the Registry lists them (ADR-0024): written when they change (`watchAgents`, below), at
   * most once an interval, and whenever the Session settles, so at each start and after a stop. A write that fails is
   * written again by the heartbeat, as a status report is.
   */
  const agentsReport = new AgentsReport({
    read: async () => {
      const graph = await harness.harness.taskGraph(context);

      try {
        const state = await harness.harness.snapshot(SubagentsDoc, context);

        return sessionAgentsOf(summarizeTaskGraph(graph.value, state ?? EMPTY_STATE).agents);
      } finally {
        graph.dispose();
      }
    },
    write: (agents) =>
      writeAgents(
        registry.reportAgents(agents).pipe(Effect.timeout(options.reportTimeout ?? REPORT_TIMEOUT)),
      ),
    intervalMs: options.agentsReportMs,
    warn: (message, cause) => {
      runAgents(Effect.logWarning(message, cause));
    },
  });

  /** Read the subagents now, write them if the Registry has them otherwise, and say whether it has them. */
  const settleAgents = Effect.promise(() => agentsReport.settle());

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
      ? // The heartbeat first: a report that cannot be made must not leave live work unwoken. Each beat writes again
        // the subagents a failed write left due.
        armHeartbeat.pipe(
          Effect.andThen(report("running")),
          Effect.andThen(Effect.sync(() => agentsReport.retry())),
          Effect.asVoid,
        )
      : // Report before deleting the heartbeat: an unreported end, or subagents unwritten, keep it, to report again.
        onIdle.pipe(
          Effect.andThen(report("idle")),
          Effect.flatMap((told) => Effect.map(settleAgents, (written) => told && written)),
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

    // Besides the Run's own: one Notification of the Agent changes it made, which wait for the next end if it fails.
    const changed = yield* changes.pending;

    if (changed.length > 0 && (yield* notifyOwner(agentChangesNotice(changed)))) {
      yield* changes.drop(changed.length);
    }
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
      : Effect.all([active, treeState]).pipe(
          Effect.flatMap(([current, state]) => {
            if (current.id === conversationId) return Effect.succeed(current);

            // Only the active branch is the root agent's now: another branch is reached by making it active.
            if (Arr.contains(branchIds(state), conversationId)) {
              return Effect.fail(
                SessionError.make({
                  operation: "agent",
                  message: `Conversation ${conversationId} is a Session branch that is not the active one`,
                }),
              );
            }

            return subagentConversation(conversationId);
          }),
        );

  /** Why `conversationId` cannot be addressed: it is no agent's. */
  const notAnAgent = (conversationId: ConversationId) =>
    SessionError.make({
      operation: "agent",
      message: `Conversation ${conversationId} is not the root or a subagent of this Session`,
    });

  /** Fails unless `conversationId` is an agent's: a Session branch's or a live subagent's. */
  const agentConversation = (conversationId: ConversationId) =>
    attempt("agent", () => isAgentConversation(harness.harness, conversationId, context)).pipe(
      Effect.filterOrFail(
        (known) => known,
        () => notAnAgent(conversationId),
      ),
    );

  /** The conversation of a live subagent, `conversationId`; anything else fails. */
  const subagentConversation = (conversationId: ConversationId) =>
    agentConversation(conversationId).pipe(
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

  /** Fail while the Session takes no message: it is being filled as a Fork or Clone, or carries its files to one. */
  const unlessForking = forks.refusal.pipe(
    Effect.flatMap((refusal) =>
      refusal === undefined
        ? Effect.void
        : Effect.fail(SessionError.make({ operation: "submit", message: refusal })),
    ),
  );

  /**
   * Admit `draft` to conversation `conversationId` (the active branch's by default). `named` says whether the Session may
   * be named after it: only the owner's own messages to the active branch name it, a subagent's conversation being the
   * root agent's own work and a Rollover request not being the owner's words. Refused while the Session is being filled
   * as a Fork or Clone, or carries its files to one.
   */
  const admitDraft = (
    conversationId: ConversationId | undefined,
    draft: InputSubmissionDraft,
    named: boolean,
  ): Effect.Effect<Submission, SessionError> =>
    Effect.gen(function* () {
      yield* unlessForking;

      // The next request runs on the settings in force now. The read stays out of the lock, so a slow Registry never
      // holds up the alarm or a status report.
      yield* refreshSettings;

      // Another conversation is checked before arming: a bad ID must not report the Session running to the Registry.
      const other = conversationId === undefined ? undefined : yield* addressed(conversationId);
      const toActive = other === undefined || other.id === (yield* active).id;

      // A subagent keeps the agent it was started with; only the active branch follows the settings and the owner's pick.
      const target =
        other === undefined || toActive
          ? applyAgent.pipe(Effect.andThen(active))
          : Effect.succeed(other);

      // Arm before admitting work: an object that dies after the commit is still woken.
      const submission = yield* arm({ active: true }).pipe(
        Effect.andThen(target),
        Effect.flatMap((conversation) =>
          tracedRun(
            conversation.id,
            attempt("submit", () => conversation.submit(draft, context)),
          ),
        ),
        // The owner hears how this Run ends, even after an eviction: the submission is kept until it is told.
        Effect.tap((admitted) =>
          Effect.sync(() => {
            kv.put(NOTIFY_KEY, Arr.dedupe([...pendingNotices(), admitted.id]));
          }),
        ),
        serially,
      );

      yield* settleWhenIdle;

      if (toActive && named) yield* titleAfter(submission);

      return submission;
    });

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
  const pathsIn = (env: ExecutionEnv) =>
    listedPaths(listings, env, context).pipe(
      Effect.mapError((error) => SessionError.make({ operation: "files", message: error.message })),
    );

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

  /**
   * What the owner typed, when `input` has pages attached: its first text part, unless that is the Attachments' paths
   * (they are a part of their own and come after the typed text, which is left out when empty).
   */
  const typedBeside = (input: UserInput): string => {
    const typed = typedText(input);

    return typed === undefined || typed.startsWith(`@${UPLOADS_ROOT}/`) ? "" : typed;
  };

  const withPages = (
    draft: InputSubmissionDraft,
    input: UserInput,
    pages: ReadonlyArray<AttachedPage>,
  ): InputSubmissionDraft => {
    const block = { type: "text" as const, text: pageBlock(pages) };

    const parts = Predicate.isString(draft.content)
      ? draft.content === ""
        ? []
        : [{ type: "text" as const, text: draft.content }]
      : [...draft.content];

    const at = Option.getOrElse(
      Arr.findFirstIndex(parts, (part) => part.type === "image"),
      () => parts.length,
    );

    const data = userEntryData({ kind: draft.entry?.kind ?? "", data: draft.entry?.data });

    return {
      ...draft,
      content: [...parts.slice(0, at), block, ...parts.slice(at)],
      entry: {
        kind: USER_ENTRY_KIND,
        data: {
          display: data?.display ?? typedBeside(input),
          skills: [...(data?.skills ?? [])],
          pages: Arr.map(pages, (page) => clampPage(page)),
        },
      },
    };
  };

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
  const expandedDraft = (prompt: Prompt): Effect.Effect<InputSubmissionDraft, SessionError> => {
    const { conversationId, input, attachPages: _attachPages, ...rest } = prompt;
    const typed = typedText(input);
    const plain: InputSubmissionDraft = { type: "input", content: input, ...rest };

    if (typed === undefined || !mayExpand(typed)) return Effect.succeed(plain);

    // The lookup environment, which never starts the Container (ADR-0018): what a message names is in the Workspace.
    const expansion = (conversation: Conversation) =>
      environment(conversation, { lookup: true }).pipe(
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
   * `draft` with the pages attached to `prompt`: their block of page content as a text part of its own, before the first
   * image (the pages' screens, then the Attachments' pictures), apart from the owner's words, and the entry that keeps
   * what was read of them for the transcript's chips (`docs/spec.md` → Attached pages).
   */
  const draftOf = (prompt: Prompt): Effect.Effect<InputSubmissionDraft, SessionError> =>
    expandedDraft(prompt).pipe(
      Effect.flatMap((draft) =>
        attachedPages(prompt).pipe(
          Effect.map((pages) =>
            pages.length === 0 ? draft : withPages(draft, prompt.input, pages),
          ),
        ),
      ),
    );

  /**
   * The pages `prompt` attaches, read now. Not read for a `requestId` the conversation has already admitted: that
   * submit finds the first submission, whatever the pages are now.
   */
  const attachedPages = (
    prompt: Prompt,
  ): Effect.Effect<ReadonlyArray<AttachedPage>, SessionError> => {
    const { attachPages, requestId } = prompt;

    if (attachPages === undefined) return Effect.succeed([]);

    if (requestId === undefined) return attachPages;

    return addressed(prompt.conversationId).pipe(
      Effect.flatMap((conversation) =>
        // A commit that writes nothing is discarded: a read through pi-durable's own path.
        attempt("submissionByRequest", () =>
          conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context),
        ),
      ),
      Effect.flatMap((admitted) => (admitted === undefined ? attachPages : Effect.succeed([]))),
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

  const admit = (prompt: Prompt): Effect.Effect<Submission, SessionError> =>
    // A message the Session would refuse is not expanded first.
    unlessForking.pipe(
      Effect.andThen(draftOf(prompt)),
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

    const text = message?.role === "assistant" ? contentText(message.content, "") : "";

    return { status: "answered", submissionId: submission.id, text } satisfies Answer;
  });

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
      if (options.containerUsage === undefined) return null;

      const state = await harness.harness.snapshot(SubagentsDoc, context);

      const subagents = Arr.flatMap(Record.values(state?.agents ?? {}), (agent) =>
        agent.workspace === undefined ? [] : [agent.workspace.object],
      );

      return (await options.containerUsage(subagents)) ?? null;
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));

      return null;
    }
  };

  /** Tell the watches of the Session's usage that it changed outside the Harness's ledgers. */
  const usageChanged = Effect.sync(() => {
    for (const listener of usageListeners) listener();
  });

  /** The active branch's Context Window as last read, and what it was read at: an unchanged branch is not read again. */
  let lastContext: { readonly key: string; readonly usage: ContextUsage | null } | undefined;

  /**
   * How full the active branch's Context Window is; null when its model's context window is not known. A task graph
   * changes far more often than the transcript (every tool call), so the context is read again only when the branch,
   * its newest entry, its model's window or the compaction settings changed.
   */
  const readContextUsage = Effect.gen(function* () {
    const conversation = yield* active;
    const agent = yield* attempt("agent", () => conversation.agent(context));

    const contextWindow =
      agent.model === undefined
        ? undefined
        : models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;

    if (contextWindow === undefined || contextWindow <= 0) return null;

    const { compaction } = settings.current();

    const newest = yield* attempt("entries", () => conversation.entries({}, 1, undefined, context));

    const key = `${conversation.id} ${newest.items[0]?.id ?? "none"} ${contextWindow} ${compaction.enabled} ${compaction.reserveTokens} ${compaction.backgroundTokens}`;

    if (lastContext?.key === key) return lastContext.usage;

    const view = yield* attempt("context", () => conversation.context(context));
    const usage = contextUsageOf(view, contextWindow, compaction);

    lastContext = { key, usage };

    return usage;
  }).pipe(
    // Its failure only leaves it out, as the Containers' does.
    Effect.catch((error) =>
      Effect.logWarning("Context usage read failed", error).pipe(Effect.as(null)),
    ),
  );

  /** The Session's usage and limit; one per change, the first being how it stands. */
  const usageUpdates = Stream.callback<SessionUsage, SessionError>((queue) =>
    Effect.flatMap(Effect.context<never>(), (services) =>
      Effect.acquireRelease(
        attempt("watchUsage", async () => {
          const run = Effect.runForkWith(services);
          const runPromise = Effect.runPromiseWith(services);
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
                    const [totals, container, contextUsage] = await Promise.all([
                      sessionTotals(harness.harness, kv),
                      readContainerUsage((message) => {
                        run(Effect.logWarning("Container usage read failed", message));
                      }),
                      runPromise(readContextUsage),
                    ]);

                    if (!stopped) {
                      Queue.offerUnsafe(
                        queue,
                        usageMessage(
                          totals,
                          settings.current().spendLimit,
                          container,
                          contextUsage,
                        ),
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

  /**
   * The Subagent Workspace `conversationId` works in, then again at each change of the Subagents document that changes
   * it; fails once the conversation is no agent's. The document does not exist until the first spawn: until then only
   * the Session's branches are agents', and they work in the Session's Workspace, so there is nothing to follow.
   */
  const workspaces = (conversationId: ConversationId) =>
    Stream.callback<AgentWorkspace | undefined, SessionError>((queue) =>
      Effect.acquireRelease(
        attempt("watchWorkspace", async () => {
          const watch = await harness.harness.watchDoc(SubagentsDoc, context);

          const publish = (read: Readonly<SubagentsState> | null | undefined): void => {
            const state = read ?? EMPTY_STATE;

            if (isAgentConversationIn(state, conversationId)) {
              Queue.offerUnsafe(queue, conversationWorkspace(state, conversationId));
            } else {
              Queue.failCauseUnsafe(queue, Cause.fail(notAnAgent(conversationId)));
            }
          };

          publish(watch?.value);
          watch?.start((state) => {
            publish(state);

            return Promise.resolve();
          });
          void watch?.closed.then((end) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                SessionError.make({ operation: "watchWorkspace", message: watchEnded(end) }),
              ),
            ),
          );

          return watch;
        }),
        (watch) => Effect.promise(async () => watch?.stop()),
      ),
    ).pipe(
      // The document changes with every agent's status too, which leaves the Workspace as it was.
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
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

  /**
   * Follow the task graph and the Subagents document, which does not exist until the first spawn and changes alone when
   * an idle agent is deleted or given a Workspace, for the Registry's summary of the subagents. Started before work
   * resumes, so no change is missed; one that cannot start leaves the summary to each settle.
   */
  yield* Effect.acquireRelease(
    attempt("watchAgents", async () => {
      const graph = await harness.harness.watchTaskGraph(context);
      let doc: DocumentWatch<SubagentsState> | undefined;
      let following: Promise<void> | undefined;

      /** Watch the document once it exists; one that does not yet, or fails to, is tried at the next change. */
      const watchDoc = async (): Promise<void> => {
        try {
          doc = await harness.harness.watchDoc(SubagentsDoc, context);
        } catch (error) {
          runAgents(Effect.logWarning("Watching the Subagents document failed", error));
        }

        doc?.start(() => {
          agentsReport.changed();

          return Promise.resolve();
        });
      };

      const followDoc = (): Promise<void> => {
        following ??= watchDoc().finally(() => {
          following = undefined;
        });

        return following;
      };

      await followDoc();
      graph.start(async () => {
        if (doc === undefined) await followDoc();

        agentsReport.changed();
      });

      return { graph, doc: () => doc };
    }),
    (watch) =>
      Effect.promise(async () => {
        agentsReport.stop();
        await watch.graph.stop();
        await watch.doc()?.stop();
      }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Watching the subagents for the Registry failed", error),
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
    settle,
    root: Effect.map(root, (conversation) => conversation.id),
    activeBranch: Effect.map(active, (conversation) => conversation.id),
    copying: forks.filling,
    tree: branches.tree,
    // Another branch, or another model, is another Context Window: the clients that watch the usage hear of it at once.
    navigate: (request) => branches.navigate(request).pipe(Effect.tap(usageChanged)),
    switchBranch: (conversationId) =>
      branches.switchBranch(conversationId).pipe(Effect.tap(usageChanged)),
    // What stopped reaches the Registry's summary of the subagents at once: an archived Session keeps it.
    stopEverything: branches.stopEverything.pipe(Effect.andThen(settleAgents), Effect.asVoid),
    forkSource: forks.forkSource,
    exportEntries: forks.exportEntries,
    importStart: forks.importStart,
    importEntries: forks.importEntries,
    importFinish: forks.importFinish,
    releaseFork: forks.releaseFork,
    configure: (change) =>
      refreshSettings.pipe(
        Effect.andThen(
          Effect.sync(() => kv.put(PICK_KEY, withChange(picked(), change))).pipe(
            Effect.andThen(applyAgent),
            serially,
          ),
        ),
        Effect.tap(usageChanged),
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
    deleteSubagent: (agent, workspace) =>
      attempt("deleteSubagent", () =>
        deleteAgent(harness.harness, agent, workspace, options.subagentWorkspaces, context),
      ),
    close: Effect.sync(() => agentsReport.stop()).pipe(
      Effect.andThen(attempt("close", () => harness.harness.close(context))),
    ),
    workspaceOf: (conversationId) =>
      agentConversation(conversationId).pipe(
        Effect.andThen(attempt("workspace", () => harness.harness.snapshot(SubagentsDoc, context))),
        Effect.map((state) =>
          state === undefined ? undefined : conversationWorkspace(state, conversationId),
        ),
      ),
    workspaces,
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
