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
  type AttachedReadInput,
  type AttachedReadResult,
  MCP_TASK_FOLLOWER,
  type McpCompletionInput,
  type McpNotices,
  mcpNotices,
  type McpQuestionCopy,
  type McpSamplingBinding,
  McpTasksDoc,
  type OwnerCancel,
  type OwnerKeep,
  type PromptSummaries,
  type ResourceMenuInput,
  type SweepHarness,
  type TaskOwnerHarness,
  PREVIEW_SLOT_OVER,
  viewOfTasks,
} from "@cloudpid/extensions/mcp";
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
  type EntriesPage,
  type FileMatches,
  type Navigated,
  type SessionTree,
  type SessionUsage,
  type ContainerUsage,
  type ContextUsage,
  type TaskGraphSummary,
  type McpTask,
  type TodoTask,
  type Annotation,
  type AttachedPage,
  type AttachedResource,
  ATTACHED_RESOURCE_GONE,
  attachedResourceGoneMessage,
  resourceKey,
  attachmentPath,
  INLINE_IMAGE_BUDGET,
  type McpPromptData,
  type McpPromptErrorCode,
  type McpPromptRef,
  type McpCompletion,
  type McpResourceMenu,
  MCP_COMPLETION_STATUS,
  MCP_PROMPT_NOT_PICKED_MESSAGE,
  MAX_RESOURCES_INLINE_TEXT_BYTES,
  noCompletion,
  type ResourceRef,
  looksLikeMcpPromptCommand,
  promptArguments,
  promptArgumentsProblem,
  type McpAppCopy,
  type VisualCopy,
  SessionVia,
  clampPage,
  pageBlock,
  type RenderedReview,
  renderReview,
  type ReviewData,
  reviewMessage,
  UPLOADS_ROOT,
  USER_ENTRY_KIND,
  type UserEntryData,
  userEntryData,
  type McpAppCopies,
  type VisualCopies,
  type SentAppMessage,
  base64FromBytes,
  isMcpSpillPath,
  MAX_MCP_RESOURCE_PREVIEW_BYTES,
  MAX_VISUAL_BYTES,
  type FirePayload,
  type PayloadMade,
  payloadFilePath,
  triggerPayload,
  type TriggerPayloadChip,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isBase, type Op } from "@earendil-works/chord/delta";
import type { Models, Usage } from "@earendil-works/pi-ai";
import { limitOpsImages, limitViewImages, WATCH_IMAGES } from "@cloudpid/extensions/browser";
import {
  type Agent,
  type AgentChange,
  type DocumentWatch,
  type EntryRecord,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  DEFAULT_RESTART_LIMIT,
  type EntryId,
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
  type TaskId,
  type TaskInspection,
  ToolTask,
  type UserInput,
  type WatchEnd,
  type ConversationView,
  type ConversationWindow,
  type EntryQuery,
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
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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
  ledgerGate,
  limitingModels,
  overLimitReason,
  recordSamplingUsage,
  recordUnledgeredUsage,
  samplingTotals,
  sessionTotals,
  usageMessage,
} from "./spend.ts";
import { catalogOf, MAX_EXPORT_BYTES, markdownExport } from "./commands.ts";
import type { SessionMcpRecords } from "./mcp-records.ts";
import { contextUsageOf } from "./context-usage.ts";
import type { ImportDefaults } from "./import-model.ts";
import type { HeldStop } from "../workspace/idle.ts";
import { showHeldStops as showHeldStopsIn } from "./held-stops.ts";
import { attempt, CONVERSATION_MISSING, refuse, SessionError, withdrawnFailure } from "./errors.ts";
import type { AppContextCall, AppContexts } from "./mcp-app-context.ts";
import type { PromptCatalog } from "./mcp-prompt-catalog.ts";
import type { HoldSlot, SpillRead } from "./mcp-resource-previews.ts";
import type { WorkspaceFileRead } from "./visual-file.ts";
import { promptFileName, promptMessage, type PromptFile } from "./mcp-prompt.ts";
import {
  type AttachedBudgets,
  type AttachedMade,
  type AttachedMessage,
  attachedMessage,
  attachedResource,
  failedResource,
} from "./mcp-attached.ts";
import {
  imageCharacters,
  promptContent,
  promptData,
  promptPartCount,
  promptRefusal,
  redactedError,
  typedAndBeside,
} from "./mcp-prompt-send.ts";
import { linkSkillReferences } from "./skill-references.ts";
import { contentText } from "./text.ts";
import { expandMessage, mayExpand } from "./expand.ts";
import { entriesPage } from "./entries-page.ts";
import type { EntriesRequest, FollowState, SettledInput } from "./mcp-reads.ts";
import { FileListings, fileListingsLayer, listedPaths, matchFiles } from "./file-search.ts";
import { cropParts, fitCrops } from "./crops.ts";
import { type InputProblem, inputProblemOf, storedBytes } from "./input-guard.ts";
import { SessionRegistry, type SessionStatus } from "./status.ts";
import { earliest, type EndedCall } from "./wake.ts";
import { summarizeTaskGraph } from "./task-graph.ts";
import { AgentsReport, sessionAgentsOf } from "./agents-report.ts";
import { EXCHANGE_ENTRIES, firstExchange, titleTask } from "./titles.ts";
import { type NavigateRequest, sessionBranches } from "./branches.ts";
import { branchIds } from "./tree.ts";
import type { ExportPage, ExportRequest, ForkPlan, ForkSourceRequest } from "./fork.ts";
import { admissionLines } from "./admission.ts";
import { fillingRefusal, sessionForks, type WrittenTranslation } from "./fork-host.ts";
import { type AgentPick, PICK_KEY, pickedIn, withChange } from "./pick.ts";

const context = BACKGROUND_CONTEXT;

/** The kind of the display-only entry that says a Stop came over the MCP endpoint. */
export const MCP_NOTICE_KIND = "cloudpid.mcp-notice";

/** How often the alarm wakes the object while work is live, so a run an eviction cut off resumes. */
export const HEARTBEAT_MS = 60_000;

/** Where the host keeps how many MCP tasks it last told the Registry the Session follows, and what stands for "unknown". */
const REPORTED_TASKS_KEY = "mcp-tasks-reported";
const REPORT_PENDING = -1;

/** How long a report to the Registry may take before it counts as failed. */
export const REPORT_TIMEOUT: Duration.Input = "5 seconds";

/**
 * How long a notification may take. The Registry gives each push service 5 seconds, 16 at a time, so this holds for up
 * to 64 subscribed browsers; a Session that gave up sooner would send the same notification again.
 */
export const NOTIFY_TIMEOUT: Duration.Input = "20 seconds";

/**
 * How long asking the Workspace for its held stops and writing their notices may take: a slow Workspace leaves them to
 * the next check rather than hold up a message.
 */
const HELD_STOPS_TIMEOUT: Duration.Input = "5 seconds";

/** The submissions the owner made whose Run's end has not been notified yet, in the Session's key-value storage. */
const NOTIFY_KEY = "notify-submissions";

/** The part of the Session's key-value storage the notified Runs are kept in. */
export type SessionNoticeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/**
 * Add `id` to the Runs whose end the owner is told of, though the owner did not make it: the follow-up Run a follower of an
 * MCP task starts when the task ends (`docs/architecture/mcp-server-requests.md` → MCP tasks, Delivery). The host tells
 * the owner of each as it does of the owner's own.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function over storage, not a combinator.
export const recordRunNotice = (kv: SessionNoticeKv, id: SubmissionId): void => {
  kv.put(NOTIFY_KEY, Arr.dedupe([...(kv.get<SubmissionId[]>(NOTIFY_KEY) ?? []), id]));
};

/**
 * Where the inputs admitted to the Session's conversations are kept, the newest `MAX_INPUTS`: the MCP endpoint's wait
 * finds the Run that ended among them (pi-durable lists no settled submission).
 */
const INPUTS_KEY = "mcp-inputs";

const MAX_INPUTS = 64;

/**
 * The request IDs of the messages Stop withdrew from a line, with when, kept in the Session's key-value storage: such a
 * message leaves no submission, so a client that sends it again under the same `requestId` after a reconnect would
 * otherwise place it after the Stop. Kept for `WITHDRAWN_KEPT_MS`, the newest `MAX_WITHDRAWN`.
 */
const WITHDRAWN_KEY = "withdrawn-requests";

const WITHDRAWN_KEPT_MS = 10 * 60 * 1000;

const MAX_WITHDRAWN = 64;

/** The longest `requestId` kept as withdrawn: a longer one is withdrawn, but a resend of it is not. */
const MAX_WITHDRAWN_ID = 256;

/** One part of a message's content, as a draft holds it. */
type InputPart = Exclude<InputSubmissionDraft["content"], string>[number];

/** What the image budget reads of a message's part: its type, and an image's data. */
type MessagePart = { readonly type: string; readonly data?: string };

type WithdrawnRequest = { readonly requestId: string; readonly at: number };

/** An entry ID from the number a client passed in a cursor. */
// SAFETY: entry IDs are positive integers; the caller checked the number is one it was given.
const entryId = (id: number): EntryId => id as EntryId;

/** The directories of a spill's `path` below `/workspace`, outermost first: `/workspace/.cloudpid`, `…/tmp` and `…/tmp-<id>`. */
const spillDirectoriesOf = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/").slice(2, -1);

  return Arr.map(parts, (_, index) => `/workspace/${Arr.join(Arr.take(parts, index + 1), "/")}`);
};

/** Whether `path` is an absolute path under `/workspace` with no empty, `.` or `..` segment: a file a Visual's Open file may read. */
const isWorkspaceFilePath = (path: string): boolean => {
  const parts = path.split("/");

  return (
    parts[0] === "" &&
    parts[1] === "workspace" &&
    parts.length > 2 &&
    Arr.every(parts.slice(1), (part) => part !== "" && part !== "." && part !== "..")
  );
};

/** A conversation ID from the number a client passed in a cursor. */
// SAFETY: conversation IDs are positive integers; a number that names none finds no conversation.
const toConversationId = (id: number): ConversationId => id as ConversationId;

type AdmittedInput = { readonly id: SubmissionId; readonly conversationId: number };

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

/** Whether a live task is the follower of an MCP task, which follows rather than works. */
const isFollower = (task: { readonly record: { readonly kind: string } }): boolean =>
  task.record.kind === MCP_TASK_FOLLOWER;

/**
 * The live tasks that are work: every one but a follower of an MCP task. The one rule `wake` (the status the Registry
 * is told), `idle()` and `follow()` (the MCP endpoint's status) share, so a conversation that only follows MCP tasks
 * reads idle everywhere (`docs/architecture/mcp-server-requests.md` → MCP tasks, Following, not running).
 */
const working = <T extends { readonly record: { readonly kind: string } }>(
  tasks: ReadonlyArray<T>,
): ReadonlyArray<T> => Arr.filter(tasks, (task) => !isFollower(task));

/**
 * What the alarm is armed for: `active` while work is live, sleeping tasks included. The host derives it from the live
 * tasks rather than taking pi-durable's `Harness.wake()`, whose `active` leaves a sleeping task out (it gives its time as
 * `at`): a Run whose generation sleeps out a retry backoff is still a Run, which the Registry must hear is running and
 * whose calls `onIdle` must not clear. Without `HarnessOptions.onWake` the Harness keeps a timer for the earliest sleep
 * itself, and the heartbeat's `resume()` wakes a sleep that came due while the object was evicted.
 */
type Wake = {
  readonly active: boolean;
  /**
   * What the live followers of MCP tasks ask (`docs/architecture/mcp-server-requests.md` → MCP tasks, Following, not
   * running): they are not work, so they leave `active` alone. One that is pending or running keeps the heartbeat
   * (`needsHeartbeat`); a sleeping one asks to be woken at its `until`; `count` is what the Registry is told.
   */
  readonly followers?: Followers;
};

type Followers = {
  readonly count: number;
  readonly needsHeartbeat: boolean;
  readonly until: number | undefined;
};

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

/** What the MCP tools are built from now: what to install, and the notices to write first. */
export type SessionHostMcpBuild<R> = {
  /** The extensions to install over those of the same name; none when that is what is installed. */
  readonly extensions: readonly Extension[];
  /** Tells the conversations of the listing the build has: run before the extensions are installed. */
  readonly announce: Effect.Effect<void, never, R>;
};

/** The prompt a send got from an MCP server: the owner's pick, and where its conversation works. */
export type SessionHostMcpPromptGet = {
  /** The configured server's name. */
  readonly server: string;
  /** The prompt's own name. */
  readonly name: string;
  /** The prompt's Slash command and the title its questions' cards say ("getting prompt <title>"), as the catalog lists them. */
  readonly command: string;
  readonly title: string;
  /** The arguments to send: only those the prompt declares, cleaned. */
  readonly arguments: Readonly<Record<string, string>>;
  readonly conversationId: ConversationId;
  /** The Subagent Workspace (`ws:<id>`) the conversation works in; undefined for the Session's own. */
  readonly workspace: string | undefined;
  /** The message's `requestId`, which its questions' cards are tied to its lane row by (`mcpPromptCallId`). */
  readonly requestId?: string | undefined;
};

/** The Session's MCP prompts (`docs/architecture/mcp-in-a-session.md` → The `/` menu and the catalog, Getting a prompt at send). */
export type SessionHostMcpPrompts = {
  /** The Session's name, where its files are kept (`/workspace/.cloudpid/uploads/<session>/`); undefined when unknown. */
  readonly session: string | undefined;
  /**
   * The composer's `prompts` and `mcpServers`, from the host's inventory alone: nothing here reads a server or starts a
   * Container. Never fails: a host that does not answer offers none.
   */
  readonly catalog: (values: SessionSettingsValues) => Effect.Effect<PromptCatalog>;
  /**
   * Get `call`'s prompt once, as its message is admitted, and run `use` over the server's `GetPromptResult` (a large
   * one is read under the decode slot, which `use` holds until it is done) and what the server's questions came to. Fails with a `SessionError` that carries an
   * `MCP_PROMPT_*` code, never with the server's own words unredacted.
   */
  readonly get: <A>(
    values: SessionSettingsValues,
    call: SessionHostMcpPromptGet,
    use: (result: Schema.Json, asked: PromptSummaries) => Promise<A>,
  ) => Effect.Effect<A, SessionError>;
};

/** The owner's MCP resources in the composer (`docs/architecture/mcp-in-a-session.md` → Attached resources). */
export type SessionHostMcpAttached = {
  /** The Session's name, where its files are kept (`/workspace/.cloudpid/uploads/<session>/`); undefined when unknown. */
  readonly session: string | undefined;
  /** The `@` menu's listing: never starts a Container. Never fails. */
  readonly menu: (input: ResourceMenuInput) => Effect.Effect<McpResourceMenu>;
  /** One read at send, which may start a stdio server's Container; `use` makes its message. Never fails. */
  readonly read: <A>(input: AttachedReadInput<A>) => Effect.Effect<AttachedReadResult<A>>;
};

/** The Session's MCP tools, as the Session host runs them (`SessionHostOptions.mcp`). */
export type SessionHostMcp<R> = {
  /**
   * A message's request start, in its prepare step, outside the Session's locks, once the settings are read: the host
   * calls that find what the MCP tools of conversation `conversationId` are built from. `window` is its Context Window
   * (its head marker's entry). A Stop that withdraws the message interrupts it.
   */
  readonly start: (
    conversationId: ConversationId,
    window: string,
    values: SessionSettingsValues,
  ) => Effect.Effect<void, never, R>;
  /**
   * The extensions to install over those of the same name for what the MCP tools are built from now (`mcp`, `codemode`
   * and `tool-search`), none when that is what is installed, and the effect that tells the conversations of the listing
   * the build has. Run under the install lock: at the object's start before anything resumes, after each request start,
   * and after each settings read that installs again. The host runs `announce` before it installs, so a notice is queued
   * before any model call can see the declarations it explains; at the start it runs it once the work is resumed.
   */
  readonly reinstall: (
    installed: readonly Extension[],
    values: SessionSettingsValues,
  ) => SessionHostMcpBuild<R>;
  /**
   * Where the `mcp_servers` notices are written (`docs/architecture/mcp-in-a-session.md` → The prompt cache and the
   * `mcp_servers` section): the Session's open Harness. Called once, before anything resumes.
   */
  readonly bind: (notices: McpNotices) => void;
  /**
   * The open Harness, for the owner's answer to a question of an MCP task, which sends `tasks/update` itself since no call
   * waits for it (`docs/architecture/mcp-server-requests.md` → MCP tasks, Questions in a task). Called once, with `bind`.
   */
  readonly bindTaskHarness?: (harness: Pick<TaskOwnerHarness, "snapshot" | "commit">) => void;
  /**
   * What the Session's sampler works with, once the Harness is open: its models (held to the spend limit, as the Harness's
   * are), its Roles, the limit and where a sample's Usage goes (`docs/architecture/mcp-server-requests.md` → Sampling
   * requests). Called once, with `bind`. Absent: no server's Sampling request is answered.
   */
  readonly bindSampling?: (binding: McpSamplingBinding) => void;
  /**
   * What the host does when a follower of an MCP task starts a Run of its own (`docs/architecture/mcp-server-requests.md`
   * → MCP tasks, Delivery) or moves (ends, or sleeps until another time): wait for the Session to be idle, tell the owner
   * the Run's end as it does for the owner's, and settle, so the alarm and the Registry's count follow. Called once, before
   * anything resumes; `settle` is what it calls.
   */
  readonly settleOnFollowers?: (settle: () => void) => void;
  /**
   * What the host does whenever the Session settles with no work live, and so at every wake once what is due has resumed
   * (`docs/architecture/mcp-server-requests.md` → MCP tasks, The record): end the inline MCP tasks whose call is gone.
   * Never fails.
   */
  readonly sweep?: (harness: SweepHarness) => Effect.Effect<void>;
  /** The owner's cancel of MCP task `task` (`mcp_task_cancel`). Never fails. */
  readonly cancelTask?: (harness: TaskOwnerHarness, task: string) => Effect.Effect<OwnerCancel>;
  /** Keep the Container of the stdio server's MCP task `task` (`container_keep`). Never fails. */
  readonly keepContainer?: (
    harness: Pick<TaskOwnerHarness, "snapshot">,
    task: string,
  ) => Effect.Effect<OwnerKeep>;
  /**
   * Tell conversation `conversationId` that the `mcp_servers` listing changed, if its section was shown another one: run
   * after a request start's install, before its message is placed. Never fails.
   */
  readonly notify: (
    conversationId: ConversationId,
    values: SessionSettingsValues,
  ) => Effect.Effect<void, never, R>;
  /** The owner's MCP prompts. Absent: none are offered, and a send that names one is refused. */
  readonly prompts?: SessionHostMcpPrompts;
  /** The owner's MCP resources. Absent: none are listed, and a send that attaches one is refused as gone. */
  readonly attached?: SessionHostMcpAttached;
  /**
   * The owner's completion of an argument in the composer's form (`McpTools.complete`): never starts a Container, never
   * fails. Absent: no server is asked, and every completion is `unsupported`.
   */
  readonly complete?: (input: McpCompletionInput) => Effect.Effect<McpCompletion>;
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
   * The Session's MCP tools (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension). Every install of the
   * extensions that follow the settings or the MCP inventory (`reload`, `reinstall`) runs under one lock, built there
   * from the extensions installed and the settings in force then, so an older build never lands over a newer one.
   */
  readonly mcp?: SessionHostMcp<R> | undefined;
  /**
   * The Session's App records (`docs/architecture/mcp-apps.md` → App records): a Fork or Clone carries those of the calls
   * it copies, a page of entries at a time.
   */
  readonly apps?: McpAppCopies | undefined;
  /** The Session's Visuals (`docs/architecture/visuals.md` → Fork and Clone): a Fork or Clone carries those of the calls it copies. */
  readonly visuals?: VisualCopies | undefined;
  /**
   * The App contexts the Views sent (`docs/architecture/mcp-apps.md` → App messages and App context): the pending ones of a
   * conversation are written to it as one untrusted notice when input is admitted to it (`admitDraft`), and while it is busy
   * as they come (`appContextHeld`), one write in flight for a conversation.
   */
  readonly appContexts?: AppContexts | undefined;
  /** What the Session lets go of for a conversation its active branch moved off: its Resource watches, silently. */
  readonly onBranchLeft?: ((conversation: ConversationId) => Effect.Effect<void>) | undefined;
  /**
   * The Session's records of its MCP calls' questions (`docs/architecture/mcp-server-requests.md` → Elicitation requests,
   * Records): `/export` writes a line for each, and a Fork or Clone carries the settled elicitation records of the calls it
   * copies.
   */
  readonly records?: SessionMcpRecords | undefined;
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
  /**
   * Withdraws the owner requests (an Approval, a Secret request, a Sign-in request, an MCP server's questions) of a tool
   * call pi-durable ended for good without it running again: one cut off `settings.restartLimit` times, and the calls it
   * made, which its end aborts. Run when pi-durable reports the end (`task_interrupted`), not once the Session is idle.
   */
  readonly withdrawCall?: (call: EndedCall) => Effect.Effect<void, never, R>;
  /**
   * Runs the moment the Session has gone idle after work, before anything else of its settling: closes the Last run and
   * ends it in the background (`runs.ts`), so it never delays the owner's notification. Given a way to read the newest
   * entry of a conversation.
   */
  readonly onSettled?: (
    newest: (conversationId: ConversationId) => Promise<number>,
  ) => Effect.Effect<void, never, R>;
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
  /**
   * Tell the Workspaces of the Session and of `subagents` that the Session is at work (a message admitted, a live Run's
   * heartbeat): their Containers' hold cap counts from it (docs/architecture/container.md "Idle stop"). In the
   * background: a failure is logged.
   */
  readonly workspaceActivity?: ((subagents: ReadonlyArray<string>) => Promise<void>) | undefined;
  /** The held stops of the Session's Workspace's Container after `after`, which the Session shows as notices. */
  readonly containerHeldStops?: ((after: number) => Promise<ReadonlyArray<HeldStop>>) | undefined;
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
  /** Who sent the input over the MCP endpoint; the owner's entry keeps it (`UserEntryData.via`). */
  readonly via?: SessionVia;
  readonly input: UserInput;
  /**
   * Reads the Owner tabs the owner attached (`BrowserPane.attach`, redacted of held Secrets): run in the message's
   * prepare step, outside the Session's lock, after the messages sent before it to the same conversation are placed
   * and only when it is new (a resent `requestId` finds the first submission without reading again), so that a later
   * message is not admitted first and a page that closed since cannot fail a message already admitted. What it reads
   * reaches the model as a block of page content after the typed text and the Attachments' paths, and the owner's
   * entry keeps it for the chip.
   */
  readonly attachPages?: Effect.Effect<ReadonlyArray<AttachedPage>, SessionError>;
  /**
   * An MCP prompt the owner picked from the `/` menu (`submit.mcpPrompt`), got in the message's prepare step, once and
   * outside the Session's lock, and made the first part of the message: its block, its images, then the typed text.
   * `redact` takes the held Secrets out of the arguments the entry keeps and of what the server answers.
   */
  readonly mcpPrompt?: {
    readonly ref: McpPromptRef;
    readonly redact: Effect.Effect<<A>(value: A) => A, SessionError>;
  };
  /**
   * The MCP resources the owner attached from the `@` menu (`submit.resources`), read in the message's prepare step, once
   * (not again for a `requestId` that was admitted), in parallel, outside the Session's lock: they reach the model as an
   * untrusted `<mcp_resources>` block after the pages' (`docs/architecture/mcp-in-a-session.md` → Attached resources), and
   * the owner's entry keeps what they became for the chips. `redact` takes the held Secrets out of what the servers answer.
   */
  readonly resources?: {
    readonly refs: ReadonlyArray<ResourceRef>;
    readonly redact: Effect.Effect<<A>(value: A) => A, SessionError>;
  };
  /**
   * A Trigger's webhook delivery (`fire`): its body reaches the model as an untrusted `<trigger_payload>` block after the
   * message, at most 16 KiB of it inline, and the whole body is written to `.cloudpid/triggers/<key>.json` in the
   * Workspace first (`docs/architecture/triggers.md` → Payload and untrusted content), once and not again for a
   * `requestId` that was admitted. The owner's entry keeps what it became for the chip. `redact` takes the held Secrets out
   * of what goes inline.
   */
  readonly payload?: {
    readonly payload: FirePayload;
    /** The Fire's key, which names the file. */
    readonly key: string;
    readonly redact: Effect.Effect<(text: string) => string, SessionError>;
  };
  /**
   * The App messages the owner sent with it (`submit.app`), cleaned and redacted, with the server's name from the call's record
   * (empty when the record is gone): each is a text part of its own after the typed text and the blocks of pages and
   * resources, and the owner's entry keeps them for the transcript's "sent from the <server> app".
   */
  readonly apps?: ReadonlyArray<SentAppMessage>;
  /** What the input does while the conversation is busy; pi-durable queues it as a follow-up by default. */
  readonly whenBusy?: NonNullable<InputSubmissionDraft["whenBusy"]>;
  /**
   * A Review's Annotations, as they are sent (`reviews.ts`): the input is its summary, and the model gets the Review's
   * Markdown after it (`renderReview`), and the page Annotations' crops the message has room for after its other parts
   * (`crops.ts`), the Markdown rendered with only those marked; the entry keeps the Review's data.
   */
  readonly review?: { readonly annotations: ReadonlyArray<Annotation> };
};

/** The draft of a message, made with its Review rendered (`undefined`: it has none). */
type DraftOf = (
  review: Pick<RenderedReview, "markdown" | "data"> | undefined,
) => InputSubmissionDraft;

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

/** A page of a conversation's transcript a client's `ConversationTranscript` asks for (`entries`). */
export type EntryPageRequest = {
  /** The entries' inclusive ID bounds, and their order. */
  readonly query: Omit<EntryQuery, "conversationId">;
  /** The most entries the page holds. */
  readonly limit: number;
  /** The conversation: the active branch's by default, or a live subagent's. */
  readonly conversationId?: ConversationId;
};

/**
 * One frame of a conversation's watch: its view whole (the first, and one that replaces it), or the operations that
 * change the last one.
 */
export type ConversationFrame =
  | { readonly type: "view"; readonly view: ConversationView }
  | { readonly type: "ops"; readonly ops: readonly Op[] };

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
  /**
   * Whether no task is live, no submission is unsettled and no message is being prepared. Reads only: it never starts
   * work.
   */
  readonly idle: Effect.Effect<boolean, SessionError>;
  /**
   * Reconcile the alarm and the Registry with what is live now, as the end of a Run does: for a change outside a Run to
   * when the object must wake (the Browser Pane's use of the browser, which moves its idle close).
   */
  readonly settle: Effect.Effect<void, SessionError>;
  /**
   * The state a wait or a status for the MCP endpoint is decided from (`FollowState`), read now; never starts work. For
   * `conversationId`, any conversation of the Session (a cursor keeps following the branch it was made on), else the
   * active branch's.
   */
  readonly follow: (conversationId?: number) => Effect.Effect<FollowState, SessionError>;
  /** Up to `limit` entries of the conversation, in `order`, within the bounds (for a transcript read). */
  readonly entries: (
    request: EntriesRequest,
  ) => Effect.Effect<ReadonlyArray<EntryRecord>, SessionError>;
  /** The input admitted for `requestId` on the active branch, if any (its id and whether it has been placed). */
  readonly admitted: (
    requestId: string,
  ) => Effect.Effect<{ readonly id: number; readonly queued: boolean } | undefined, SessionError>;
  /** Show `notice` in the active branch's transcript, as a line of its own. */
  readonly note: (notice: string) => Effect.Effect<void, SessionError>;
  /**
   * An App View's context was held for `conversation`: while it is busy and no earlier write of App contexts waits for its
   * next boundary, the pending ones are written now, to be placed there. An idle conversation's wait for its next input.
   * Never fails: what goes wrong is logged, and the contexts stay pending.
   */
  readonly appContextHeld: (conversation: ConversationId) => Effect.Effect<void>;
  /**
   * The conversation an App View's context for `call` goes to, or none when no conversation can take it: the one the page
   * shows the View in (`shown`) when its History holds the call, else the one the call was made in; a Session branch that was
   * left gives way to the active branch when that holds the call. Fails when a History cannot be read.
   */
  readonly appContextTarget: (
    call: AppContextCall,
    callId: string,
    shown: ConversationId | undefined,
  ) => Effect.Effect<string | undefined, SessionError>;
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
  /** Append a page of the source's entries to the root conversation, renumbered, and keep the App records, questions and Visuals it carries. */
  readonly importEntries: (
    entries: ReadonlyArray<EntryRecord>,
    apps?: ReadonlyArray<McpAppCopy>,
    questions?: ReadonlyArray<McpQuestionCopy>,
    visuals?: ReadonlyArray<VisualCopy>,
  ) => Effect.Effect<void, SessionError>;
  /** Take the agent and documents the plan carries, and take messages from then on. */
  readonly importFinish: (plan: ForkPlan) => Effect.Effect<void, SessionError>;
  /**
   * Start a Session import in this new Session: the root conversation is made, and the Session shows `importing` and takes
   * no message and no move until `importFinish`.
   */
  readonly importBegin: Effect.Effect<void, SessionError>;
  /**
   * Write a Session import's translated entries to the root conversation a page at a time, resuming after those a cut-off
   * run wrote (`importTranslated`). Answers why it could not resume, when `translation` is not the one the first run wrote
   * (another version, or the root holds more entries than it makes): the import is then given up.
   */
  readonly importTranslated: (
    pages: Iterable<ReadonlyArray<EntryRecord>>,
    translation: WrittenTranslation,
  ) => Effect.Effect<string | undefined, SessionError>;
  /** Whether a Session import's translated entries are all in the root conversation. */
  readonly importWritten: Effect.Effect<boolean, SessionError>;
  /**
   * The names of the tools the root conversation's requests declare, for the import notice's list of laptop tools this
   * Session lacks; none when they cannot be read.
   */
  readonly importTools: Effect.Effect<ReadonlyArray<string> | undefined>;
  /**
   * Run the Session's title task once, as after its first answer: the Session is named if it is not, from its first
   * message and answer. For an import that came with no title. Never fails.
   */
  readonly nameSession: Effect.Effect<void>;
  /** How full the active branch's Context Window is; null when its model's window is not known. Never fails. */
  readonly contextUsage: Effect.Effect<ContextUsage | null>;
  /**
   * What a Session import chooses its model against: the catalog, and the agent a new Session of the Environment starts with
   * (the default in force, as the settings last read).
   */
  readonly importDefaults: Effect.Effect<ImportDefaults>;
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
   * Show the held stops of the Session's Workspace not shown yet as notices (docs/architecture/container.md "Idle
   * stop"), as a client connects. Never fails.
   */
  readonly showHeldStops: Effect.Effect<void>;
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
   * Conversation `conversationId`'s conversation view: a `view` frame, its window as `window` says (pi's default, the
   * newest entries), then an `ops` frame per call of pi's watch, each the commits made since the last folded; a call
   * that replaces the whole view is a `view` frame. Screenshots are bounded per frame (`WATCH_IMAGES`). Fails when the
   * conversation cannot be watched, and when the Harness ends the watch.
   */
  readonly conversationView: (
    conversationId: ConversationId,
    window?: ConversationWindow,
  ) => Stream.Stream<ConversationFrame, SessionError>;
  /**
   * Conversation `conversationId`'s Todo List: how it stands, then each change that alters it. Fails when the
   * conversation cannot be watched, and when the Harness ends the watch.
   */
  readonly todos: (
    conversationId: ConversationId,
  ) => Stream.Stream<ReadonlyArray<TodoTask>, SessionError>;
  /**
   * The Session's MCP tasks (`docs/architecture/mcp-server-requests.md` → MCP tasks): how they stand, then each change that
   * alters the list. Empty for a Session without MCP servers. Fails when the Harness ends the watch.
   */
  readonly mcpTasks: Stream.Stream<ReadonlyArray<McpTask>, SessionError>;
  /** The Session's MCP tasks as they stand now. */
  readonly mcpTaskList: Effect.Effect<ReadonlyArray<McpTask>, SessionError>;
  /** The owner's cancel of MCP task `task`: what it came to. */
  readonly mcpTaskCancel: (task: string) => Effect.Effect<OwnerCancel>;
  /** Keep the Container of the stdio server's MCP task `task`: what it came to. */
  readonly mcpTaskKeep: (task: string) => Effect.Effect<OwnerKeep>;
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
   * The MCP resources the `@` menu lists, for the active branch or the conversation `conversationId` names: from the
   * servers' lists, never starting a Container (`docs/architecture/mcp-in-a-session.md` → Attached resources). A Session
   * with no MCP servers lists none.
   */
  readonly resourceMenu: (
    conversationId?: ConversationId,
  ) => Effect.Effect<McpResourceMenu, SessionError>;
  /**
   * The suggestions for an argument of an MCP prompt or resource template in the composer of the active branch, or of the
   * conversation `conversationId` names (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): through the
   * host with the conversation's own Workspace, never starting a Container. `signal` aborts it (a newer keystroke, the
   * socket gone). Never fails: it answers as the form is told, `unsupported` for a Session with no MCP servers.
   */
  readonly mcpComplete: (
    request: Omit<McpCompletionInput, "conversation" | "workspaceOf"> & {
      readonly conversationId?: ConversationId | undefined;
    },
  ) => Effect.Effect<McpCompletion, SessionError>;
  /**
   * The directory the active branch, or the conversation `conversationId` names, works in: where the paths its tools
   * are given resolve. Undefined for a Session without an environment.
   */
  readonly directory: (
    conversationId?: ConversationId,
  ) => Effect.Effect<string | undefined, SessionError>;
  /**
   * What the Workspace holds at `path`, a Result Spill's path (`isMcpSpillPath`; any other is `missing`), for the owner's
   * preview of it, as base64: read through the conversation's lookup environment, which never starts the Container (ADR-0018),
   * with no symbolic link followed (a link is `missing`), and `too_large` past `MAX_MCP_RESOURCE_PREVIEW_BYTES` without
   * reading it. A file over `PREVIEW_SLOT_OVER` is read only once `hold` has taken the decode slot, with its size. A file
   * cleanup removed is `missing`.
   */
  readonly spill: (
    conversationId: ConversationId | undefined,
    path: string,
    hold: (bytes: number) => HoldSlot,
  ) => Effect.Effect<SpillRead, SessionError>;
  /**
   * What the Workspace of conversation `conversationId` holds at `path` now, for a Visual's Open file
   * (`docs/architecture/visuals.md` → The frame: The card): read as `spill` reads, through the lookup environment that never
   * starts the Container, with no symbolic link followed, and `too_large` past `MAX_VISUAL_BYTES` without reading it. A
   * path outside `/workspace`, or one with a `.` or `..` segment, is `missing`; so is a Workspace that does not answer in time.
   */
  readonly workspaceFile: (
    conversationId: ConversationId,
    path: string,
  ) => Effect.Effect<WorkspaceFileRead, SessionError>;
  /**
   * A page of the transcript of the active branch, or of the conversation `conversationId` names (`entriesPage`): what
   * a client's transcript loads before its oldest entry or into a gap.
   */
  readonly entryPage: (request: EntryPageRequest) => Effect.Effect<EntriesPage, SessionError>;
};

/** What the Session DO answers with: its Harness, prompted and woken. */
export class SessionHost extends Context.Service<SessionHost, SessionHostService>()(
  "@cloudpid/server/session/host/SessionHost",
) {}

const fromHarness = Effect.mapError((error: HarnessError) =>
  SessionError.make({ operation: error.operation, message: error.message }),
);

/** Why a watch ended. */
const watchEnded = (end: WatchEnd): string =>
  "error" in end ? `Watch ended (${end.kind}): ${String(end.error)}` : `Watch ended (${end.kind})`;

/** Which of the root conversation's model and thinking level the Session picked, rather than follows the default. */
export type Picks = { readonly model: boolean; readonly thinkingLevel: boolean };

/** Whether a conversation's resolved agent is already the `want`ed one. */
const sameAgent = (have: Agent, want: AgentChange): boolean =>
  have.model?.provider === want.model?.provider &&
  have.model?.modelId === want.model?.modelId &&
  have.thinkingLevel === want.thinkingLevel;

/** The alarm heartbeat's next time. */
const heartbeat = Clock.currentTimeMillis.pipe(Effect.map((now) => now + HEARTBEAT_MS));

/**
 * A tool call task's input (pi-durable's `ToolTaskInput`), as far as its tool call's id goes: kept in a nested call's
 * input, beside a model call's. Restated, so an upgrade must check it (`docs/development/dependencies.md`).
 */
const ToolCallInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("model"), callId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("nested"), call: Schema.Struct({ id: Schema.String }) }),
]);

const decodeToolCallInput = Schema.decodeUnknownOption(ToolCallInput);

/** The tool call a tool call task runs: its task and, when its input says it, its tool call's id. */
const endedCallOf = (task: { readonly id: TaskId; readonly input: unknown }): EndedCall => ({
  taskId: task.id,
  callId: Option.getOrUndefined(
    Option.map(decodeToolCallInput(task.input), (input) =>
      input.kind === "model" ? input.callId : input.call.id,
    ),
  ),
});

/** Open the Harness on the object's `storage`, under the `pi_` prefix, after arming a fallback alarm. */
const openSessionHarness = Effect.fn("openSessionHarness")(function* <R>(
  options: SessionHostOptions<R>,
) {
  const { storage } = options;
  const settings = yield* SessionSettings;
  const services = yield* Effect.context<R>();

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

  const limited = limitingModels(
    models,
    ledgerGate({
      // The limit is off while the ledgers cannot be read: say so, or it would be off without a trace.
      failed: (reason) => {
        run(
          Effect.logWarning("Reading the Session's spend failed; the request goes through", reason),
        );
      },
      limit: () => settings.current().spendLimit,
      ledger: () => opened,
      kv: storage.kv,
    }),
  );

  /** Withdraws the owner requests of a tool call pi-durable ended at the restart limit, once the Harness is open. */
  let endedAtLimit: ((id: TaskId) => void) | undefined;

  // What the Harness reports without failing a call (a task that faulted, one the restart limit ended, a hook or
  // listener that threw) is otherwise dropped. `info` names the task, never content. A tool call the limit ends has the
  // owner requests it and the calls it made left withdrawn (`withdrawCall`), as the Run goes on.
  const onReport: HarnessOptions["onReport"] = ({ error, ...info }) => {
    run(Effect.logWarning(`pi-durable reported ${info.kind}`, info, error));

    if (
      info.kind === "task_interrupted" &&
      info.reason === "restart_limit" &&
      info.task.kind === ToolTask.definition.name
    ) {
      endedAtLimit?.(info.task.id);
    }
  };

  const harnessOptions = { models: limited, settings: harnessSettings(settings), onReport };

  const harness = yield* openHarness(
    piStorage,
    options.env === undefined ? harnessOptions : { ...harnessOptions, env: options.env },
  ).pipe(fromHarness);

  opened = harness.harness;

  const withdrawCall = options.withdrawCall;

  if (withdrawCall !== undefined) {
    const restartLimit = harnessOptions.settings.restartLimit ?? DEFAULT_RESTART_LIMIT;

    // pi-durable ends a tool call at the limit when it next reserves it, before the call runs again (so it makes no new
    // calls), and only after it aborted the calls it made and they ended: none is live when the end is reported. A
    // restart is counted only as the Harness opens, so the calls it will end are the ones at the limit now, before
    // anything runs, and the tool calls below each are read now. Read failing, they are left to `onIdle`.
    const { tasks } = yield* harness.inspect.pipe(
      fromHarness,
      Effect.catchCause((cause) =>
        Effect.logWarning("The tool calls at the restart limit were not read", cause).pipe(
          Effect.as({ tasks: [] }),
        ),
      ),
    );

    const owners = new Map<number, number | undefined>(
      Arr.map(tasks, ({ record }) => [record.id, record.owner]),
    );

    /** Whether task `task` is the call `id`, or below it. */
    const below = (task: number | undefined, id: number): boolean =>
      task !== undefined && (task === id || below(owners.get(task), id));

    const calls = Arr.filter(tasks, ({ record }) => record.kind === ToolTask.definition.name);

    /** The tool calls below each call at the restart limit, by the call's task, until its end is reported. */
    const callsBelow = new Map<number, ReadonlyArray<EndedCall>>(
      Arr.map(
        Arr.filter(calls, ({ record }) => (record.restarts ?? 0) >= restartLimit),
        ({ record: { id } }) => [
          id,
          Arr.map(
            Arr.filter(calls, ({ record }) => below(record.owner, id)),
            ({ record }) => endedCallOf(record),
          ),
        ],
      ),
    );

    /** The call `id`, read from the Harness as it reports the end, and the tool calls below it, read as it opened. */
    const withdrawEnded = (id: TaskId) =>
      attempt("getTask", () => harness.harness.getTask(id, context)).pipe(
        Effect.flatMap((call) => {
          const ended = callsBelow.get(id) ?? [];

          callsBelow.delete(id);

          return Effect.forEach(
            call === undefined ? ended : [endedCallOf(call), ...ended],
            (ended) => withdrawCall(ended),
            { discard: true },
          );
        }),
        Effect.provideContext(services),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "The requests of a call the restart limit ended were not withdrawn",
            cause,
          ),
        ),
      );

    endedAtLimit = (id) => void run(withdrawEnded(id));
  }

  // A storage error closes the Harness for good; reset the object so the next event reopens it.
  yield* Effect.sync(
    () =>
      void harness.harness.closed.then((end) => {
        if (end.kind === "failed") options.reset(`Harness failed: ${String(end.error)}`);
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

  /** The newest entry of a conversation, 0 when it has none. */
  const newestEntry = async (conversationId: ConversationId): Promise<number> => {
    const conversation = await harness.harness.conversation(conversationId, context);

    if (conversation === undefined) return 0;

    const page = await conversation.entries({}, 1, undefined, context);

    return page.items[0]?.id ?? 0;
  };

  const onSettled =
    options.onSettled === undefined
      ? Effect.void
      : Effect.provideContext(options.onSettled(newestEntry), services);

  /** The Agent changes of the Run, kept until its end notifies them. */
  const changes = runChanges(storage.kv);

  // Before anything resumes, so resumed tool calls find their tools.
  let installed = yield* options.extensions.pipe(
    Effect.provideService(AgentChangeLog, { record: changes.record }),
    Effect.provideService(SettingsReload, { apply: Effect.suspend(() => reloadSettings) }),
  );

  for (const extension of installed) yield* harness.install(extension);

  /** Install `extensions` over the installed ones of the same name, which later reloads are given in their place. */
  const installOver = (extensions: readonly Extension[]) =>
    Effect.forEach(extensions, (extension) =>
      harness.install(extension).pipe(
        Effect.andThen(
          Effect.sync(() => {
            installed = Arr.map(installed, (each) =>
              each.name === extension.name ? extension : each,
            );
          }),
        ),
      ),
    );

  /**
   * Every install after the start runs here, one at a time and to its end: what it installs is built under the lock from
   * the extensions installed and the settings in force then, so an older build never lands over a newer one.
   */
  const installing = Semaphore.withPermit(yield* Semaphore.make(1));

  /**
   * What the MCP tools are built from now: the effect that tells the conversations of its listing, and the one that
   * installs it. Told first (their notices queued: placed at the next boundary of a busy Run, at once in an idle one),
   * installed second, so a model call that renders the new declarations has its notice queued. Known limits (see
   * `docs/architecture/mcp-in-a-session.md` → The prompt cache and the `mcp_servers` section): pi-durable places a Run's
   * inbox at a boundary and fixes its tools later, in `prepare`, so a request in that gap has the new tools and its notice
   * one boundary later; and the broadcast reads each conversation's context, so a Stop or message waits for it.
   */
  const mcpBuild = () => {
    if (options.mcp === undefined) return { announce: Effect.void, install: Effect.void };

    const built = options.mcp.reinstall(installed, settings.current());

    return {
      announce: Effect.provideContext(built.announce, services),
      install: installOver(built.extensions),
    };
  };

  /** Install again what the MCP tools are built from now, if it is not what is installed. */
  const reinstallMcp = Effect.suspend(() => {
    const { announce, install } = mcpBuild();

    return announce.pipe(Effect.andThen(install));
  });

  // The `mcp_servers` notices go to this Harness, before anything resumes or renders a section.
  options.mcp?.bind(mcpNotices(harness.harness));
  options.mcp?.bindTaskHarness?.(harness.harness);

  // What the MCP tools were last built from, before anything resumes: a resumed Run or call finds the tools, and the
  // declarations, that its Context Window was shown. The conversations are told once the work is resumed (and only if
  // the kept listing is not the one last told), which finds the tools and the sections as they were shown.
  const started = mcpBuild();

  yield* started.install;

  /** The settings the extensions were last built for. */
  let built = settings.current();

  /** What watches of the Session's usage run when it or its limit changes outside the Harness's ledgers. */
  const usageListeners = new Set<() => void>();

  // A server's Sampling requests run on these models under the same spend gate as the Harness's, and cost what they cost
  // in the Session's usage (`docs/architecture/mcp-server-requests.md` → Sampling requests).
  if (options.mcp?.bindSampling !== undefined) {
    const gate = ledgerGate({
      limit: () => settings.current().spendLimit,
      ledger: () => harness.harness,
      kv: storage.kv,
    });

    options.mcp.bindSampling({
      models: limitingModels(models, gate),
      roles: () => Record.map(settings.current().subagents.roles, (role) => role.model),
      // Checked before the sample is made, so a refusal costs nothing and says why.
      overLimit: () => overLimitReason(gate),
      usage: (who, usage) => {
        recordSamplingUsage(storage.kv, who, usage);

        for (const listener of usageListeners) listener();
      },
    });
  }

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

        const { reload } = options;

        yield* Effect.suspend(() =>
          reload === undefined ? Effect.void : installOver(reload(installed, values, previous)),
        ).pipe(Effect.andThen(reinstallMcp), installing, Effect.uninterruptible);
      }),
    ),
  );

  /** The Context Window conversation `conversationId` is in: its head marker's entry, or `start` before any. */
  const windowOf = (conversationId: ConversationId) =>
    attempt("headMarker", async () => {
      const marker = await harness.harness.commit(
        (tx) => tx.latestHeadMarker(conversationId),
        context,
      );

      return String(marker?.id ?? "start");
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("The conversation's Context Window is unknown", error).pipe(
          Effect.as("unknown"),
        ),
      ),
    );

  /**
   * A message's request start, in its prepare step: the settings read, then the MCP request start, whose build is
   * installed before the message is placed. Starts of different conversations run side by side; their installs take the
   * install lock in turn, each installing the newest build.
   */
  const startRequest = (conversationId: ConversationId) => {
    const { mcp } = options;

    return refreshSettings.pipe(
      Effect.andThen(
        mcp === undefined
          ? Effect.void
          : windowOf(conversationId).pipe(
              Effect.flatMap((window) =>
                Effect.provideContext(
                  mcp.start(conversationId, window, settings.current()),
                  services,
                ),
              ),
              Effect.andThen(reinstallMcp.pipe(installing, Effect.uninterruptible)),
              // The conversation is told of a change to the listing its section was shown before its message is placed.
              Effect.andThen(
                Effect.provideContext(mcp.notify(conversationId, settings.current()), services),
              ),
            ),
      ),
    );
  };

  // Alarm decisions run one at a time, so an idle check never deletes the heartbeat a concurrent submit just armed.
  const serially = Semaphore.withPermit(yield* Semaphore.make(1));

  // A message is placed (checked, then admitted) in its conversation's line, one at a time and briefly: what takes time
  // is its preparation (template expansion and Attached page reads), outside this lock, in that line
  // (docs/architecture/mcp-in-a-session.md → Getting a prompt at send).
  const inArrivalOrder = Semaphore.withPermit(yield* Semaphore.make(1));

  const admission = admissionLines({
    inArrivalOrder,
    remember: (requestId) => rememberWithdrawn(requestId),
  });

  // The Harness's stop (`stopConversation`, which deleting an agent shares) is Promise-based and calls this before it
  // aborts each conversation: it runs the Effect that withdraws the conversation's line, with the services this Effect
  // runs with, and hands pi-durable back a Promise. Every stop goes through it, so none can leave a line behind.
  const runForStop = Effect.runPromiseWith(yield* Effect.context<never>());

  const beforeAbort = (conversationId: ConversationId): Promise<void> =>
    runForStop(admission.withdrawLine(conversationId));

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
    refusal: () => fillingRefusal(kv),
    preparing: (conversation) => admission.isPreparing(conversation),
    beforeAbort,
    inArrivalOrder,
    left: options.onBranchLeft,
  });

  const { active, treeState } = branches;

  /**
   * The conversation an App View's context for `call` goes to, as a string ID, or none when no conversation can take it: the
   * one the page shows the View in (`shown`) when its History holds the call, else the one the call was made in. A Session
   * branch the active branch has moved off is given nothing (its pending contexts were dropped when it was left, and one held
   * now would wait for good and take up a slot): the active branch takes it when its History holds the call, else it is refused.
   */
  const appContextTarget = (
    call: AppContextCall,
    callId: string,
    shown: ConversationId | undefined,
  ): Effect.Effect<string | undefined, SessionError> =>
    Effect.gen(function* () {
      // A call nested in a `codemode` script is in the History as the script's call.
      const made = call.parentCall ?? callId;

      const target =
        shown !== undefined &&
        String(shown) !== call.conversation &&
        (yield* branches.historyHolds(shown, made))
          ? String(shown)
          : call.conversation;

      if (!(yield* branches.isLeft(toConversationId(Number(target))))) return target;

      const { id } = yield* active;

      return (yield* branches.historyHolds(id, made)) ? String(id) : undefined;
    });

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
    apps: options.apps,
    questions: options.records?.copies,
    visuals: options.visuals,
    inArrivalOrder,
  });

  /**
   * Names the Session after its first answer (`docs/architecture/client-and-protocol.md` → Titles). The root's first message
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
   * Live work keeps the heartbeat, as pi-durable's `wake()` counts it, and a sleeping task too (see `Wake`): a task no
   * installed definition can run never becomes runnable by waking, and a waiting task counts through the live tasks it
   * waits on.
   */
  const wakeOf = (tasks: ReadonlyArray<TaskInspection>): Wake => {
    const runnable = (task: (typeof tasks)[number]) =>
      task.state.kind !== "blocked" && task.state.kind !== "waiting";

    const following = Arr.filter(tasks, isFollower);
    const awake = Arr.filter(following, runnable);
    const sleeping = Arr.filter(awake, (task) => task.state.kind === "sleeping");

    return {
      active: Arr.some(working(tasks), runnable),
      followers: {
        count: following.length,
        needsHeartbeat: awake.length > sleeping.length,
        until: earliest(
          ...Arr.map(sleeping, (task) =>
            task.state.kind === "sleeping" ? task.state.until : undefined,
          ),
        ),
      },
    };
  };

  /** The wake of the tasks live now. */
  const wake: Effect.Effect<Wake, SessionError> = inspect.pipe(
    Effect.map(({ tasks }) => wakeOf(tasks)),
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

  /**
   * How many MCP tasks the Registry was last told this Session follows, kept in storage so a new instance does not tell
   * it again, and a Session that never followed one tells it nothing (the Registry reads none as nothing). `PENDING`
   * after a report that failed, which no count equals: the next settle tells it.
   */
  let reportedTasks: number | undefined = kv.get<number>(REPORTED_TASKS_KEY) ?? 0;

  /**
   * Tell the Registry how many MCP tasks the Session follows (`mcpTasks`) unless it was just told, and say whether it
   * has it. Like a status report, a failure leaves it unknown, for the heartbeat or the next settle to tell again.
   */
  const reportTasks = (count: number): Effect.Effect<boolean> =>
    reportedTasks === count
      ? Effect.succeed(true)
      : registry.reportMcpTasks(count).pipe(
          Effect.timeout(options.reportTimeout ?? REPORT_TIMEOUT),
          Effect.andThen(
            Effect.sync(() => {
              reportedTasks = count;
              kv.put(REPORTED_TASKS_KEY, count);

              return true;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Registry report of MCP tasks failed", cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reportedTasks = undefined;
                  kv.put(REPORTED_TASKS_KEY, REPORT_PENDING);

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
      const observation = await harness.harness.observeTaskGraph(
        { advance: () => undefined, end: () => undefined },
        context,
      );

      const graph = observation.value;

      observation.detach();

      const state = await harness.harness.snapshot(SubagentsDoc, context);

      return sessionAgentsOf(summarizeTaskGraph(graph, state ?? EMPTY_STATE).agents);
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

  /**
   * The alarm once no work is live: deleted, unless the object must wake later anyway: for a follower asks the heartbeat
   * while it is pending or running and its `until` while it sleeps (`Wake.followers`), with what `options.wakeAt` gives.
   */
  const rest = (followers: Followers | undefined) =>
    Effect.all([wakeAt, heartbeat]).pipe(
      Effect.map(([other, beat]) =>
        earliest(other, followers?.needsHeartbeat === true ? beat : undefined, followers?.until),
      ),
      Effect.flatMap((at) =>
        at === undefined
          ? attempt("deleteAlarm", () => storage.deleteAlarm())
          : attempt("setAlarm", () => storage.setAlarm(at)),
      ),
    );

  /** The objects of the Session's Subagent Workspaces, as the Subagents document has them. */
  const subagentWorkspaceObjects = async (): Promise<ReadonlyArray<string>> => {
    const state = await harness.harness.snapshot(SubagentsDoc, context);

    return Arr.flatMap(Record.values(state?.agents ?? {}), (agent) =>
      agent.workspace === undefined ? [] : [agent.workspace.object],
    );
  };

  /**
   * Tell the Workspaces the Session works in that it is at work, so their Containers' hold cap counts from now. In the
   * background, and never failing: a lost note only shortens the cap.
   */
  const noteWorkspaceActivity = Effect.suspend(() => {
    const note = options.workspaceActivity;

    if (note === undefined) return Effect.void;

    return attempt("workspaceActivity", async () => note(await subagentWorkspaceObjects())).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Noting the Session's activity failed", cause),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  const arm = (next: Wake) =>
    next.active
      ? // The heartbeat first: a report that cannot be made must not leave live work unwoken. Each beat writes again
        // the subagents a failed write left due, and tells the Workspaces the Session is at work.
        armHeartbeat.pipe(
          Effect.andThen(report("running")),
          Effect.andThen(
            next.followers === undefined ? Effect.void : reportTasks(next.followers.count),
          ),
          Effect.andThen(Effect.sync(() => agentsReport.retry())),
          Effect.andThen(noteWorkspaceActivity),
          Effect.asVoid,
        )
      : // Report before deleting the heartbeat: an unreported end, or subagents unwritten, keep it, to report again. Nothing
        // that works is live, so an inline MCP task that has a record has lost its call: the sweep ends it, at every wake
        // (which settles) and whenever the Session settles idle.
        onIdle.pipe(
          Effect.andThen(options.mcp?.sweep?.(harness.harness) ?? Effect.void),
          Effect.andThen(report("idle")),
          Effect.flatMap((told) =>
            Effect.all([
              next.followers === undefined
                ? Effect.succeed(true)
                : reportTasks(next.followers.count),
              settleAgents,
            ]).pipe(Effect.map(([counted, written]) => told && counted && written)),
          ),
          Effect.flatMap((told) => (told ? rest(next.followers) : armHeartbeat)),
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
      // At once, before any step that waits, so a write of the next prompt finds the Run closed.
      Effect.andThen(onSettled),
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
  const wakeAndResume = inspect.pipe(
    Effect.flatMap(({ tasks }) => arm(wakeOf(tasks))),
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

  /**
   * Show the held stops of the Session's Workspace it has not shown, each as a notice on the active branch
   * (`held-stops.ts`): when a client connects and before input is admitted. Never failing: a stop not shown is shown
   * at the next check.
   */
  const showHeldStops: Effect.Effect<void> = Effect.gen(function* () {
    const read = options.containerHeldStops;

    if (read === undefined) return;

    const now = yield* Clock.currentTimeMillis;
    const conversation = yield* active;

    yield* attempt("containerHeldStops", () =>
      showHeldStopsIn({
        kv,
        now,
        read,
        write: async (draft) => {
          await conversation.submit(draft, context);
        },
      }),
    );
  }).pipe(
    Effect.timeout(HELD_STOPS_TIMEOUT),
    Effect.catchCause((cause) =>
      Effect.logWarning("Showing the Container's held stops failed", cause),
    ),
  );

  /**
   * Write the App contexts pending for `conversation` as one `write` (`docs/architecture/mcp-apps.md` → App messages and App
   * context): a notice the model reads as untrusted, which never starts a Run. Placed at once in an idle conversation and at
   * its next boundary in a busy one, before any input queued behind it. Answers its submission, or undefined when nothing was
   * pending or the write could not be made: a failure is logged, and the contexts stay pending for the next write.
   */
  const writeAppContexts = (conversation: Conversation): Effect.Effect<Submission | undefined> => {
    const contexts = options.appContexts;

    if (contexts === undefined) return Effect.undefined;

    return contexts.take(String(conversation.id)).pipe(
      Effect.flatMap((taken) =>
        taken === undefined
          ? Effect.undefined
          : attempt("submit", () =>
              conversation.submit(
                { type: "write", requestId: taken.requestId, entry: taken.entry },
                context,
              ),
            ).pipe(
              Effect.tapError(() => taken.release),
              Effect.tap(() => taken.delivered),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("The App contexts could not be written", cause).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  };

  /** Whether `conversation` has admitted `requestId` already; a read that fails says it has not. */
  const resentInput = (conversation: Conversation, requestId: string | undefined) =>
    requestId === undefined
      ? Effect.succeed(false)
      : attempt("submissionByRequest", () =>
          conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context),
        ).pipe(
          Effect.map((admitted) => admitted !== undefined),
          Effect.orElseSucceed(() => false),
        );

  /** The conversations with a write of App contexts waiting for its next boundary: one in flight for each. */
  const contextsInFlight = new Set<ConversationId>();

  /**
   * An App View's context was held for `conversationId`. A busy conversation is written the pending contexts now, to be placed
   * at its next boundary, when none waits there already; the ones held meanwhile are written when that one is placed, if it is
   * still busy. An idle conversation keeps them pending until input is admitted to it, so a View's every change is not an entry
   * of the conversation for good.
   */
  const appContextHeld = (conversationId: ConversationId): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (options.appContexts === undefined || contextsInFlight.has(conversationId)) {
        return Effect.void;
      }

      // Claimed before any step that waits, so two held contexts cannot both write.
      contextsInFlight.add(conversationId);

      const release = Effect.sync(() => contextsInFlight.delete(conversationId));

      return Effect.gen(function* () {
        const conversation = yield* addressed(conversationId);

        const live = yield* attempt("snapshot", () =>
          harness.harness.snapshot(LiveDoc, conversation.id, context),
        );

        if (live?.run === undefined) return yield* release;

        const submission = yield* writeAppContexts(conversation);

        if (submission === undefined) return yield* release;

        const record = yield* attempt("status", () => submission.status(context));

        if (record.status !== "queued") return yield* release;

        // Placed at the boundary: the next write goes then, if the conversation is still busy.
        yield* attempt("wait", () => submission.wait(context)).pipe(
          Effect.ignore,
          Effect.andThen(release),
          Effect.andThen(Effect.suspend(() => appContextHeld(conversationId))),
          Effect.forkIn(scope),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The App contexts could not be delivered", cause).pipe(
            Effect.andThen(release),
          ),
        ),
      );
    });

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
   * root agent's own work and a Rollover request not being the owner's words. `started` says whether its request start
   * (`startRequest`) ran already, in its prepare step. Refused while the Session is being filled as a Fork or Clone, or
   * carries its files to one.
   */
  const admitDraft = (
    conversationId: ConversationId | undefined,
    draft: InputSubmissionDraft,
    { named, started = false }: { readonly named: boolean; readonly started?: boolean },
  ): Effect.Effect<Submission, SessionError> =>
    Effect.gen(function* () {
      yield* unlessForking;

      // The next request runs on the settings in force now. The read stays out of the lock, so a slow Registry never
      // holds up the alarm or a status report.
      if (!started) yield* refreshSettings;

      // A Container stopped for having been held without activity is shown before the message that follows it.
      yield* showHeldStops;

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
        // The App contexts pending for it go first, before the input, which is placed after them at any boundary; a resend of
        // an input that was admitted finds the first submission and writes nothing.
        Effect.tap((conversation) =>
          options.appContexts === undefined
            ? Effect.void
            : resentInput(conversation, draft.requestId).pipe(
                Effect.flatMap((resent) => (resent ? Effect.void : writeAppContexts(conversation))),
              ),
        ),
        Effect.flatMap((conversation) =>
          tracedRun(
            conversation.id,
            attempt("submit", () => conversation.submit(draft, context)),
          ).pipe(
            Effect.tap((admitted) =>
              Effect.sync(() => {
                kv.put(INPUTS_KEY, [
                  ...(kv.get<ReadonlyArray<AdmittedInput>>(INPUTS_KEY) ?? []).slice(
                    -(MAX_INPUTS - 1),
                  ),
                  { id: admitted.id, conversationId: conversation.id },
                ]);
              }),
            ),
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

  /** `work`, failing with a `TimeoutError` when the Workspace takes longer than `EXPAND_TIMEOUT` to answer. */
  const withinExpandTimeout = <A, E>(work: Effect.Effect<A, E>) =>
    Effect.timeout(work, options.expandTimeout ?? EXPAND_TIMEOUT);

  /**
   * The file at `path` in `env`, as base64, for `SessionHost.spill`. The Workspace's `canonicalPath` resolves no link, so
   * each directory of `path` below `/workspace` is looked at (a link is not followed, `fileInfo` is an lstat), and the
   * file is opened without following one, so its size and kind are those of what is read. A directory swapped for a link
   * between the look and the open is not caught: only the Workspace's own writers can make that, and they are the
   * owner's. Each Workspace call is bounded (`bounded`), and the wait for the decode slot is not: it is the previews ahead's.
   */
  const spillOf = (
    env: ExecutionEnv,
    path: string,
    hold: (bytes: number) => HoldSlot,
    bounded: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E | Cause.TimeoutError>,
    max: number = MAX_MCP_RESOURCE_PREVIEW_BYTES,
  ) =>
    Effect.gen(function* () {
      const missing: SpillRead = { kind: "missing" };

      const opened = yield* bounded(
        Effect.gen(function* () {
          for (const directory of spillDirectoriesOf(path)) {
            const info = yield* attempt("spill", () => env.fileInfo(directory, context));

            if (!info.ok || info.value.kind !== "directory") return undefined;
          }

          const reader = yield* Effect.suspend(() => {
            const opening = env.openBinaryReader(path, { noFollow: true }, context);

            return attempt("spill", () => opening).pipe(
              // An open that comes back after its wait ended has no one to close its reader.
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  void opening
                    .then((late) => (late.ok ? late.value.close(BACKGROUND_CONTEXT) : undefined))
                    .catch(() => undefined);
                }),
              ),
            );
          });

          return reader.ok ? reader.value : undefined;
        }),
      );

      if (opened === undefined) return missing;

      const reader = opened;

      return yield* Effect.gen(function* () {
        const info = yield* bounded(attempt("spill", () => reader.info(context)));

        if (!info.ok || info.value.kind !== "file") return missing;

        const size = info.value.size;

        if (size > max) return { kind: "too_large" } as const;

        // The wait for the slot is the previews ahead's, not the Workspace's: it is not under the Workspace's time limit.
        if (size > PREVIEW_SLOT_OVER) {
          const taken = yield* hold(size);

          if (taken !== "held") return { kind: taken } as const;
        }

        const read = yield* bounded(attempt("spill", () => reader.read(0, size, context)));

        // The bytes are let go once they are text: only the base64 is returned.
        return read.ok
          ? ({ kind: "base64", base64: base64FromBytes(read.value) } as const)
          : missing;
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => reader.close(BACKGROUND_CONTEXT).catch(() => undefined)),
        ),
      );
    });

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
    ).pipe(
      Effect.flatMap(([rollover, [skills, templates]]) => {
        const catalog = catalogOf(skills, templates, rollover);
        const prompts = options.mcp?.prompts;

        return prompts === undefined
          ? Effect.succeed(catalog)
          : prompts.catalog(settings.current()).pipe(
              Effect.map(({ prompts: offered, mcpServers }): typeof catalog => {
                const withMcp: Types.Mutable<typeof catalog> = { ...catalog };

                if (offered.length > 0) withMcp.prompts = offered;

                if (mcpServers.length > 0) withMcp.mcpServers = mcpServers;

                return withMcp;
              }),
            );
      }),
    );

  const listings = yield* FileListings;

  /** The paths `env` offers the `@` menu from its directory, held per file namespace and directory. */
  const pathsIn = (env: ExecutionEnv) =>
    listedPaths(listings, env, context).pipe(
      Effect.mapError((error) => SessionError.make({ operation: "files", message: error.message })),
    );

  /**
   * The MCP resources `conversation`'s `@` menu lists: from the servers' lists, never starting a Container
   * (`docs/architecture/mcp-in-a-session.md` → Attached resources). Without MCP resources there are none.
   */
  const resourceMenuFor = (
    conversation: Conversation,
  ): Effect.Effect<McpResourceMenu, SessionError> => {
    const attached = options.mcp?.attached;

    if (attached === undefined) return Effect.succeed({ servers: [] });

    return subagentWorkspaceOf(conversation.id).pipe(
      Effect.flatMap((workspace) =>
        Effect.suspend(() => {
          const stop = new AbortController();

          return attached
            .menu({
              conversation: String(conversation.id),
              workspaceOf: Effect.succeed(workspace?.object),
              signal: stop.signal,
            })
            .pipe(Effect.ensuring(Effect.sync(() => stop.abort())));
        }),
      ),
    );
  };

  /**
   * The suggestions for `request`, for `conversation`'s form: the MCP tools' completion, which asks no server that does not
   * declare the capability and starts no Container. A Session with no MCP tools completes nothing.
   */
  const completeFor = (
    conversation: Conversation,
    request: Omit<McpCompletionInput, "conversation" | "workspaceOf">,
  ): Effect.Effect<McpCompletion, SessionError> => {
    const complete = options.mcp?.complete;

    if (complete === undefined)
      return Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.unsupported));

    return subagentWorkspaceOf(conversation.id).pipe(
      Effect.flatMap((workspace) =>
        complete({
          ...request,
          conversation: String(conversation.id),
          workspaceOf: Effect.succeed(workspace?.object),
        }),
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

  /**
   * What the owner typed, when `input` has pages attached or is a Review's summary: its first text part, unless that is the Attachments' paths
   * (they are a part of their own and come after the typed text, which is left out when empty).
   */
  const typedBeside = (input: UserInput): string => {
    const typed = typedText(input);

    return typed === undefined || typed.startsWith(`@${UPLOADS_ROOT}/`) ? "" : typed;
  };

  /**
   * `draft`'s content with `inserted` (a block of text, and the images that belong with it) put before the first image from
   * part `from` on: the owner's own parts, and an MCP prompt's before `from`, stay ahead of it.
   */
  const withBlockBefore = (
    draft: InputSubmissionDraft,
    from: number,
    inserted: ReadonlyArray<InputPart>,
  ) => {
    const parts = Predicate.isString(draft.content)
      ? draft.content === ""
        ? []
        : [{ type: "text" as const, text: draft.content }]
      : [...draft.content];

    const at = Option.getOrElse(
      Arr.findFirstIndex(parts, (part, index) => index >= from && part.type === "image"),
      () => parts.length,
    );

    return [...parts.slice(0, at), ...inserted, ...parts.slice(at)];
  };

  /**
   * The `cloudpid.user` entry of `draft` with `changes` (the pages or the resources a block adds) over what it already
   * keeps (`UserEntryData`): a Review's Annotations stay beside the pages, an MCP prompt's data beside both.
   */
  const entryKeeping = (
    draft: InputSubmissionDraft,
    input: UserInput,
    changes: {
      readonly pages?: ReadonlyArray<AttachedPage>;
      readonly resources?: ReadonlyArray<AttachedResource>;
      readonly app?: ReadonlyArray<SentAppMessage>;
      readonly trigger?: TriggerPayloadChip;
    } = {},
  ) => {
    const data = userEntryData({ kind: draft.entry?.kind ?? "", data: draft.entry?.data });

    return ownerEntry({
      display: data?.display ?? typedBeside(input),
      skills: data?.skills ?? [],
      pages: changes.pages ?? data?.pages,
      review: data?.review,
      mcpPrompt: data?.mcpPrompt,
      resources: changes.resources ?? data?.resources,
      app: changes.app ?? data?.app,
      trigger: changes.trigger ?? data?.trigger,
    });
  };

  const withPages = (
    draft: InputSubmissionDraft,
    input: UserInput,
    pages: ReadonlyArray<AttachedPage>,
    // The parts the pages go after: an MCP prompt's block and images, which come before the owner's own parts.
    from = 0,
  ): InputSubmissionDraft => ({
    ...draft,
    content: withBlockBefore(draft, from, [{ type: "text" as const, text: pageBlock(pages) }]),
    entry: entryKeeping(draft, input, { pages: Arr.map(pages, (page) => clampPage(page)) }),
  });

  /** A Review's data as the entry stores it. */
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: a Review's data is strings, numbers, and arrays and objects of them, as its Schema says: JSON, only typed read-only.
  const reviewJson = (data: ReviewData): JsonValue => data as unknown as JsonValue;

  /** An MCP prompt's data as the entry stores it. */
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: an MCP prompt's data is strings, and arrays and objects of them, as its Schema says: JSON, only typed read-only.
  const mcpPromptJson = (data: McpPromptData): JsonValue => data as unknown as JsonValue;

  /** What a `cloudpid.user` entry stores (`UserEntryData`), as JSON. */
  type OwnerEntryData = {
    display: string;
    skills: Array<UserEntryData["skills"][number]>;
    pages?: Array<AttachedPage>;
    review?: JsonValue;
    mcpPrompt?: JsonValue;
    resources?: Array<AttachedResource>;
    app?: Array<SentAppMessage>;
    trigger?: TriggerPayloadChip;
  };

  /**
   * The `cloudpid.user` entry of an owner's message: what they typed, the Skills expanded into it, and the pages it
   * attached and the Review it sends, when it does.
   */
  const ownerEntry = (kept: {
    readonly display: string;
    readonly skills: UserEntryData["skills"];
    readonly pages?: ReadonlyArray<AttachedPage> | undefined;
    readonly review?: ReviewData | undefined;
    readonly mcpPrompt?: McpPromptData | undefined;
    readonly resources?: ReadonlyArray<AttachedResource> | undefined;
    readonly app?: ReadonlyArray<SentAppMessage> | undefined;
    readonly trigger?: TriggerPayloadChip | undefined;
  }) => {
    const data: OwnerEntryData = { display: kept.display, skills: [...kept.skills] };

    if (kept.pages !== undefined) data.pages = [...kept.pages];

    if (kept.review !== undefined) data.review = reviewJson(kept.review);

    if (kept.mcpPrompt !== undefined) data.mcpPrompt = mcpPromptJson(kept.mcpPrompt);

    if (kept.resources !== undefined) data.resources = [...kept.resources];

    if (kept.app !== undefined) data.app = [...kept.app];

    if (kept.trigger !== undefined) data.trigger = kept.trigger;

    return { kind: USER_ENTRY_KIND, data };
  };

  /**
   * `input` with its typed text replaced by `content`; a text block is made for it, first, when the owner typed none (the
   * Attachments' paths, a part of their own, are kept).
   */
  const withReviewText = (input: UserInput, content: string): UserInput =>
    Predicate.isString(input) || typedBeside(input) !== ""
      ? withText(input, content)
      : [{ type: "text" as const, text: content }, ...input];

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
  const expandedDraft = (prompt: Prompt): Effect.Effect<DraftOf, SessionError> => {
    const {
      conversationId,
      input,
      review,
      attachPages: _attachPages,
      via: _via,
      mcpPrompt: _mcpPrompt,
      resources: _resources,
      payload: _payload,
      ...rest
    } = prompt;

    const typed = typedText(input);

    // A Review is the owner's message too: the summary as typed (or expanded), then its Markdown; its entry keeps both.
    const reviewed =
      (content: string, skills: UserEntryData["skills"]): DraftOf =>
      (rendered) =>
        rendered === undefined
          ? { type: "input", content: input, ...rest }
          : {
              type: "input",
              content: withReviewText(input, reviewMessage(content, rendered.markdown)),
              ...rest,
              entry: ownerEntry({ display: typedBeside(input), skills, review: rendered.data }),
            };

    const plain = reviewed(typedBeside(input), []);

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
      Effect.map((expanded): DraftOf => {
        if (expanded === undefined) return plain;

        if (review !== undefined) return reviewed(expanded.content, expanded.data.skills);

        const draft: InputSubmissionDraft = {
          ...plain(undefined),
          content: withText(input, expanded.content),
          entry: ownerEntry(expanded.data),
        };

        return () => draft;
      }),
    );
  };

  /** The Subagent Workspace `conversationId` works in, or undefined for the Session's own. Fails for no agent's. */
  const subagentWorkspaceOf = (conversationId: ConversationId) =>
    agentConversation(conversationId).pipe(
      Effect.andThen(attempt("workspace", () => harness.harness.snapshot(SubagentsDoc, context))),
      Effect.map((state) =>
        state === undefined ? undefined : conversationWorkspace(state, conversationId),
      ),
    );

  /**
   * Check the pick `picked` of `prompt` before anything is asked of a server: this Session has MCP prompts, the message
   * is no Review, the Environment still offers the prompt and the arguments are sound. What it answers is what the get
   * sends: the prompt as the catalog lists it, and the arguments cleaned (`promptArguments`).
   */
  const checkedPick = (prompt: Prompt, picked: NonNullable<Prompt["mcpPrompt"]>) =>
    Effect.gen(function* () {
      const { ref } = picked;

      const refused = (code: McpPromptErrorCode, message: string) =>
        promptRefusal(code, message, ref.server);

      const prompts = options.mcp?.prompts;

      if (prompts === undefined) {
        return yield* refused("MCP_PROMPT_FAILED", "This Session has no MCP prompts");
      }

      if (prompt.review !== undefined) {
        return yield* refused("MCP_PROMPT_FAILED", "An MCP prompt cannot go with a Review");
      }

      const values = settings.current();
      const catalog = yield* prompts.catalog(values);

      const offered = Arr.findFirst(
        catalog.prompts,
        (each) => each.server === ref.server && each.name === ref.name,
      );

      if (Option.isNone(offered)) {
        return yield* refused(
          "MCP_PROMPT_FAILED",
          `${ref.server} does not offer the prompt ${ref.name} (any more)`,
        );
      }

      const wanted = ref.arguments ?? {};
      const problem = promptArgumentsProblem(offered.value.arguments, wanted);

      if (problem !== undefined) return yield* refused("MCP_PROMPT_ARGUMENTS", problem);

      return {
        prompts,
        values,
        entry: offered.value,
        sent: promptArguments(offered.value.arguments, wanted),
      };
    });

  /**
   * Where the files of a prompt's result go: the Session's uploads directory, written through the lookup environment,
   * which never starts the Container (ADR-0018). A result with no such file never needs it, so an environment that is
   * not there is only a refusal of the files.
   */
  const promptFiles = (conversation: Conversation, session: string | undefined) =>
    Effect.gen(function* () {
      const env = yield* environment(conversation, { lookup: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "The Workspace environment for a prompt's files is not there",
            error,
          ).pipe(Effect.as(undefined)),
        ),
      );

      // The files this send makes are named by a number of its own and their order.
      const tag = (yield* Random.nextInt).toString(36);
      let files = 0;

      const save = async (file: PromptFile): Promise<string> => {
        if (env === undefined || session === undefined) {
          throw new Error("This Session has no Workspace to keep the file in");
        }

        const path = attachmentPath(session, promptFileName(file, `${tag}${files++}`));
        const written = await env.writeFile(path, file.bytes, context);

        if (!written.ok) throw new Error(written.error.message);

        return path;
      };

      return { env, save };
    });

  /**
   * The draft of a message that names an MCP prompt: the prompt is got now, once, as the message is admitted
   * (`docs/architecture/mcp-in-a-session.md` → Getting a prompt at send), and its block, its images and the typed text are
   * the message's parts, in the order `promptContent` names, with what the owner attached after them (`from`, the
   * parts that are the prompt's own: `promptPartCount`). Anything that goes wrong refuses the send with a code, and
   * nothing is placed.
   */
  const mcpPromptDraft = (
    prompt: Prompt,
    picked: NonNullable<Prompt["mcpPrompt"]>,
  ): Effect.Effect<{ readonly draft: InputSubmissionDraft; readonly from: number }, SessionError> =>
    Effect.gen(function* () {
      const { ref } = picked;

      const {
        conversationId: _conversationId,
        input,
        review: _review,
        attachPages: _attachPages,
        via: _via,
        mcpPrompt: _mcpPrompt,
        resources: _resources,
        payload: _payload,
        ...rest
      } = prompt;

      // A resend of a message that was admitted finds the first submission: the prompt is not got again.
      if (yield* wasAdmitted(prompt)) {
        return { draft: { type: "input" as const, content: input, ...rest }, from: 0 };
      }

      const { prompts, values, entry, sent } = yield* checkedPick(prompt, picked);

      const conversation = yield* addressed(prompt.conversationId);
      const redact = yield* picked.redact;
      const workspace = yield* subagentWorkspaceOf(conversation.id);
      const { env, save } = yield* promptFiles(conversation, prompts.session);
      const { typed, beside } = typedAndBeside(input);

      const got = yield* prompts
        .get(
          values,
          {
            server: ref.server,
            name: ref.name,
            command: entry.command,
            title: entry.title ?? entry.name,
            arguments: sent,
            conversationId: conversation.id,
            workspace: workspace?.object,
            requestId: prompt.requestId,
          },
          async (result, asked) => ({
            made: await promptMessage({
              server: ref.server,
              name: ref.name,
              title: entry.title,
              result,
              typed,
              imageBudget: INLINE_IMAGE_BUDGET - imageCharacters(beside),
              redact,
              save,
            }),
            asked,
          }),
        )
        .pipe(Effect.mapError((error) => redactedError(error, redact)));

      const { made, asked } = got;

      if (Result.isFailure(made)) {
        return yield* promptRefusal(made.failure.code, redact(made.failure.message), ref.server);
      }

      const message = made.success;

      // `$name` Skill links still apply to the typed text; no command runs.
      const skills =
        typed.includes("$") && env !== undefined ? yield* orNone("Skills", skillsIn(env)) : [];

      return {
        draft: {
          type: "input" as const,
          content: promptContent(message, linkSkillReferences(typed, skills), beside),
          ...rest,
          entry: ownerEntry({
            display: typed,
            skills: [],
            mcpPrompt: promptData(entry, redact(sent), message, redact(asked)),
          }),
        },
        from: promptPartCount(message),
      };
    });

  /**
   * What `prompt` is before its pages: a message that names an MCP prompt, or the owner's own input expanded, as a
   * draft of its Review, and how many of its first parts the pages go after. A typed `/mcp__…` that was not picked is
   * refused: an MCP prompt is picked from the `/` menu.
   */
  const prepared = (
    prompt: Prompt,
  ): Effect.Effect<{ readonly expanded: DraftOf; readonly from: number }, SessionError> => {
    const { mcpPrompt } = prompt;

    if (mcpPrompt !== undefined) {
      return mcpPromptDraft(prompt, mcpPrompt).pipe(
        Effect.map(({ draft, from }) => ({ expanded: () => draft, from })),
      );
    }

    const typed = typedText(prompt.input);

    if (typed !== undefined && looksLikeMcpPromptCommand(typed)) {
      return Effect.fail(
        SessionError.make({
          operation: "submit",
          message: MCP_PROMPT_NOT_PICKED_MESSAGE,
          code: "MCP_PROMPT_FAILED",
        }),
      );
    }

    return expandedDraft(prompt).pipe(Effect.map((expanded) => ({ expanded, from: 0 })));
  };

  /**
   * `draft` with the pages attached to `prompt`: their block of page content as a text part of its own, before the first
   * image (the pages' screens, then the Attachments' pictures), apart from the owner's words, and the entry that keeps
   * what was read of them for the transcript's chips (`docs/architecture/client-and-protocol.md` → Attached pages).
   */
  const draftOf = (prompt: Prompt): Effect.Effect<InputSubmissionDraft, SessionError> =>
    prepared(prompt).pipe(
      Effect.flatMap(({ expanded, from }) =>
        Effect.all(
          [
            attachedPages(prompt),
            attachedResources(prompt, partsOf(expanded(undefined))),
            firePayload(prompt),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([pages, resources, fired]): DraftOf => (rendered) => {
            const paged =
              pages.length === 0
                ? expanded(rendered)
                : withPages(expanded(rendered), prompt.input, pages, from);

            const sourced =
              resources === undefined ? paged : withResources(paged, prompt.input, resources, from);

            const delivered =
              fired === undefined ? sourced : withPayload(sourced, prompt.input, fired, from);

            return prompt.apps === undefined || prompt.apps.length === 0
              ? delivered
              : withApps(delivered, prompt.input, prompt.apps, from);
          }),
        ),
      ),
      Effect.flatMap((draft) => {
        const { review } = prompt;

        if (review === undefined) return Effect.succeed(draft(undefined));

        const all = renderReview(review.annotations);

        if (all.crops.length === 0) return Effect.succeed(draft(all));

        return queuedBytes(prompt.conversationId).pipe(
          Effect.map((queued) => withCrops(draft, review.annotations, all, queued)),
        );
      }),
    );

  /**
   * The draft of a Review of `annotations` (`all`, rendered with every crop) with the crops of its page Annotations it
   * has room for (`fitCrops`, beside the `queued` bytes of the messages waiting in the inbox) as its last parts, each
   * after the line that names its Annotation; the Review rendered with only those marked `crop`, and its entry's
   * `review` naming them, for the transcript to show them on the Review's chips rather than in the message.
   */
  const withCrops = (
    draft: DraftOf,
    annotations: ReadonlyArray<Annotation>,
    all: RenderedReview,
    queued: number,
  ): InputSubmissionDraft => {
    // Measured with every crop marked: the Review rendered with fewer is no longer.
    const measured = draft(all);

    const images = Arr.reduce(partsOf(measured), 0, (sum, part) =>
      part.type === "image" ? sum + part.data.length : sum,
    );

    const fitted = fitCrops(all.crops, {
      bytes: storedBytes({ content: measured.content, entry: measured.entry }) + queued,
      images,
    });

    const sent = Arr.map(fitted, ({ number }) => number);
    const { markdown, data } = renderReview(annotations, new Set(sent));

    if (fitted.length === 0) return draft({ markdown, data });

    const final = draft({ markdown, data: { ...data, crops: sent } });

    return { ...final, content: [...partsOf(final), ...Arr.flatMap(fitted, cropParts)] };
  };

  /** A draft's content as parts. */
  const partsOf = (draft: InputSubmissionDraft) =>
    Predicate.isString(draft.content)
      ? [{ type: "text" as const, text: draft.content }]
      : [...draft.content];

  /** The bytes of the messages waiting in the conversation's inbox, as `input-guard.ts` measures them. */
  const queuedBytes = (conversationId: ConversationId | undefined) =>
    addressed(conversationId).pipe(
      Effect.flatMap((conversation) =>
        attempt("snapshot", () => harness.harness.snapshot(InboxDoc, conversation.id, context)),
      ),
      Effect.map((inbox) =>
        inbox === undefined || inbox.items.length === 0 ? 0 : storedBytes(inbox),
      ),
    );

  /** Whether the conversation has admitted `prompt`'s `requestId` already: a resend finds the first submission. */
  const wasAdmitted = (prompt: Prompt): Effect.Effect<boolean, SessionError> => {
    const { requestId } = prompt;

    if (requestId === undefined) return Effect.succeed(false);

    return addressed(prompt.conversationId).pipe(
      Effect.flatMap((conversation) =>
        // A commit that writes nothing is discarded: a read through pi-durable's own path.
        attempt("submissionByRequest", () =>
          conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context),
        ),
      ),
      Effect.map((admitted) => admitted !== undefined),
    );
  };

  /**
   * The pages `prompt` attaches, read now. Not read for a `requestId` the conversation has already admitted: that
   * submit finds the first submission, whatever the pages are now.
   */
  const attachedPages = (
    prompt: Prompt,
  ): Effect.Effect<ReadonlyArray<AttachedPage>, SessionError> => {
    const { attachPages } = prompt;

    if (attachPages === undefined) return Effect.succeed([]);

    return wasAdmitted(prompt).pipe(
      Effect.flatMap((admitted) => (admitted ? Effect.succeed([]) : attachPages)),
    );
  };

  /**
   * The Attached resources `prompt` names, read now, each once, in parallel, and made into the message's block, images
   * and chips (`docs/architecture/mcp-in-a-session.md` → Attached resources). Not read for a `requestId` the conversation
   * has already admitted. A resource that is not found, or whose server is gone, refuses the send with
   * `ATTACHED_RESOURCE_GONE` (the first of them, in the order attached), and nothing is placed; any other failure becomes the
   * resource's error line in the block. `parts` are the message's parts so far: the images among them have used the
   * inline image budget.
   */
  const attachedResources = (
    prompt: Prompt,
    parts: ReadonlyArray<MessagePart>,
  ): Effect.Effect<AttachedMessage | undefined, SessionError> => {
    const { resources } = prompt;

    if (resources === undefined || resources.refs.length === 0) return Effect.undefined;

    return wasAdmitted(prompt).pipe(
      Effect.flatMap((admitted) =>
        admitted ? Effect.undefined : readAttachedResources(prompt, resources, parts),
      ),
    );
  };

  /** The reads of `resources`' refs, as `attachedResources` describes. */
  const readAttachedResources = (
    prompt: Prompt,
    resources: NonNullable<Prompt["resources"]>,
    parts: ReadonlyArray<MessagePart>,
  ): Effect.Effect<AttachedMessage | undefined, SessionError> =>
    Effect.gen(function* () {
      const redact = yield* resources.redact;

      const refs = Arr.dedupeWith(resources.refs, (a, b) => resourceKey(a) === resourceKey(b));

      const attached = options.mcp?.attached;
      const [first] = refs;

      if (attached === undefined) {
        return first === undefined
          ? undefined
          : yield* resourceGone(first, "This Session has no MCP servers", redact);
      }

      const conversation = yield* addressed(prompt.conversationId);
      const workspace = yield* subagentWorkspaceOf(conversation.id);
      const { save } = yield* promptFiles(conversation, attached.session);

      // What the resources of this message share: the image budget the message's other images left, and the room for
      // inline text. Whichever read arrives first takes room first.
      const budgets: AttachedBudgets = {
        images:
          INLINE_IMAGE_BUDGET -
          Arr.reduce(
            parts,
            0,
            (sum, part) => sum + (part.type === "image" ? (part.data?.length ?? 0) : 0),
          ),
        text: MAX_RESOURCES_INLINE_TEXT_BYTES,
      };

      const reads = yield* Effect.forEach(
        refs,
        (ref) =>
          Effect.suspend(() => {
            const stop = new AbortController();

            return attached
              .read({
                server: ref.server,
                uri: ref.uri,
                conversation: String(conversation.id),
                workspaceOf: Effect.succeed(workspace?.object),
                signal: stop.signal,
                use: (contents) =>
                  attachedResource({ redact, server: ref.server, ref, contents, budgets, save }),
              })
              .pipe(Effect.ensuring(Effect.sync(() => stop.abort())));
          }),
        { concurrency: "unbounded" },
      );

      const made: Array<AttachedMade> = [];

      for (const [index, read] of reads.entries()) {
        const ref = refs[index];

        if (ref === undefined) continue;

        if (read.status === "gone") return yield* resourceGone(ref, read.message, redact);

        if (read.status === "read") {
          made.push(read.value);

          continue;
        }

        const failed = failedResource(redact, ref.server, ref, read.message);

        made.push({ elements: [failed.element], images: [], chip: failed.chip });
      }

      return attachedMessage(made);
    });

  /**
   * The payload `prompt` carries, made into its block and chip: its whole body written to the Workspace first, through
   * the lookup environment, which never starts the Container (ADR-0018). Not made for a `requestId` the conversation has
   * already admitted: a resend finds the first submission. A Workspace that cannot be written fails the send as an
   * unavailable Session, which a Fire tries again.
   */
  const firePayload = (prompt: Prompt): Effect.Effect<PayloadMade | undefined, SessionError> =>
    Effect.gen(function* () {
      const { payload } = prompt;

      if (payload === undefined || (yield* wasAdmitted(prompt))) return undefined;

      const redact = yield* payload.redact;
      const { body } = payload.payload;

      if (body === undefined) {
        return triggerPayload({ payload: payload.payload, path: undefined, redact });
      }

      const conversation = yield* addressed(prompt.conversationId);
      const env = yield* environment(conversation, { lookup: true });

      if (env === undefined) {
        return yield* SessionError.make({
          operation: "payload",
          message: "This Session has no Workspace to keep the delivery's body in",
        });
      }

      const path = payloadFilePath(payload.key);

      const written = yield* attempt("payload", () =>
        env.writeFile(path, new TextEncoder().encode(body), context),
      );

      if (!written.ok) {
        return yield* SessionError.make({ operation: "payload", message: written.error.message });
      }

      return triggerPayload({ payload: payload.payload, path, redact });
    });

  /**
   * `draft` with a Fire's payload block as a text part of its own, before the first image from part `from` on (after the
   * blocks of pages and resources, which were placed the same way), and the entry that keeps its chip.
   */
  const withPayload = (
    draft: InputSubmissionDraft,
    input: UserInput,
    made: PayloadMade,
    from: number,
  ): InputSubmissionDraft => ({
    ...draft,
    content: withBlockBefore(draft, from, [{ type: "text" as const, text: made.block }]),
    entry: entryKeeping(draft, input, { trigger: made.chip }),
  });

  /** The refusal of a send whose resource `ref` is gone, with `why` redacted. */
  const resourceGone = (
    ref: ResourceRef,
    why: string,
    redact: <A>(value: A) => A,
  ): Effect.Effect<never, SessionError> =>
    Effect.fail(
      SessionError.make({
        operation: "submit",
        message: redact(attachedResourceGoneMessage(ref.server, ref.uri, why)),
        code: ATTACHED_RESOURCE_GONE,
        server: ref.server,
      }),
    );

  /**
   * `draft` with the Attached resources' block as a text part of its own, and their inline images after it, before the
   * first image from part `from` on (the pages' block, which was placed the same way, comes before it), and the entry that
   * keeps what became of them for the chips.
   */
  const withResources = (
    draft: InputSubmissionDraft,
    input: UserInput,
    message: AttachedMessage,
    from: number,
  ): InputSubmissionDraft => ({
    ...draft,
    content: withBlockBefore(draft, from, [
      { type: "text" as const, text: message.block },
      ...message.images,
    ]),
    entry: entryKeeping(draft, input, { resources: message.chips }),
  });

  /**
   * `draft` with the App messages the owner sent as a text part each, of their own, before the first image from part `from` on
   * (after the blocks of pages and resources, which were placed the same way), and the entry that keeps who offered them.
   */
  const withApps = (
    draft: InputSubmissionDraft,
    input: UserInput,
    apps: ReadonlyArray<SentAppMessage>,
    from: number,
  ): InputSubmissionDraft => ({
    ...draft,
    content: withBlockBefore(
      draft,
      from,
      Arr.map(apps, (app) => ({ type: "text" as const, text: app.text })),
    ),
    entry: entryKeeping(draft, input, { app: apps }),
  });

  /**
   * Refuse `draft` when the Session could not store it: an image the providers do not take, or a message that would not
   * fit one row, alone or in the conversation's inbox beside the messages waiting there (`input-guard.ts`). Its
   * expansion is in it, so what is measured is what would be written. Run in arrival order, so the inbox read is not
   * outgrown by a message admitted meanwhile.
   */
  const guard = (
    conversationId: ConversationId | undefined,
    draft: InputSubmissionDraft,
    // The server of the MCP prompt the message got: its refusal then says why with a code.
    prompt?: string,
  ) =>
    Effect.suspend(() => {
      const refused = (problem: InputProblem) =>
        prompt === undefined
          ? SessionError.make({ operation: "submit", message: problem.message })
          : promptRefusal(
              // Only a size is a prompt too large; an image type the providers do not take is the owner's own
              // attachment (only types they take are inlined from the server's content), which fails the send.
              problem.kind === "size" ? "MCP_PROMPT_TOO_LARGE" : "MCP_PROMPT_FAILED",
              problem.message,
              prompt,
            );

      // The row pi-durable writes is the entry (its model message, from `content`, and its kind and data, from `entry`) or
      // the inbox document holding it, both as JSON; `{ content, entry }` is that JSON but for a few fields (IDs, the
      // timestamp, the role), which the room between `MAX_STORED_INPUT_BYTES` and the 8 MiB row (workerd#7493) leaves.
      const alone = inputProblemOf(draft, 0);

      if (alone !== undefined) return Effect.fail(refused(alone));

      return queuedBytes(conversationId).pipe(
        // The storage could not be read: not a size, whatever the message is.
        Effect.mapError((error) =>
          prompt === undefined ? error : promptRefusal("MCP_PROMPT_FAILED", error.message, prompt),
        ),
        Effect.flatMap((queued) => {
          const problem = inputProblemOf(draft, queued);

          return problem === undefined ? Effect.void : Effect.fail(refused(problem));
        }),
      );
    });

  /** `draft` with the marks of who sent it over the MCP endpoint, kept in the owner's entry (`UserEntryData.via`). */
  const withVia = (
    draft: InputSubmissionDraft,
    input: UserInput,
    via: SessionVia | undefined,
  ): Effect.Effect<InputSubmissionDraft, SessionError> =>
    via === undefined
      ? Effect.succeed(draft)
      : Schema.encodeEffect(SessionVia)(via).pipe(
          Effect.map((encoded) => {
            const kept = entryKeeping(draft, input);

            return { ...draft, entry: { ...kept, data: { ...kept.data, via: encoded } } };
          }),
          Effect.mapError((error) =>
            SessionError.make({ operation: "submit", message: error.message }),
          ),
        );

  /** Whether Stop withdrew a message sent under `requestId` lately. A record that cannot be read says it did not. */
  const wasWithdrawn = (requestId: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.try(() =>
          Arr.some(
            kv.get<ReadonlyArray<WithdrawnRequest>>(WITHDRAWN_KEY) ?? [],
            (kept) => kept.requestId === requestId && now - kept.at < WITHDRAWN_KEPT_MS,
          ),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Keep `requestId` as withdrawn: the recent ones only, at most `MAX_WITHDRAWN`, and none longer than
   * `MAX_WITHDRAWN_ID`. Never failing: a write the storage refuses leaves the withdrawal as it is.
   */
  const rememberWithdrawn = (requestId: string): Effect.Effect<void> =>
    requestId.length > MAX_WITHDRAWN_ID
      ? Effect.void
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.try(() => {
              const recent = Arr.filter(
                kv.get<ReadonlyArray<WithdrawnRequest>>(WITHDRAWN_KEY) ?? [],
                (kept) => kept.requestId !== requestId && now - kept.at < WITHDRAWN_KEPT_MS,
              );

              kv.put(WITHDRAWN_KEY, [
                ...recent.slice(-(MAX_WITHDRAWN - 1)),
                { requestId, at: now },
              ]);
            }),
          ),
          Effect.ignore,
        );

  /**
   * Admit `prompt` in two steps (docs/architecture/mcp-in-a-session.md → Getting a prompt at send). It first takes its
   * place in the line of its conversation, where it waits for the messages sent before it; the Session tree does not
   * move while it is in line. It is then prepared, with no lock held, so a slow expansion or page read holds back
   * neither Stop nor another conversation. Last it is placed, briefly under `inArrivalOrder`: checked, then admitted.
   * Stop withdraws it until it is placed: it then fails as `withdrawnFailure()` and places nothing, and the line
   * remembers its `requestId` for a while (`WITHDRAWN_KEY`).
   */
  const admit = (prompt: Prompt): Effect.Effect<Submission, SessionError> =>
    Effect.gen(function* () {
      const { requestId } = prompt;

      // Sent again after Stop withdrew it (a client that saw no answer): it is withdrawn again, not placed after the Stop.
      if (requestId !== undefined && (yield* wasWithdrawn(requestId))) {
        return yield* withdrawnFailure();
      }

      return yield* admission.inLine(
        addressed(prompt.conversationId).pipe(Effect.map((conversation) => conversation.id)),
        (conversationId) =>
          // A message the Session would refuse is not expanded first. Its request starts before it is placed: the
          // settings read and the MCP tools built, which may wait for a server's discovery.
          unlessForking.pipe(
            Effect.andThen(startRequest(conversationId)),
            Effect.andThen(draftOf({ ...prompt, conversationId })),
            Effect.flatMap((draft) => withVia(draft, prompt.input, prompt.via)),
          ),
        (conversationId, draft) =>
          guard(conversationId, draft, prompt.mcpPrompt?.ref.server).pipe(
            Effect.andThen(admitDraft(conversationId, draft, { named: true, started: true })),
          ),
        requestId,
      );
    });

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
            admitDraft(conversation.id, ownerRollover(focus, `${now}-${random}`), {
              named: false,
            }).pipe(inArrivalOrder),
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
      // The questions the calls asked are kept outside the History: a line for each follows its call's result.
      const lines = options.records === undefined ? undefined : yield* options.records.exportLines;

      const built = markdownExport(
        conversation.id,
        DateTime.formatIso(yield* DateTime.now),
        MAX_EXPORT_BYTES,
        {
          appContext: (callId) => options.appContexts?.contextFor(callId, String(conversation.id)),
          mcpLines: lines,
        },
      );

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
          graph.start(async (call) => {
            if (call.kind !== "value") return;
            latest = call.value;
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

      return (await options.containerUsage(await subagentWorkspaceObjects())) ?? null;
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
                          samplingTotals(kv),
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

  const conversationView = (conversationId: ConversationId, window?: ConversationWindow) =>
    Stream.callback<ConversationFrame, SessionError>((queue) =>
      Effect.acquireRelease(
        attempt("watch", async () => {
          const conversation = await harness.harness.conversation(conversationId, context);

          if (conversation === undefined) {
            throw new Error(`Conversation ${conversationId} does not exist`);
          }

          return conversation.watch(context, window);
        }),
        (watch) => Effect.promise(() => watch.stop()),
      ).pipe(
        Effect.andThen((watch) =>
          Effect.sync(() => {
            // The screenshots each frame carries are bounded: it is one socket message, whose size is capped.
            Queue.offerUnsafe(queue, {
              type: "view",
              view: limitViewImages(watch.value, WATCH_IMAGES),
            });
            watch.start((call) => {
              // pi ends a watch on failure rather than sending a `failed` call.
              if (call.kind !== "value" || call.ops.length === 0) return Promise.resolve();

              // A call that replaces the whole view (more changes folded than pi keeps operations for) is sent whole.
              Queue.offerUnsafe(
                queue,
                isBase(call.ops)
                  ? { type: "view", view: limitViewImages(call.value, WATCH_IMAGES) }
                  : { type: "ops", ops: limitOpsImages(call.ops, WATCH_IMAGES) },
              );

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
          watch?.start((call) => {
            if (call.kind === "value") publish(call.value);

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
          watch.start((call) => {
            if (call.kind === "value") Queue.offerUnsafe(queue, tasksOf(call.value));

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

  const mcpTasks: SessionHostService["mcpTasks"] = Stream.callback<
    ReadonlyArray<McpTask>,
    SessionError
  >((queue) =>
    Effect.acquireRelease(
      attempt("watchMcpTasks", async () => {
        // The document exists once the first MCP task started; the first watch of a Session that has none makes it.
        if ((await harness.harness.snapshot(McpTasksDoc, context)) === undefined) {
          await harness.harness.commit(async (tx) => {
            await tx.doc(McpTasksDoc);
          }, context);
        }

        const watch = await harness.harness.watchDoc(McpTasksDoc, context);

        if (watch === undefined) throw new Error("the MCP tasks document is missing");

        Queue.offerUnsafe(queue, viewOfTasks(watch.value));
        watch.start((call) => {
          if (call.kind === "value") Queue.offerUnsafe(queue, viewOfTasks(call.value));

          return Promise.resolve();
        });
        void watch.closed.then((end) =>
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(SessionError.make({ operation: "watchMcpTasks", message: watchEnded(end) })),
          ),
        );

        return watch;
      }),
      (watch) => Effect.promise(() => watch.stop()),
    ),
  ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));

  const mcpTaskList = attempt("mcpTasks", async () =>
    viewOfTasks(await harness.harness.snapshot(McpTasksDoc, context)),
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

  // A Run an MCP task's follower started is notified as one the owner's submission started, and a follower that moved
  // settles the Session.
  options.mcp?.settleOnFollowers?.(() => {
    runAgents(settleWhenIdle);
  });

  yield* wakeAndResume;

  // A broadcast a restart cut off finishes in the background: it is not held up by the start (it ends by itself, and
  // nothing but a listing that was not told yet makes it read a conversation).
  yield* started.announce.pipe(Effect.forkIn(scope));

  // A `/compact` that was waiting for a Run when the last instance went away waits again.
  for (const key of Record.keys(pendingCompactions())) {
    // SAFETY: the keys are the IDs of conversations a `/compact` was addressed to, written above.
    yield* compactWhenIdle(Number(key) as ConversationId);
  }

  /**
   * The conversation to read: the active branch's by default, else any conversation of the Session (a branch left, or a
   * subagent's), which `addressed` would refuse for a command.
   */
  const readable = (conversationId: number | undefined) =>
    conversationId === undefined
      ? active
      : attempt("conversation", () =>
          harness.harness.conversation(toConversationId(conversationId), context),
        ).pipe(
          Effect.filterOrFail(Predicate.isNotUndefined, () =>
            SessionError.make({
              operation: CONVERSATION_MISSING,
              message: `Conversation ${conversationId} does not exist`,
            }),
          ),
        );

  /** The conversation's unsettled inputs and its newest settled one, with what the endpoint's wait needs of the rest. */
  const follow = (conversationId?: number): Effect.Effect<FollowState, SessionError> =>
    Effect.gen(function* () {
      const current = yield* active;
      const conversation = yield* readable(conversationId);
      const copying = yield* forks.filling;
      const { tasks, submissions } = yield* inspect;
      const state = yield* attempt("follow", () => harness.harness.snapshot(SubagentsDoc, context));

      const newest = yield* attempt("follow", () =>
        conversation.commit(
          (tx) => tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 1),
          context,
        ),
      );

      // The inputs the Session admitted to this conversation, newest first: the first that settled is the Run that ended.
      const ids = Arr.reverse(
        Arr.map(
          Arr.filter(
            kv.get<ReadonlyArray<AdmittedInput>>(INPUTS_KEY) ?? [],
            (input) => input.conversationId === conversation.id,
          ),
          (input) => input.id,
        ),
      );

      let newestSettled: SettledInput | undefined;

      for (const id of ids) {
        const record = yield* attempt("follow", async () => {
          const submission = await harness.harness.submission(id, context);

          return submission === undefined ? undefined : submission.status(context);
        });

        if (record?.type !== "input") continue;

        if (record.status === "done") {
          const answer = yield* attempt("follow", () =>
            conversation.commit((tx) => tx.entry(AssistantEntry, record.answer), context),
          );

          const message = answer?.model?.[0];

          newestSettled = {
            id,
            status: "done",
            answer: message?.role === "assistant" ? contentText(message.content, "") : undefined,
          };

          break;
        }

        if (record.status === "unanswered") {
          newestSettled = {
            id,
            status: "unanswered",
            reason: record.reason,
            detail: record.detail,
          };

          break;
        }
      }

      // What the conversation runs with, when the Harness can tell: a status without it still says the rest.
      const agent = yield* Effect.option(attempt("follow", () => conversation.agent(context)));
      const read = { newestEntry: newest.items[0]?.id ?? 0, newestSettled };

      // A message still in the conversation's line is unsettled input too: Stop withdraws it.
      const unsettled =
        admission.isPreparing(conversation.id) ||
        Arr.some(
          submissions,
          (record) => record.type === "input" && record.conversationId === conversation.id,
        );

      const followed: Types.Mutable<FollowState> = {
        conversationId: conversation.id,
        activeBranch: current.id,
        copying,
        idle: working(tasks).length === 0 && submissions.length === 0 && !admission.anyPreparing(),
        // The addressed conversation's own and its subagents': what Stop all of it reaches (a branch that is not active is
        // Archive's and Delete's).
        following: Arr.some(
          tasks,
          (task) =>
            isFollower(task) &&
            (task.record.conversationId === conversation.id ||
              String(task.record.conversationId) in (state?.conversations ?? {})),
        ),
        unsettled,
        newestEntry: read.newestEntry,
        agents: state?.conversations ?? {},
      };

      if (Option.isSome(agent)) {
        const { model, thinkingLevel } = agent.value;

        if (model !== undefined) followed.model = `${model.provider}/${model.modelId}`;

        if (thinkingLevel !== undefined) followed.thinking = thinkingLevel;
      }

      return read.newestSettled === undefined
        ? followed
        : { ...followed, newestSettled: read.newestSettled };
    });

  return {
    follow,
    entries: ({ conversationId, order, minEntryId, maxEntryId, limit }) =>
      readable(conversationId).pipe(
        Effect.flatMap((conversation) =>
          attempt("entries", async () => {
            const items: EntryRecord[] = [];
            let cursor: Cursor | undefined;
            const query: Types.Mutable<Parameters<Conversation["entries"]>[0]> = { order };

            if (minEntryId !== undefined) query.minEntryId = entryId(minEntryId);

            if (maxEntryId !== undefined) query.maxEntryId = entryId(maxEntryId);

            do {
              const page = await conversation.entries(
                query,
                Math.min(50, limit - items.length),
                cursor,
                context,
              );

              items.push(...page.items);
              cursor = page.next;
            } while (cursor !== undefined && items.length < limit);

            return items;
          }),
        ),
      ),
    admitted: (requestId) =>
      active.pipe(
        Effect.flatMap((conversation) =>
          attempt("admitted", () =>
            conversation.commit(
              (tx) => tx.submissionByRequest(conversation.id, requestId),
              context,
            ),
          ),
        ),
        Effect.map((record) =>
          record === undefined ? undefined : { id: record.id, queued: record.status === "queued" },
        ),
      ),
    note: (notice) =>
      active.pipe(
        Effect.flatMap((conversation) =>
          attempt("note", () =>
            conversation.submit(
              { type: "write", entry: { kind: MCP_NOTICE_KIND, data: { notice } } },
              context,
            ),
          ),
        ),
        Effect.asVoid,
      ),
    appContextHeld,
    appContextTarget,
    submit: (prompt) => admit(prompt).pipe(Effect.map((submission) => submission.id)),
    prompt: answer,
    alarm: wakeAndResume,
    // A follower of an MCP task is not work: a conversation that only follows tasks is idle. A message still being
    // prepared is (its request start may wait on an MCP server's discovery), as the followed state's `idle` counts it.
    idle: inspect.pipe(
      Effect.map(
        ({ tasks, submissions }) =>
          working(tasks).length === 0 && submissions.length === 0 && !admission.anyPreparing(),
      ),
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
    // What stopped reaches the Registry's summary of the subagents at once: an archived Session keeps it, and the MCP
    // tasks it cancelled are no longer followed.
    stopEverything: branches.stopEverything.pipe(
      Effect.andThen(settleAgents),
      Effect.andThen(settle),
      Effect.asVoid,
    ),
    forkSource: forks.forkSource,
    exportEntries: forks.exportEntries,
    importStart: forks.importStart,
    importEntries: forks.importEntries,
    importFinish: forks.importFinish,
    importBegin: forks.importBegin,
    importTranslated: forks.importTranslated,
    importWritten: forks.importWritten,
    importTools: root.pipe(
      Effect.flatMap((conversation) => attempt("agent", () => conversation.agent(context))),
      Effect.map((agent): ReadonlyArray<string> | undefined =>
        Arr.map(agent.tools, (tool) => tool.name),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Reading the tools of an import's Session failed", error).pipe(
          Effect.as(undefined),
        ),
      ),
    ),
    nameSession: titles.run,
    contextUsage: readContextUsage,
    // The settings are read again first, as `configure` does: the default is the one in force now. A read that fails
    // leaves the last one.
    importDefaults: refreshSettings.pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.sync(() => {
          const { agent } = settings.current();

          return {
            catalog: models,
            agent: { model: agent.model, thinkingLevel: agent.thinkingLevel },
          } satisfies ImportDefaults;
        }),
      ),
    ),
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
    showHeldStops,
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
              beforeAbort,
            ),
          ),
        ),
      ),
    deleteSubagent: (agent, workspace) =>
      attempt("deleteSubagent", () =>
        deleteAgent(
          harness.harness,
          agent,
          workspace,
          options.subagentWorkspaces,
          context,
          beforeAbort,
        ),
      ),
    close: Effect.sync(() => agentsReport.stop()).pipe(
      Effect.andThen(attempt("close", () => harness.harness.close(context))),
    ),
    workspaceOf: subagentWorkspaceOf,
    workspaces,
    taskGraph: taskGraphSummaries,
    usage: usageUpdates,
    conversationView,
    todos,
    mcpTasks: options.mcp === undefined ? Stream.empty : mcpTasks,
    mcpTaskList: options.mcp === undefined ? Effect.succeed([]) : mcpTaskList,
    mcpTaskCancel: (task) =>
      options.mcp?.cancelTask?.(harness.harness, task) ?? Effect.succeed("unknown" as const),
    mcpTaskKeep: (task) =>
      options.mcp?.keepContainer?.(harness.harness, task) ?? Effect.succeed("unknown" as const),
    catalog: (conversationId) => addressed(conversationId).pipe(Effect.flatMap(catalogFor)),
    command: runCommand,
    directory: (conversationId) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) => environment(conversation, { lookup: true })),
        Effect.map((env) => env?.cwd),
      ),
    files: ({ query, conversationId }) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) => filesFor(conversation, query)),
      ),
    resourceMenu: (conversationId) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) => resourceMenuFor(conversation)),
      ),
    mcpComplete: ({ conversationId, ...request }) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) => completeFor(conversation, request)),
      ),
    spill: (conversationId, path, hold) =>
      !isMcpSpillPath(path)
        ? Effect.succeed<SpillRead>({ kind: "missing" })
        : addressed(conversationId).pipe(
            Effect.flatMap((conversation) =>
              environment(conversation, { lookup: true }).pipe(withinExpandTimeout),
            ),
            Effect.flatMap((env) =>
              env === undefined
                ? Effect.succeed<SpillRead>({ kind: "missing" })
                : spillOf(env, path, hold, withinExpandTimeout),
            ),
            // The Workspace that cannot answer in time has no file to show: the card reads the resource instead.
            Effect.catchTag("TimeoutError", () => Effect.succeed<SpillRead>({ kind: "missing" })),
          ),
    workspaceFile: (conversationId, path) =>
      !isWorkspaceFilePath(path)
        ? Effect.succeed<WorkspaceFileRead>({ kind: "missing" })
        : addressed(conversationId).pipe(
            Effect.flatMap((conversation) =>
              environment(conversation, { lookup: true }).pipe(withinExpandTimeout),
            ),
            Effect.flatMap((env) =>
              env === undefined
                ? Effect.succeed<WorkspaceFileRead>({ kind: "missing" })
                : // One file of at most 2 MiB at the owner's click: no decode slot to wait for, so a read is
                  // never `waited` or `aborted`.
                  spillOf(
                    env,
                    path,
                    () => Effect.succeed("held"),
                    withinExpandTimeout,
                    MAX_VISUAL_BYTES,
                  ).pipe(
                    Effect.map((read: SpillRead): WorkspaceFileRead =>
                      read.kind === "base64" || read.kind === "too_large"
                        ? read
                        : { kind: "missing" },
                    ),
                  ),
            ),
            Effect.catchTag("TimeoutError", () =>
              Effect.succeed<WorkspaceFileRead>({ kind: "missing" }),
            ),
          ),
    entryPage: ({ query, limit, conversationId }) =>
      addressed(conversationId).pipe(
        Effect.flatMap((conversation) =>
          attempt("entries", () => conversation.entries(query, limit, undefined, context)),
        ),
        // pi reads `descending` when a query names no order.
        Effect.map((page) => entriesPage(page, query.order ?? "descending")),
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
