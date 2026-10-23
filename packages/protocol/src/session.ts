// The Session socket: one WebSocket per client to one Session DO (`docs/spec.md` → Client and protocol, ADR-0009).
// The shapes follow the socket protocol of Cloudflare's `agents` pi example (`examples/next/harnesses/pi`, MIT), in
// Effect `Schema`: commands carry an optional `id` that a `result` or `error` answers, and every watched conversation
// streams `events` batches whose first batch is a `snapshot`.
import { InstanceType, ModelId, ThinkingLevel } from "@cloudpid/config";
import type {
  AgentEvent,
  ConversationId as PiConversationId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The text the client sends to keep the socket alive, and the server's answer. The object answers it without waking,
 * so a client's heartbeat does not keep a hibernated Session in memory.
 */
export const HEARTBEAT = { request: "ping", response: "pong" } as const;

/**
 * The close code a Session's socket ends with when the owner deleted the Session: the client stops reconnecting and
 * leaves the Session's page.
 */
export const SESSION_DELETED_CLOSE_CODE = 4404;

/**
 * What input submitted while the conversation is busy does. `steer` joins the running Run at its next boundary, after
 * the tool calls in progress; one that finds the Run producing its final answer starts the next Run instead.
 * `followUp`, pi-durable's default, waits for the next Run; `reject` fails the command.
 */
export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);

export type WhenBusy = typeof WhenBusy.Type;

const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

/** User input, as pi takes it: text, or text and image blocks. */
export const UserInput = Schema.Union([
  Schema.String,
  Schema.Union([TextContent, ImageContent]).pipe(Schema.Array, Schema.mutable),
]);

export type UserInput = typeof UserInput.Type;

/** A conversation's ID within its Session: pi-durable's positive integer. */
export const ConversationId = Schema.declare(
  (input): input is PiConversationId =>
    Predicate.isNumber(input) && Number.isSafeInteger(input) && input > 0,
  { identifier: "ConversationId" },
);

export type ConversationId = typeof ConversationId.Type;

/** A command's correlation ID: an answered command gets a `result` or an `error` with it. */
const CommandId = Schema.optionalKey(Schema.String);

/**
 * Submit `input` to the Session's root conversation, or to the conversation of one of its subagents when
 * `conversationId` names it (a conversation that is neither fails the command). Input to a subagent is the owner
 * talking to it directly: the agent sees it as a user message, and its answer is not reported to the agent that started
 * it. Submitting the same `requestId` again finds the first submission, so a client may resend a submit it saw no
 * result for. Answered with `{ submissionId }`.
 */
export const Submit = Schema.Struct({
  type: Schema.Literal("submit"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  input: UserInput,
  whenBusy: Schema.optionalKey(WhenBusy),
  requestId: Schema.optionalKey(Schema.String),
});

/**
 * Abort the work of the root conversation, or of the subagent conversation `conversationId` names, and withdraw its
 * queued input. Its subagents are agents of their own and keep working, unless `subagents` is true: then every subagent
 * below it is stopped too, and the results they held for it are dropped. Answered with `null` once it is idle.
 */
export const Abort = Schema.Struct({
  type: Schema.Literal("abort"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  subagents: Schema.optionalKey(Schema.Boolean),
});

/**
 * Stream conversation `conversationId`'s events on this socket: a `snapshot`, then pi's `AgentEvent` batches. Watching
 * a conversation already watched restarts it with a fresh snapshot. The watch outlives hibernation: a woken Session
 * restarts it, with a fresh snapshot. Answered with `null`.
 */
export const Watch = Schema.Struct({
  type: Schema.Literal("watch"),
  id: CommandId,
  conversationId: ConversationId,
});

/** Stop streaming conversation `conversationId`. Answered with `null`. */
export const Unwatch = Schema.Struct({
  type: Schema.Literal("unwatch"),
  id: CommandId,
  conversationId: ConversationId,
});

/**
 * Pick the model and thinking level the root conversation runs with, from its next request on. A field left out stays
 * as it is; `null` clears it, so the Session follows the default in the settings again (and a changed default applies
 * to its next request). A Session that was never configured follows the default. Answered with `null`; the new
 * choice reaches clients as an `agent_changed` event.
 */
export const Configure = Schema.Struct({
  type: Schema.Literal("configure"),
  id: CommandId,
  model: ModelId.pipe(Schema.NullOr, Schema.optionalKey),
  thinkingLevel: ThinkingLevel.pipe(Schema.NullOr, Schema.optionalKey),
});

/**
 * The owner's answer to Secret request `request` (`secret_requests`), entered in a masked form: a value per name, where
 * a missing or empty one skips that name, or `null` when the owner cancelled. Answered with `null`; fails when no such
 * request waits or a name was not requested.
 */
export const SecretAnswer = Schema.Struct({
  type: Schema.Literal("secret_answer"),
  id: CommandId,
  request: Schema.String,
  values: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Stream a compact summary of the Session's task graph on this socket (`task_graph`): its subagents and the background
 * work live now. The first message follows at once, and the watch outlives hibernation like a conversation's. Answered
 * with `null`.
 */
export const WatchTaskGraph = Schema.Struct({
  type: Schema.Literal("watch_task_graph"),
  id: CommandId,
});

/** Stop streaming the task graph on this socket. Answered with `null`. */
export const UnwatchTaskGraph = Schema.Struct({
  type: Schema.Literal("unwatch_task_graph"),
  id: CommandId,
});

/**
 * Stream the Session's token and cost totals on this socket (`usage`). The first message follows at once, and the watch
 * outlives hibernation like a conversation's. Answered with `null`.
 */
export const WatchUsage = Schema.Struct({
  type: Schema.Literal("watch_usage"),
  id: CommandId,
});

/** Stop streaming the Session's usage on this socket. Answered with `null`. */
export const UnwatchUsage = Schema.Struct({
  type: Schema.Literal("unwatch_usage"),
  id: CommandId,
});

/**
 * Ask what the composer completes in the root conversation, or in the subagent conversation `conversationId` names: the
 * Session's Slash commands, and the Prompt templates and Skills of the conversation's directory. Answered with a
 * `Catalog`.
 */
export const CatalogRequest = Schema.Struct({
  type: Schema.Literal("catalog"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
});

/** The most paths a `files` request is answered with. */
export const MAX_FILE_MATCHES = 50;

/** The longest `query` a `files` request may carry, in UTF-16 code units: longer than any path worth typing. */
export const MAX_FILE_QUERY_LENGTH = 1024;

/**
 * Ask which files and folders of the root conversation's directory, or of the directory of the subagent conversation
 * `conversationId` names, match `query` (what follows an `@` in the composer, `""` for all): the composer's `@` menu.
 * Answered with `FileMatches`.
 */
export const FilesRequest = Schema.Struct({
  type: Schema.Literal("files"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  query: Schema.String.check(Schema.isMaxLength(MAX_FILE_QUERY_LENGTH)),
});

/**
 * Run the Session's Slash command `name` (without its `/`) with `args` (trimmed, `""` when none) on the root
 * conversation, or on the subagent conversation `conversationId` names. Answered with a `CommandOutcome`; a command that
 * cannot run fails with why.
 */
export const RunCommand = Schema.Struct({
  type: Schema.Literal("command"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  name: Schema.String,
  args: Schema.String,
});

/**
 * Ask for the History of the root conversation, or of the subagent conversation `conversationId` names, before entry
 * `before`: what its snapshot no longer holds once a Rollover or a compaction started a new Context Window. Answered with
 * a `HistoryPage`.
 */
export const HistoryRequest = Schema.Struct({
  type: Schema.Literal("history"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  before: Schema.Int.check(Schema.isGreaterThan(0)),
});

/**
 * Ask for the Session tree (GLOSSARY.md → Session tree): every Session branch's owner's messages, answers, tool results
 * and notices, with the active branch. Answered with a `SessionTree`.
 */
export const TreeRequest = Schema.Struct({
  type: Schema.Literal("tree"),
  id: CommandId,
});

/** The longest custom focus a branch summary takes, as a Rollover's. */
export const MAX_BRANCH_SUMMARY_FOCUS = 2_000;

/**
 * What to carry from the branch being left: nothing (absent), or a summary of it, with the owner's extra focus. The
 * summary is a model call on the Session's Usage, placed at the start of the branch entered.
 */
export const BranchSummaryRequest = Schema.Struct({
  instructions: Schema.String.check(Schema.isMaxLength(MAX_BRANCH_SUMMARY_FOCUS)).pipe(
    Schema.optionalKey,
  ),
});

export type BranchSummaryRequest = typeof BranchSummaryRequest.Type;

/**
 * Move the active branch to a point of the Session tree (`/tree`): just `before` an owner's message, whose text the
 * client puts back in the composer, or just after (`at`) an entry such as an answer. The point's Session branch is made
 * when needed (an existing branch's tip is only made active), and `summary` asks for a summary of the branch left.
 * Refused while the active branch's Run, compaction or Rollover is under way. Answered with a `Navigated`.
 */
export const Navigate = Schema.Struct({
  type: Schema.Literal("navigate"),
  id: CommandId,
  entryId: Schema.Int.check(Schema.isGreaterThan(0)),
  position: Schema.Literals(["before", "at"]),
  summary: Schema.optionalKey(BranchSummaryRequest),
});

/** Make Session branch `conversationId` the active branch as it stands, with no summary (the chevrons). Answered with `null`. */
export const SwitchBranch = Schema.Struct({
  type: Schema.Literal("switch_branch"),
  id: CommandId,
  conversationId: ConversationId,
});

/** Client → server. */
export const ClientMessage = Schema.Union([
  TreeRequest,
  Navigate,
  SwitchBranch,
  Submit,
  Abort,
  CatalogRequest,
  FilesRequest,
  RunCommand,
  HistoryRequest,
  Watch,
  Unwatch,
  Configure,
  SecretAnswer,
  WatchTaskGraph,
  UnwatchTaskGraph,
  WatchUsage,
  UnwatchUsage,
]);

export type ClientMessage = typeof ClientMessage.Type;

/**
 * Sent once on connect: the Session's active branch (GLOSSARY.md → Session branch), to `watch` and to submit to without
 * a `conversationId`; `copying` while the Session is still being filled from the one it is a Fork or Clone of.
 */
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  root: ConversationId,
  copying: Schema.optionalKey(Schema.Boolean),
});

/**
 * The active branch changed, or a Session branch was made: sent to every client, which watches `conversationId` in
 * place of the one it watched, and asks for the tree again when it shows it.
 */
export const ActiveBranch = Schema.Struct({
  type: Schema.Literal("active_branch"),
  conversationId: ConversationId,
});

/** What a node of the Session tree is: an owner's message, another input (a subagent's report, a Rollover request), an answer, a tool result, or a notice (a summary, a Handoff). */
export const TreeNodeRole = Schema.Literals(["user", "input", "assistant", "tool", "notice"]);

export type TreeNodeRole = typeof TreeNodeRole.Type;

/** One entry of the Session tree a client shows, with the nearest such entry before it as its parent. */
export const TreeNode = Schema.Struct({
  /** Its pi entry ID, as the transcript's message IDs are. */
  id: Schema.Int,
  parent: Schema.NullOr(Schema.Int),
  /** The Session branch whose own entry it is. */
  conversationId: ConversationId,
  role: TreeNodeRole,
  /** The start of its text, on one line; a notice's title. */
  text: Schema.String,
  /** An answer that ends its Run (no tool calls). */
  final: Schema.Boolean,
  timestamp: Schema.Finite,
});

export type TreeNode = typeof TreeNode.Type;

/** A Session branch, and when it was last the active branch. */
export const TreeBranch = Schema.Struct({
  conversationId: ConversationId,
  lastActiveAt: Schema.Finite,
});

export type TreeBranch = typeof TreeBranch.Type;

/**
 * The answer to `tree`: its nodes, parents before children and siblings oldest first; the active branch, and its last
 * node (`leaf`: null when it has none, as before the Session's first message).
 */
export const SessionTree = Schema.Struct({
  nodes: Schema.Array(TreeNode),
  active: ConversationId,
  leaf: Schema.NullOr(Schema.Int),
  branches: Schema.Array(TreeBranch),
});

export type SessionTree = typeof SessionTree.Type;

/** The answer to `navigate`: the active branch now, and the owner's message to put back in the composer, if any. */
export const Navigated = Schema.Struct({
  conversationId: ConversationId,
  text: Schema.NullOr(Schema.String),
});

export type Navigated = typeof Navigated.Type;

/**
 * Which of the root conversation's model and thinking level the Session picked itself with `configure`: the rest
 * follows the default in the settings. Sent after `hello`, and to every connected client whenever a `configure`
 * changes it, since `agent_changed` carries the resolved agent but not where it came from.
 */
export const Picked = Schema.Struct({
  type: Schema.Literal("picked"),
  model: Schema.Boolean,
  thinkingLevel: Schema.Boolean,
});

/** A call's request for the owner to enter Secrets; never carries a value. */
export const SecretRequest = Schema.Struct({
  /** What the answer names. */
  id: Schema.String,
  /** The conversation whose call asks. */
  conversationId: ConversationId,
  /** The Secret Names to enter, one masked field each. */
  names: Schema.Array(Schema.String),
  /** Why the agent needs them. */
  reason: Schema.optionalKey(Schema.String),
});

export type SecretRequest = typeof SecretRequest.Type;

/**
 * The Secret requests waiting for the owner, oldest first. A client shows a masked form for them, never the chat, and
 * answers each with `secret_answer`. Sent after `hello` while any waits, and to every client whenever they change (an
 * empty list once none waits). A request outlives reconnects and evictions until it is answered or its call ends.
 */
export const SecretRequests = Schema.Struct({
  type: Schema.Literal("secret_requests"),
  requests: Schema.Array(SecretRequest),
  /** How long an entered Secret is held. */
  lifetimeMinutes: Schema.Finite,
});

/**
 * A Browser Handoff waiting for the owner (`docs/spec.md` → Browser): the agent gave the owner live control of its browser
 * for a step it cannot do. `url` is the Live View link, a bearer credential for the owner alone: a client shows it as a
 * link for the owner to open and never to the agent or the chat.
 */
export const BrowserHandoffRequest = Schema.Struct({
  /** The asking call's task, unique within the Session. */
  id: Schema.String,
  /** The conversation whose tab is handed over. */
  conversationId: ConversationId,
  /** What the agent needs done. */
  instructions: Schema.String,
  /** The Live View link, to open in a browser. */
  url: Schema.String,
  /** When the handoff times out, in milliseconds since the epoch. */
  deadline: Schema.Finite,
});

export type BrowserHandoffRequest = typeof BrowserHandoffRequest.Type;

/**
 * The Browser Handoffs waiting for the owner, oldest first. A client shows each with its instructions and a link to open,
 * outside the chat. Sent after `hello` while any waits, and to every client whenever they change (an empty list once none
 * waits). The owner finishes in the Live View itself, so there is no answer command; a request ends when the owner is
 * done, the handoff times out, or the run is stopped, and it outlives reconnects and evictions until then.
 */
export const BrowserHandoffRequests = Schema.Struct({
  type: Schema.Literal("browser_handoff_requests"),
  requests: Schema.Array(BrowserHandoffRequest),
});

/** A subagent as the task graph shows it. */
export const GraphAgent = Schema.Struct({
  /** Its canonical ID, such as `agent-1` or `agent-1.reviewer`. */
  id: Schema.String,
  /** The agent that started it: `root` or another subagent's ID. */
  parent: Schema.String,
  /** The conversation to `watch`, and to `submit` and `abort` to. */
  conversationId: ConversationId,
  /** The model role it was started with, if any. */
  role: Schema.NullOr(Schema.String),
  /** `provider/modelId`. */
  model: Schema.String,
  /** `working` while its conversation has live work, otherwise `idle`: it keeps its history and can take more input. */
  status: Schema.Literals(["working", "idle"]),
});

export type GraphAgent = typeof GraphAgent.Type;

/** A live background task as the task graph shows it. */
export const GraphBackgroundTask = Schema.Struct({
  id: Schema.Finite,
  /** The task's kind, such as `pi.compaction`. */
  kind: Schema.String,
  /** The agent whose conversation it belongs to: `root` or a subagent's ID. */
  agent: Schema.String,
  conversationId: ConversationId,
  state: Schema.Literals(["pending", "running", "waiting", "completing"]),
  /** Whether an abort was asked of it and is not finished. */
  aborting: Schema.Boolean,
});

export type GraphBackgroundTask = typeof GraphBackgroundTask.Type;

/**
 * The Session's live work, summarised from pi-durable's task graph and the Subagents document: every subagent (a
 * deleted one is gone), parents before their children, and the live background tasks other than the subagents'
 * own bookkeeping. Each message replaces the last. The server sends one at most every few hundred milliseconds, and keeps
 * the lists short.
 */
export const TaskGraphSummary = Schema.Struct({
  agents: Schema.Array(GraphAgent),
  background: Schema.Array(GraphBackgroundTask),
});

export type TaskGraphSummary = typeof TaskGraphSummary.Type;

/** The Session's task graph, sent to a client that watches it (`watch_task_graph`) whenever it changes. */
export const TaskGraphMessage = Schema.Struct({
  type: Schema.Literal("task_graph"),
  ...TaskGraphSummary.fields,
});

/** What a Container of one size costs per second, in US dollars (`containerRates` of `@cloudpid/config`). */
export const ContainerRates = Schema.Struct({
  memory: Schema.Finite,
  disk: Schema.Finite,
  /** Per busy second: every vCPU at full use. */
  cpu: Schema.Finite,
});

/**
 * What the Session's Workspace's Containers have cost (`docs/spec.md` → Operations → Usage), at Cloudflare's list prices:
 * Cloudflare's usage analytics up to `reportedThrough`, and after it (or throughout, where the deployment has no analytics
 * token) an estimate: memory and disk for every second a Container ran, CPU as every vCPU at full use while commands
 * ran on it. It is the Workspace's, so Sessions that share a Workspace each show all of it. The amounts are as of
 * `asOf`; while a Container runs, a client adds `rates` for the time since, up to `until`.
 */
export const ContainerUsage = Schema.Struct({
  /** The size of the Container that runs, else of the last one. */
  instance: InstanceType,
  /** Seconds the Workspace's Containers have run, every launch summed, as the Workspace counted them. */
  runSeconds: Schema.Finite,
  /** CPU seconds used: reported, then estimated. */
  cpuSeconds: Schema.Finite,
  /** Bytes sent out, as reported (none is estimated). */
  egressBytes: Schema.Finite,
  /** US dollars of memory, disk, CPU and egress. */
  memory: Schema.Finite,
  disk: Schema.Finite,
  cpu: Schema.Finite,
  egress: Schema.Finite,
  /** Epoch milliseconds Cloudflare's analytics cover the usage to; null when they cover none of it. */
  reportedThrough: Schema.NullOr(Schema.Finite),
  /** Epoch milliseconds the figures were read at. */
  asOf: Schema.Finite,
  /** Whether a Container ran at `asOf`. */
  running: Schema.Boolean,
  /** Whether a command ran on it at `asOf`, so its CPU grows too. */
  busy: Schema.Boolean,
  /** The running Container's rates; zero when none runs. */
  rates: ContainerRates,
  /**
   * The latest the running Container goes on without another use (its idle stop), epoch milliseconds; null while a
   * command runs, or when it is not known.
   */
  until: Schema.NullOr(Schema.Finite),
});

export type ContainerUsage = typeof ContainerUsage.Type;

/**
 * What the Session has spent on model requests (`docs/spec.md` → Telemetry), as pi-durable's `pi.usage` counts it:
 * every conversation of the Session, subagents' included, and the title call, which has no conversation. Token counts
 * are as the provider reported them; `cost` is in US dollars, as the model catalog prices the tokens. `container` is
 * what its Workspace's Containers have cost, absent when no Container has run or it could not be read; it is not part of
 * `cost`, and the spend limit holds `cost` only.
 */
export const SessionUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cost: Schema.Finite,
  /** The Session's spend limit in US dollars, or null when it has none. A Session at it stops before its next request. */
  limit: Schema.NullOr(Schema.Finite),
  container: Schema.optionalKey(ContainerUsage),
});

export type SessionUsage = typeof SessionUsage.Type;

/** The Session's usage, sent to a client that watches it (`watch_usage`) whenever it changes; each replaces the last. */
export const UsageMessage = Schema.Struct({
  type: Schema.Literal("usage"),
  ...SessionUsage.fields,
});

/** A Task of a conversation's Todo List: flat, in the order of its ID. */
export const TodoTask = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "active", "completed"]),
});

export type TodoTask = typeof TodoTask.Type;

/**
 * A watched conversation's Todo List, whole. The Session sends one after the snapshot of each conversation a client
 * `watch`es, the root's and a subagent's alike, and another each time the list changes; each replaces the last one of
 * that conversation. A conversation that never used the tool has an empty list.
 */
export const TodosMessage = Schema.Struct({
  type: Schema.Literal("todos"),
  conversationId: ConversationId,
  tasks: Schema.Array(TodoTask),
});

/** One of pi's agent events, passed through unchanged; only its `type` is checked. */
export const AgentEventSchema = Schema.declare(
  (input): input is AgentEvent =>
    Predicate.isObject(input) &&
    Predicate.hasProperty(input, "type") &&
    Predicate.isString(input.type),
  { identifier: "AgentEvent" },
);

/**
 * A batch of a watched conversation's events, one per commit. The first batch of a watch, and the first after the
 * Session restarted it, is a lone `snapshot` that replaces the client's state.
 */
export const Events = Schema.Struct({
  type: Schema.Literal("events"),
  conversationId: ConversationId,
  events: Schema.Array(AgentEventSchema),
});

/** A value a Slash command's argument can take. */
export const CommandChoice = Schema.Struct({
  value: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

/** A Slash command the Session runs (`command`). */
export const CatalogCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Shown after the name: `[focus]`, `clear`. */
  argumentHint: Schema.optionalKey(Schema.String),
  argument: Schema.Literals(["none", "optional", "required"]),
  /** The values its argument can take, when it takes only these. */
  choices: CommandChoice.pipe(Schema.Array, Schema.optionalKey),
});

export type CatalogCommand = typeof CatalogCommand.Type;

/**
 * The Slash commands the Session runs, on the conversation they are typed in (docs/spec.md → Client and protocol → Slash
 * commands). Known to the client too, so a command typed before the catalog arrives, or after it could not be had, runs
 * as one instead of reaching the model.
 */
export const SESSION_COMMANDS: ReadonlyArray<CatalogCommand> = [
  {
    name: "compact",
    description: "Summarize the context to free room; after the run, if one is in progress",
    argumentHint: "[focus]",
    argument: "optional",
  },
  {
    name: "rollover",
    description: "Ask the agent to write its Handoff and start a fresh context",
    argumentHint: "[focus]",
    argument: "optional",
  },
  {
    name: "todo",
    description: "Clear the Todo List",
    argumentHint: "clear",
    argument: "required",
    choices: [{ value: "clear", description: "Remove every Task" }],
  },
  {
    name: "export",
    description: "Download the whole History as Markdown",
    argument: "none",
  },
];

/**
 * The Session's Slash commands in a conversation whose agent can (`rollover`) or cannot roll over: `/rollover` needs the
 * `context_rollover` tool, which a subagent is never granted.
 */
export const sessionCommandsFor = (rollover: boolean): ReadonlyArray<CatalogCommand> =>
  rollover ? SESSION_COMMANDS : Arr.filter(SESSION_COMMANDS, ({ name }) => name !== "rollover");

/** A Prompt template or a Skill the composer offers: `/name` or `/skill:name` and `$name`. */
export const CatalogEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optionalKey(Schema.String),
});

export type CatalogEntry = typeof CatalogEntry.Type;

/**
 * The answer to `catalog`. Templates and Skills are those of the conversation's directory and the directories above it
 * up to the Workspace root, nearest first; Skills include the ones the model is not offered
 * (`disable-model-invocation`), which exist for the owner to name.
 */
export const Catalog = Schema.Struct({
  commands: Schema.Array(CatalogCommand),
  templates: Schema.Array(CatalogEntry),
  skills: Schema.Array(CatalogEntry),
});

export type Catalog = typeof Catalog.Type;

/**
 * The answer to `files`: at most `MAX_FILE_MATCHES` paths relative to the conversation's directory, best match first, as
 * `rank` orders them (shallower paths first among equals). A folder's path ends in `/`. What git ignores there, `.git`
 * and `node_modules` are not listed.
 */
export const FileMatches = Schema.Struct({ paths: Schema.Array(Schema.String) });

export type FileMatches = typeof FileMatches.Type;

/** A file a Slash command hands the owner, such as `/export`'s transcript, for the client to download. */
export const CommandFile = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  content: Schema.String,
});

/** The answer to `command`: what it did, to show the owner, and a file to download, if any. */
export const CommandOutcome = Schema.Struct({
  notice: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(CommandFile),
});

export type CommandOutcome = typeof CommandOutcome.Type;

/** One of pi's transcript entries, passed through unchanged; only its `id` is checked. */
export const EntryRecordSchema = Schema.declare(
  (input): input is EntryRecord =>
    Predicate.isObject(input) &&
    Predicate.hasProperty(input, "id") &&
    Predicate.isNumber(input.id) &&
    Predicate.hasProperty(input, "kind") &&
    Predicate.isString(input.kind),
  { identifier: "EntryRecord" },
);

/**
 * The answer to `history`: the conversation's entries just before the ones asked for, oldest first, at most
 * `MAX_HISTORY_ENTRIES` and about `MAX_HISTORY_BYTES` of them (always one, however large), without the entries a
 * transcript does not show (system prompts, bookkeeping). `before` is what to ask for next, or null when nothing is left.
 */
export const HistoryPage = Schema.Struct({
  entries: Schema.Array(EntryRecordSchema),
  before: Schema.NullOr(Schema.Int),
});

export type HistoryPage = typeof HistoryPage.Type;

/** The most entries a `history` page reads. */
export const MAX_HISTORY_ENTRIES = 200;

/**
 * About the most a `history` page holds, in UTF-16 code units of its entries' JSON: well under the 32 MiB a socket message
 * may be, and small enough for the Session to build beside its other work.
 */
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/** A command's answer: JSON, or a `HistoryPage`, whose pi entries are JSON that TypeScript cannot tell is. */
export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  id: Schema.String,
  result: Schema.Union([Schema.Json, HistoryPage]),
});

/**
 * Something failed. With `id`, the command with that `id` failed, or could not be read. With `conversationId`, the
 * watch of that conversation ended and is dropped: watch it again to resume. With neither, a message without a
 * readable `id` could not be read.
 */
export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  id: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(ConversationId),
  message: Schema.String,
});

/** Server → client. */
export const ServerMessage = Schema.Union([
  Hello,
  ActiveBranch,
  Picked,
  Events,
  Result,
  ErrorMessage,
  SecretRequests,
  BrowserHandoffRequests,
  TaskGraphMessage,
  UsageMessage,
  TodosMessage,
]);

export type ServerMessage = typeof ServerMessage.Type;

/** Client messages as the socket carries them: JSON text. */
export const ClientMessageJson = Schema.fromJsonString(ClientMessage);

/**
 * Read a client message, as the Session does: keys a message does not define are an error, so a misspelt option
 * (`whenbusy`) fails the command instead of being ignored.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a Schema decoder, as `Schema.decodeUnknownEffect` makes.
export const decodeClientMessage = Schema.decodeUnknownEffect(ClientMessageJson, {
  onExcessProperty: "error",
});

/** Server messages as the socket carries them: JSON text. */
export const ServerMessageJson = Schema.fromJsonString(ServerMessage);
