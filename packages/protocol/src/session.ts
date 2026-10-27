// The Session socket: one WebSocket per client to one Session DO (`docs/spec.md` → Client and protocol, ADR-0009).
// The shapes follow the socket protocol of Cloudflare's `agents` pi example (`examples/next/harnesses/pi`, MIT), in
// Effect `Schema`: commands carry an optional `id` that a `result` or `error` answers, and every watched conversation
// streams `events` batches whose first batch is a `snapshot`.
import { InstanceType, ModelId, ThinkingLevel } from "@cloudpid/config";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Annotation, AnnotationDraft, MAX_ANNOTATION_ID, MAX_ANNOTATIONS } from "./annotations.ts";
import { WorkspaceChanges } from "./changes.ts";
import { ComparisonSourceKind, MAX_VIEWED, ViewedFile } from "./comparison.ts";
import { PageRef } from "./attached-pages.ts";
import { ConversationId } from "./conversation-id.ts";
import { SecretKeep } from "./environment-secrets.ts";
import { LastRunMessage } from "./last-run.ts";

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

export { ConversationId } from "./conversation-id.ts";

/** A command's correlation ID: an answered command gets a `result` or an `error` with it. */
const CommandId = Schema.optionalKey(Schema.String);

/**
 * Submit `input` to the Session's root conversation, or to the conversation of one of its subagents when
 * `conversationId` names it (a conversation that is neither fails the command). Input to a subagent is the owner
 * talking to it directly: the agent sees it as a user message, and its answer is not reported to the agent that started
 * it. Submitting the same `requestId` again finds the first submission, so a client may resend a submit it saw no
 * result for. `pages` attaches Owner tabs to the message (GLOSSARY.md → Attached page): the Session reads each one's URL,
 * title and selected text from the browser and gives them to the model as a block of page content, apart from the
 * owner's words; a tab that is gone fails the command. The screen of a shown tab travels as an image of `input`, after
 * the typed text and the Attachments' paths and before the Attachments' images, in the order of `pages`. Answered with
 * `{ submissionId }`.
 *
 * With `annotations`, the IDs of drafts addressed to that conversation (`annotations`), it is a Review: the input is its
 * summary (it may be empty), and the Session renders the drafts as Markdown after it. It is refused when one of them is
 * gone ("Your drafts changed: check them and send again"); the drafts are deleted once the Session takes it, and come
 * back when Stop withdraws it before it was placed.
 */
export const Submit = Schema.Struct({
  type: Schema.Literal("submit"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  input: UserInput,
  whenBusy: Schema.optionalKey(WhenBusy),
  requestId: Schema.optionalKey(Schema.String),
  pages: PageRef.pipe(Schema.Array, Schema.optionalKey),
  annotations: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(MAX_ANNOTATION_ID))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ANNOTATIONS),
    ),
  ),
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
 * a missing or empty one skips that name, or `null` when the owner cancelled. `keep` is where the owner chose to keep
 * the values (this Session only when it is left out). Answered with `null`; fails when no such request waits or a name
 * was not requested.
 */
export const SecretAnswer = Schema.Struct({
  type: Schema.Literal("secret_answer"),
  id: CommandId,
  request: Schema.String,
  values: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  keep: Schema.optionalKey(SecretKeep),
});

/** The longest reason the owner may give with an answer to an Approval request. */
export const MAX_APPROVAL_REASON = 500;

/**
 * The owner's answer to Approval request `request` (`approval_requests`): `approve` applies the change, as the request
 * shows it; a decline changes nothing, and its `reason`, if any, reaches the agent. Answered with `null`; fails when no
 * such request waits.
 */
export const ApprovalAnswer = Schema.Struct({
  type: Schema.Literal("approval_answer"),
  id: CommandId,
  request: Schema.String,
  approve: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_APPROVAL_REASON))),
});

/**
 * Save a draft Annotation (`annotations`), new or edited: the last save wins. Refused past `MAX_ANNOTATIONS` drafts.
 * Answered with `null`; every client is sent the new list.
 */
export const AnnotationSave = Schema.Struct({
  type: Schema.Literal("annotation_save"),
  id: CommandId,
  annotation: AnnotationDraft,
});

/** Delete draft `annotationId`; one that is gone is not an error. Answered with `null`; every client is sent the list. */
export const AnnotationDelete = Schema.Struct({
  type: Schema.Literal("annotation_delete"),
  id: CommandId,
  annotationId: Schema.String.check(Schema.isMaxLength(MAX_ANNOTATION_ID)),
});

/**
 * Tick (`blob`: the file's head blob id as the Comparison lists it) or untick (`blob: null`) the Viewed box of file `path`
 * of pull request `pull` in `repo` (`docs/spec.md` → Diffs and review → Comparisons). The last set wins. Refused past
 * `MAX_VIEWED` boxes. Answered with `null`; every client is sent the list (`viewed`).
 */
export const ViewedSet = Schema.Struct({
  type: Schema.Literal("viewed_set"),
  id: CommandId,
  repo: ViewedFile.fields.repo,
  pull: ViewedFile.fields.pull,
  path: ViewedFile.fields.path,
  blob: Schema.NullOr(ViewedFile.fields.blob),
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
 * Stream the Changes of the Session's Workspace on this socket (`changes`), or, when `conversationId` names a subagent's
 * conversation, of that conversation's Workspace (its Subagent Workspace, else its nearest ancestor's, else the
 * Session's; ADR-0024): the last list follows at once when the Session has one, and the Session lists them again, once
 * for every client. A conversation's watch follows it to another Workspace (a Subagent Workspace given to its agent
 * later), and ends, with an `error` marked `changes` and `ended`, once the conversation is no longer an agent's. A
 * socket may watch several, one per `conversationId` (none for the Session's). The watch outlives hibernation like a
 * conversation's. Answered with `null`; fails for a conversation that is no agent's.
 */
export const WatchChanges = Schema.Struct({
  type: Schema.Literal("watch_changes"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
});

/** Stop streaming the Changes `conversationId` names (none: the Session's) on this socket. Answered with `null`. */
export const UnwatchChanges = Schema.Struct({
  type: Schema.Literal("unwatch_changes"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
});

/**
 * List the Changes again, for every client that watches them: the page regained focus, the Diff pane opened, or the
 * owner asked (`manual`). Only a manual one may start a stopped Container, for a repo that needs it, and the `changes`
 * message says so while it does. Answered with `null` once the listing ended; its list (or the `error` saying why
 * there is none) reaches the watching clients as any other.
 */
export const RefreshChanges = Schema.Struct({
  type: Schema.Literal("refresh_changes"),
  id: CommandId,
  manual: Schema.optionalKey(Schema.Boolean),
  /** The Changes to list again, as `watch_changes` names them; none: the Session's. */
  conversationId: Schema.optionalKey(ConversationId),
});

/**
 * Ask for one changed file's two sides: `path` in `repo`, and `oldPath` for a rename, in the Workspace whose Changes
 * `conversationId` names, as `watch_changes` does (none: the Session's). Answered with a `ChangeFile`. It never starts
 * the Container: a repo whose contents need it, while it is stopped, fails with why.
 */
export const ChangeFileRequest = Schema.Struct({
  type: Schema.Literal("change_file"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  repo: Schema.String,
  path: Schema.String,
  oldPath: Schema.optionalKey(Schema.String),
});

/**
 * Ask what the Diff pane's picker lists: each repo the Session works in, its own first, with its HEAD (Changes, and
 * This branch under the branch's name). Answered with `ComparisonSources`. It never starts the Container.
 */
export const ComparisonSourcesRequest = Schema.Struct({
  type: Schema.Literal("comparison_sources"),
  id: CommandId,
  /**
   * Also list each repo's open pull requests (the picker opening). The Workspace asks GitHub's REST API with its token,
   * once per 60 s per repo, and never starts the Container.
   */
  pulls: Schema.optionalKey(Schema.Boolean),
});

/**
 * Compare `repo`'s `source` (`docs/spec.md` → Diffs and review → Comparisons). Answered with a `CompareResult`: the base
 * and head names, the merge-base and head SHAs and the file list, or why there is none (an error state, in place of the
 * list). A result for the HEAD as it is now is kept in the Workspace's storage, so asking again after the Container's
 * idle stop starts nothing. Only `startContainer` (the owner's pick or Refresh) may start a stopped Container; without
 * it a Comparison that needs the Container answers `needs_container`, or, when HEAD has moved, the last result marked
 * `behind`. `fetch` (the owner's Refresh) fetches the base again; without it a recomputed Comparison reuses the base it
 * fetched before.
 */
export const CompareRequest = Schema.Struct({
  type: Schema.Literal("compare"),
  id: CommandId,
  repo: Schema.String,
  source: ComparisonSourceKind,
  /** The pull request's number, for `source: "pull"`. A pull request's head moving is only ever shown as `behind`. */
  pull: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  startContainer: Schema.optionalKey(Schema.Boolean),
  fetch: Schema.optionalKey(Schema.Boolean),
});

/**
 * Ask for one file of a Comparison: `path` in `repo` between `mergeBase` and `head`, and `oldPath` for a rename.
 * Answered with a `ChangeFile` (`old` at the merge-base, `new` at the head). It never starts the Container: a file that
 * needs it while it is stopped fails with why.
 */
export const ComparisonFileRequest = Schema.Struct({
  type: Schema.Literal("comparison_file"),
  id: CommandId,
  repo: Schema.String,
  mergeBase: Schema.String,
  head: Schema.String,
  path: Schema.String,
  oldPath: Schema.optionalKey(Schema.String),
});

/**
 * Ask for the Run diff of the Session's Last run (`docs/spec.md` → Diffs and review → Run diff). Answered with a
 * `RunDiff`, or `null` while no Run has written. A live Run's list is made again at each ask; an ended Run's is the one
 * kept at its end. It never starts the Container.
 */
export const RunDiffRequest = Schema.Struct({
  type: Schema.Literal("run_diff"),
  id: CommandId,
});

/**
 * Ask for one file of the Last run: `path` in `repo`, and `oldPath` for a rename. Answered with a `ChangeFile` (`old` as
 * the start copy had it, `new` as the end copy has it, or the working tree while the Run is live). It never starts the
 * Container: a side that needs it while it is stopped fails with why.
 */
export const RunFileRequest = Schema.Struct({
  type: Schema.Literal("run_file"),
  id: CommandId,
  repo: Schema.String,
  path: Schema.String,
  oldPath: Schema.optionalKey(Schema.String),
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

/** Where a point of the Session tree is next to its entry: just `before` an owner's message, or just after it (`at`). */
export const TreePosition = Schema.Literals(["before", "at"]);

export type TreePosition = typeof TreePosition.Type;

/** A point of the Session tree: just before or just after one of its entries. */
export const TreePoint = Schema.Struct({
  entryId: Schema.Int.check(Schema.isGreaterThan(0)),
  position: TreePosition,
});

export type TreePoint = typeof TreePoint.Type;

/**
 * The entries from the Session tree's first to `leaf`, first first, following `parentOf`: null for an entry with no
 * parent, `undefined` for an ID the tree does not hold, which ends the path without it.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function of a leaf and its tree.
export const pathFromRoot = (
  leaf: number | null,
  parentOf: (id: number) => number | null | undefined,
): ReadonlyArray<number> => {
  const path: number[] = [];

  for (let at = leaf; at !== null;) {
    const parent = parentOf(at);

    if (parent === undefined) break;

    path.push(at);
    at = parent;
  }

  return path.reverse();
};

/**
 * Move the active branch to a point of the Session tree (`/tree`): just `before` an owner's message, whose text the
 * client puts back in the composer, or just after (`at`) an entry such as an answer. The point's Session branch is made
 * when needed (an existing branch's tip is only made active), and `summary` asks for a summary of the branch left.
 * Refused while the active branch's Run, compaction or Rollover is under way. Answered with a `Navigated`.
 */
export const Navigate = Schema.Struct({
  type: Schema.Literal("navigate"),
  id: CommandId,
  ...TreePoint.fields,
  summary: Schema.optionalKey(BranchSummaryRequest),
});

/** Make Session branch `conversationId` the active branch as it stands, with no summary (the chevrons). Answered with `null`. */
export const SwitchBranch = Schema.Struct({
  type: Schema.Literal("switch_branch"),
  id: CommandId,
  conversationId: ConversationId,
});

/**
 * Mint Live View links for the Browser Handoff `requestId` names (a `BrowserHandoffRequest`'s `id`): the owner's Live View
 * Pane opening, reconnecting, or following a window. Answered with `LiveViewLinks`, to the asking client only; fails
 * with `LIVE_VIEW_HANDOFF_OVER` ("the handoff is over") once it has ended.
 */
export const LiveViewRequest = Schema.Struct({
  type: Schema.Literal("live_view"),
  id: CommandId,
  requestId: Schema.String,
});

/**
 * Mint Live View links for the Owner tab the Browser Pane shows, and the windows it opened: the Pane opening (`open`),
 * reconnecting, or following a window. With `open`, the Session's browser is started when none runs and an Owner tab
 * opened and shown when the owner has none; without it nothing is started or opened. Answered with `OwnerTabLinks`, to
 * the asking client only; fails with `OWNER_TAB_GONE` ("the Owner tab is gone") when the tab or its browser is gone.
 */
export const OwnerTabViewRequest = Schema.Struct({
  type: Schema.Literal("owner_tab_view"),
  id: CommandId,
  open: Schema.Boolean,
});

/**
 * List the Owner tabs of the Browser Pane (`docs/spec.md` → Browser → Browser Pane): each by its title, and the one
 * shown. Answered with an `OwnerTabListing`, to the asking client. The browser host also finds here the tabs a page
 * opened (a link with `target=_blank`) and adds them to the list, so a Pane asks again now and then while it is open.
 * Starts nothing: with no browser running the list is empty.
 *
 * `watching` says the Pane is **in view** (its tab shown in the Pane area, the area not hidden, the page visible) and
 * this ask is its heartbeat: while such asks keep coming, the Session keeps its browser (the listing is itself a command
 * to the browser, which Browser Run's `keep_alive` counts), and it lets the browser close once they stop. It is a time
 * the Session notes, never an open/closed flag, so a Pane that is hidden, closed or cut off needs to say nothing. An ask
 * without it (a window opened, another consumer of the listing) holds nothing.
 */
export const OwnerTabListRequest = Schema.Struct({
  type: Schema.Literal("owner_tab_list"),
  id: CommandId,
  watching: Schema.optionalKey(Schema.Boolean),
});

/**
 * Open a new, blank Owner tab and show it (the tab strip's **+**), starting the Session's browser when none runs. Refused
 * for an archived Session. Answered with the `OwnerTabListing` after it, and sent to every client as `owner_tabs`.
 */
export const OwnerTabOpenRequest = Schema.Struct({
  type: Schema.Literal("owner_tab_open"),
  id: CommandId,
});

/**
 * Show Owner tab `ownerTabId` (the host's `id` for it: `OwnerTabEntry`'s): the one shown is the host's, so every device
 * shows it. Answered with the `OwnerTabListing` after it, and sent to every client as `owner_tabs`; fails with
 * `OWNER_TAB_GONE` when the tab is not there.
 */
export const OwnerTabShowRequest = Schema.Struct({
  type: Schema.Literal("owner_tab_show"),
  id: CommandId,
  ownerTabId: Schema.String,
});

/**
 * Close Owner tab `ownerTabId` and the windows it opened; the one shown, if it was that, becomes its neighbour in the
 * list. Closing the last leaves none. Answered with the `OwnerTabListing` after it, and sent to every client as
 * `owner_tabs`. Closing a tab that is not there is not an error.
 */
export const OwnerTabCloseRequest = Schema.Struct({
  type: Schema.Literal("owner_tab_close"),
  id: CommandId,
  ownerTabId: Schema.String,
});

/** Client → server. */
export const ClientMessage = Schema.Union([
  TreeRequest,
  Navigate,
  SwitchBranch,
  LiveViewRequest,
  OwnerTabViewRequest,
  OwnerTabListRequest,
  OwnerTabOpenRequest,
  OwnerTabShowRequest,
  OwnerTabCloseRequest,
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
  ApprovalAnswer,
  AnnotationSave,
  AnnotationDelete,
  ViewedSet,
  WatchTaskGraph,
  UnwatchTaskGraph,
  WatchUsage,
  UnwatchUsage,
  WatchChanges,
  UnwatchChanges,
  RefreshChanges,
  ChangeFileRequest,
  ComparisonSourcesRequest,
  CompareRequest,
  ComparisonFileRequest,
  RunDiffRequest,
  RunFileRequest,
]);

export type ClientMessage = typeof ClientMessage.Type;

/**
 * Sent once on connect: the Session's active branch (GLOSSARY.md → Session branch) as `root`, to `watch` and to submit
 * to without a `conversationId`; `copying` while the Session is still being filled from the one it is a Fork or Clone
 * of. `root` keeps the name it had before Session branches, when the root conversation was the only one, so a client
 * still open across the deploy reads it as it did.
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
  /** Where the agent suggests keeping them: the choice the form starts with. The owner's choice is final. */
  keep: Schema.optionalKey(SecretKeep),
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
 * A call's request for the owner's Approval of an Agent change (GLOSSARY.md → Approval; `docs/spec.md` → Approval): a
 * change to a Limit, or one no revert can undo. Every field is text the card shows as it is.
 */
export const ApprovalRequest = Schema.Struct({
  /** What the answer names: the asking call's task, unique within the Session. */
  id: Schema.String,
  /** The conversation whose call asks. */
  conversationId: ConversationId,
  /** The tool that makes the change, such as `settings_spend_limit_set`. */
  tool: Schema.String,
  /** What it changes: an Environment, by name, or the Settings. */
  target: Schema.String,
  /** The change, in a few words: "Spend limit per Session", "Delete the Environment". */
  change: Schema.String,
  /** The value before; for a delete, what is deleted (an Environment's Workspaces and Sessions, a Secret's name). */
  before: Schema.String,
  /** The value after; for a delete, that nothing is left. */
  after: Schema.String,
  /** Why the agent makes it. */
  reason: Schema.String,
});

export type ApprovalRequest = typeof ApprovalRequest.Type;

/**
 * The Approval requests waiting for the owner, oldest first. A client shows a card for each, with Approve and Decline,
 * answered with `approval_answer`. Sent after `hello` on every connect (an empty list when none waits) and to every client
 * whenever they change. A request outlives reconnects and evictions until it is answered or its call ends (Stop
 * withdraws it).
 */
export const ApprovalRequests = Schema.Struct({
  type: Schema.Literal("approval_requests"),
  requests: Schema.Array(ApprovalRequest),
});

/**
 * The Session's draft Annotations, oldest first: each client shows them in their diffs and as chips in the composer of
 * the conversation they go to. Sent after `hello` on every connect (an empty list when there are none) and to every
 * client whenever they change: a save, a delete, a send, a withdrawn Review's drafts coming back, or the outdated check.
 */
export const AnnotationsMessage = Schema.Struct({
  type: Schema.Literal("annotations"),
  annotations: Schema.Array(Annotation),
});

/**
 * The Session's Viewed boxes (pull request Comparisons only): the files the owner ticked, each with the head blob it was
 * ticked at. Sent after `hello` on every connect (an empty list too) and to every client whenever they change, as the
 * drafts are: a tick, an untick, or a refresh of a pull request that changed a file's blob. A Fork or Clone has none.
 */
export const ViewedMessage = Schema.Struct({
  type: Schema.Literal("viewed"),
  viewed: Schema.Array(ViewedFile).check(Schema.isMaxLength(MAX_VIEWED)),
});

/**
 * A Browser Handoff waiting for the owner (`docs/spec.md` → Browser): the agent gave the owner live control of its browser
 * for a step it cannot do. It carries no Live View link: a client mints one with `live_view` when the owner takes over.
 */
export const BrowserHandoffRequest = Schema.Struct({
  /** The asking call's task, unique within the Session. */
  id: Schema.String,
  /** The conversation whose tab is handed over. */
  conversationId: ConversationId,
  /** What the agent needs done. */
  instructions: Schema.String,
  /** When the handoff times out, in milliseconds since the epoch. */
  deadline: Schema.Finite,
});

export type BrowserHandoffRequest = typeof BrowserHandoffRequest.Type;

/**
 * The Browser Handoffs waiting for the owner, oldest first. A client shows each with its instructions, outside the chat,
 * and opens its Live View on the owner's word. Sent after `hello` on every connect (an empty list when none waits, so a
 * client can tell "none waits" from "not heard yet"), and to every client whenever they change. The owner finishes in the Live View itself, so there is no answer command; a request ends when the owner is
 * done, the handoff times out, or the run is stopped, and it outlives reconnects and evictions until then.
 */
export const BrowserHandoffRequests = Schema.Struct({
  type: Schema.Literal("browser_handoff_requests"),
  requests: Schema.Array(BrowserHandoffRequest),
});

/** A `browser` call working in an Owner tab: the Owner tab (`OwnerTabLinks`' `ownerTabId`) and whose call it is. */
export const OwnerTabDriver = Schema.Struct({
  ownerTabId: Schema.String,
  /** The conversation whose call it is: the root agent's, or a subagent's (the task graph names it). */
  conversationId: ConversationId,
});

export type OwnerTabDriver = typeof OwnerTabDriver.Type;

/**
 * The `browser` calls working in the owner's Owner tabs now, each Owner tab and conversation once, so the Browser Pane can show
 * that the agent (or which subagent) is driving the tab, for the owner to tell their clicks from the agent's. Sent after
 * `hello` on every connect (an empty list when none drives) and to every client whenever it changes.
 */
export const OwnerTabDriversMessage = Schema.Struct({
  type: Schema.Literal("owner_tab_drivers"),
  drivers: Schema.Array(OwnerTabDriver),
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
  /**
   * The branch of the Subagent Workspace it works in (its own, or the nearest ancestor's it shares); absent for one that
   * works in the Session's Workspace.
   */
  branch: Schema.optionalKey(Schema.String),
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
 * How full the active branch's Context Window is: `tokens`, the size of its next request as pi-durable reckons it before
 * compacting (the newest answer's usage, plus estimates of the messages after it), out of the model's `contextWindow`.
 * `compactAt` is where automatic compaction starts (null when it is off). `parts` splits `tokens` by the kind of message,
 * in proportion to estimates of each, since a provider reports one figure per request: the system prompt and tool
 * definitions, the owner's messages (a compaction's summary among them), the model's answers and calls, and tool results.
 */
export const ContextUsage = Schema.Struct({
  tokens: Schema.Finite,
  contextWindow: Schema.Finite,
  compactAt: Schema.NullOr(Schema.Finite),
  parts: Schema.Struct({
    system: Schema.Finite,
    user: Schema.Finite,
    assistant: Schema.Finite,
    tools: Schema.Finite,
  }),
});

export type ContextUsage = typeof ContextUsage.Type;

/**
 * What the Session has spent on model requests (`docs/spec.md` → Telemetry), as pi-durable's `pi.usage` counts it:
 * every conversation of the Session, subagents' included, and the title call, which has no conversation. Token counts
 * are as the provider reported them; `cost` is in US dollars, as the model catalog prices the tokens. `container` is
 * what its Workspace's Containers have cost, absent when no Container has run or it could not be read; it is not part of
 * `cost`, and the spend limit holds `cost` only. `context` is how full the active branch's Context Window is, absent
 * when it could not be read or the model's context window is not known.
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
  context: Schema.optionalKey(ContextUsage),
});

export type SessionUsage = typeof SessionUsage.Type;

/** The Session's usage, sent to a client that watches it (`watch_usage`) whenever it changes; each replaces the last. */
export const UsageMessage = Schema.Struct({
  type: Schema.Literal("usage"),
  ...SessionUsage.fields,
});

/**
 * The Changes of the Session's Workspace, sent to every client that watches them (`watch_changes`) after each listing;
 * each replaces the last. `startingContainer` is set while the owner's Refresh starts the Container for the repos
 * marked `stale`.
 */
export const ChangesMessage = Schema.Struct({
  type: Schema.Literal("changes"),
  /** The watch it answers, as `watch_changes` named it; absent for the Session's own Changes. */
  conversationId: Schema.optionalKey(ConversationId),
  ...WorkspaceChanges.fields,
  startingContainer: Schema.Boolean,
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

/**
 * A page of the handed-over browser and a Live View link to it: a Browser Run `wss` URL that speaks CDP to the page
 * `targetId` names. A bearer credential for the owner alone: it opens every page of the browser session, connects any
 * number of times until it expires (60 s after it was minted; an open connection outlives it), and is never stored,
 * broadcast, pushed, or shown to the agent.
 */
export const LiveViewTarget = Schema.Struct({
  targetId: Schema.String,
  link: Schema.String,
});

export type LiveViewTarget = typeof LiveViewTarget.Type;

/** A window the handed-over tab opened (a pop-up or new tab), directly or through another such window. */
export const LiveViewWindow = Schema.Struct({
  targetId: Schema.String,
  /** The page that opened it: the handed-over tab or another window. */
  openerId: Schema.String,
  title: Schema.String,
  link: Schema.String,
});

export type LiveViewWindow = typeof LiveViewWindow.Type;

/** The answer to `live_view`: fresh links to the handed-over tab and to each window it opened that is still open. */
export const LiveViewLinks = Schema.Struct({
  tab: LiveViewTarget,
  windows: Schema.Array(LiveViewWindow),
});

export type LiveViewLinks = typeof LiveViewLinks.Type;

/**
 * The answer to `owner_tab_view`: the Owner tab the Browser Pane shows (`ownerTabId`, which names it in the browser host,
 * not a CDP target), with fresh links to it and to each window it opened that is still open. An ask with `open` says
 * whether it opened the Owner tab (`opened`: none of the owner's was still there, so the browser may have been started
 * too) and whether the one shown before is gone (`replaced`: its browser was closed or replaced, or it was closed), so
 * the Pane can say why it shows another; an ask without `open` does neither. `reopened`, when present, is how many Owner
 * tabs the ask reopened at their recorded addresses in a browser that replaced the one they were in (no history, scroll,
 * form state or sign-ins come back): the Pane says so.
 */
export const OwnerTabLinks = Schema.Struct({
  ownerTabId: Schema.String,
  ...LiveViewLinks.fields,
  opened: Schema.Boolean,
  replaced: Schema.Boolean,
  reopened: Schema.optionalKey(Schema.Int),
});

export type OwnerTabLinks = typeof OwnerTabLinks.Type;

/**
 * An Owner tab as the tab strip lists it. `id` is the browser host's name for it (`OwnerTabLinks.ownerTabId`), which
 * outlives the page's CDP target. The entry is meant to grow: more fields can be added to it without a client that
 * ignores them noticing.
 */
export const OwnerTabEntry = Schema.Struct({
  id: Schema.String,
  /** The page's title as the browser reports it: page content, shown as text; empty for a page without one. */
  title: Schema.String,
  /**
   * The page's address as the browser reports it, for the owner. It may carry a token or an OAuth code, so whatever
   * tells the agent of the tab says its origin only. Absent when the host did not say.
   */
  url: Schema.optionalKey(Schema.String),
});

export type OwnerTabEntry = typeof OwnerTabEntry.Type;

/**
 * The Owner tabs of the Browser Pane, in the order they were opened, and the one shown (`shown`, an `id` of `tabs`;
 * absent when there are none). It is the browser host's, so every device shows the same tab. It holds no Live View link:
 * those answer `owner_tab_view`, to the one client that asked.
 *
 * With no browser running, `tabs` is empty. `lost` then says how many Owner tabs the host still has on record, to reopen
 * at their addresses (#240): the browser they were in was closed or replaced, as against none ever opened, or the last
 * closed by the owner or by its page in a browser that still runs, which leave nothing to reopen. Absent when there are
 * none.
 */
export const OwnerTabListing = Schema.Struct({
  tabs: Schema.Array(OwnerTabEntry),
  shown: Schema.optionalKey(Schema.String),
  lost: Schema.optionalKey(Schema.Int),
});

export type OwnerTabListing = typeof OwnerTabListing.Type;

/**
 * The Owner tabs after a client opened, showed or closed one: sent to every client so that they follow (a second device
 * switches with the first). Like the answer to `owner_tabs` it holds no link.
 */
export const OwnerTabsMessage = Schema.Struct({
  type: Schema.Literal("owner_tabs"),
  ...OwnerTabListing.fields,
});

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
 * watch of that conversation ended and is dropped: watch it again to resume. With `changes`, it is about a Changes
 * watch, which `conversationId` names as `watch_changes` did (absent: the Session's), and no conversation watch ends:
 * without `ended`, a listing failed, and the last `changes` message stands (the watch goes on); with `ended`, the watch
 * ended and is dropped, as its conversation is no longer an agent's (a subagent deleted), so watching it again fails
 * too. With none of them, a message without a readable `id` could not be read.
 */
export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  id: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(ConversationId),
  changes: Schema.optionalKey(Schema.Literal(true)),
  /** With `changes`: the Changes watch ended and is dropped, rather than one listing failing. */
  ended: Schema.optionalKey(Schema.Literal(true)),
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
  ApprovalRequests,
  AnnotationsMessage,
  ViewedMessage,
  BrowserHandoffRequests,
  OwnerTabsMessage,
  OwnerTabDriversMessage,
  TaskGraphMessage,
  UsageMessage,
  ChangesMessage,
  TodosMessage,
  LastRunMessage,
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
