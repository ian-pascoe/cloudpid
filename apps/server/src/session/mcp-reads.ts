// What the Session host reads for the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Following a Run,
// Transcripts): the state a wait or a status is decided from, and entries to render. Plain data, so the decisions over
// it (`mcp-follow.ts`) are pure.

/** How a Run's input ended, as the submission says. */
export type SettledInput =
  | { readonly id: number; readonly status: "done"; readonly answer?: string | undefined }
  | {
      readonly id: number;
      readonly status: "unanswered";
      readonly reason: string;
      readonly detail?: unknown;
    };

/** The Session as a wait or a status sees it. */
export type FollowState = {
  /** The conversation read: the one asked for, or the active branch's. */
  readonly conversationId: number;
  /** The active branch: where the owner is now, which may not be the conversation read. */
  readonly activeBranch: number;
  /** Whether the Session is being filled as a Fork, Clone or import: it takes no input yet. */
  readonly copying: boolean;
  /**
   * Whether no work is live and no input is unsettled anywhere in the Session. A follower of an MCP task is not work: a
   * conversation that only follows MCP tasks is idle (`docs/architecture/mcp-server-requests.md` → MCP tasks).
   */
  readonly idle: boolean;
  /** Whether a follower of an MCP task is live: only Stop all (`session_stop` with `subagents`) reaches it. */
  readonly following: boolean;
  /** Whether an input of the conversation is queued or being answered. */
  readonly unsettled: boolean;
  /** Whether a task is parked (pi-durable's restart limit): nothing moves until the owner retries it. */
  readonly stalled: boolean;
  /** The conversation's newest entry, or 0. */
  readonly newestEntry: number;
  /** The conversation's newest input that has settled. */
  readonly newestSettled?: SettledInput;
  /** Each conversation's agent: `root` for a Session branch. */
  readonly agents: Readonly<Record<string, string>>;
  /** The conversation's model, `provider/id`, when its agent is known. */
  readonly model?: string;
  /** The conversation's thinking level, when its agent has one. */
  readonly thinking?: string;
};

/** A read of a conversation's entries. */
export type EntriesRequest = {
  /** The conversation to read: the active branch's by default. */
  readonly conversationId?: number | undefined;
  readonly order: "ascending" | "descending";
  /** The oldest entry that may be returned. */
  readonly minEntryId?: number | undefined;
  /** The newest entry that may be returned. */
  readonly maxEntryId?: number | undefined;
  readonly limit: number;
};
