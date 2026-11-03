// What the client reads of the Repos' `.pi/mcp.json` files an Environment's Registry holds (`docs/architecture/mcp-configuration.md`
// → A Repo's `.pi/mcp.json`): each Repo's file as last looked at, for the Settings page's Repo rows, and the owner's Reload.
//
// Every answer only gains (`docs/architecture/mcp.md` → Deploys): a state is a string and one this build does not know
// reads as `unknown` (`readMcpRepoFileState`); an answer of a tag this build does not know reads as `Unavailable`.
import * as Schema from "effect/Schema";
import { McpNoEnvironment, McpUnavailable, OtherAnswerFromWire } from "./mcp-status.ts";

/**
 * Where a Repo's file stands: `never` (not looked at yet), `read` (its copy is held), `absent` (the Repo has no such file),
 * `oversize` (over 64 KiB, not read), `unreadable` (GitHub gave no answer: the last copy, if any, is kept) and `not_github`
 * (not read, as Skills are not). `unknown` is any state this build does not know.
 */
export const MCP_REPO_FILE_STATES = [
  "never",
  "read",
  "absent",
  "oversize",
  "unreadable",
  "not_github",
  "unknown",
] as const;

export type McpRepoFileState = (typeof MCP_REPO_FILE_STATES)[number];

const isRepoFileState = Schema.is(Schema.Literals(MCP_REPO_FILE_STATES));

/** `raw`, a state as it crossed the edge, as one this build knows: `unknown` for any other. */
export const readMcpRepoFileState = (raw: string): McpRepoFileState =>
  isRepoFileState(raw) ? raw : "unknown";

/** One Repo's `.pi/mcp.json` as the Registry last looked at it. Times are epoch milliseconds. */
export const McpRepoFileView = Schema.Struct({
  /** The Repo's directory name in the Environment (`/workspace/<repo>`). */
  repo: Schema.String,
  /** The Repo's `owner/repo` on GitHub; absent for a Repo that is not on GitHub. */
  slug: Schema.optionalKey(Schema.String),
  /** The file's path in the Repo: `.pi/mcp.json`. */
  path: Schema.String,
  state: Schema.String,
  /** The blob SHA of the copy held (of the file that was too large, for `oversize`). */
  blob: Schema.optionalKey(Schema.String),
  /** The copy held: the last good read, which `unreadable` keeps. Absent when none is held. */
  text: Schema.optionalKey(Schema.String),
  /** When the copy held was read. */
  readAt: Schema.optionalKey(Schema.Finite),
  /** When the Repo was last looked at, whatever came of it. Absent for `never`. */
  lookedAt: Schema.optionalKey(Schema.Finite),
  /** Why the last look failed (`unreadable`), and since when looks have been failing. */
  error: Schema.optionalKey(Schema.String),
  errorSince: Schema.optionalKey(Schema.Finite),
  /** What is wrong with the file as a whole that parsing its text would not say, as `is …`/`could not be …` text. */
  problem: Schema.optionalKey(Schema.String),
});

export type McpRepoFileView = typeof McpRepoFileView.Type;

/** `mcpRepoFiles`' and `mcpReloadRepoFiles`' answer: each Repo's file in the Environment's Repo order, or why not. */
export const McpRepoFiles = Schema.TaggedStruct("RepoFiles", {
  files: Schema.Array(McpRepoFileView),
});

export type McpRepoFiles = typeof McpRepoFiles.Type;

export const McpRepoFilesView = Schema.Union([
  McpRepoFiles,
  McpNoEnvironment,
  McpUnavailable,
  OtherAnswerFromWire,
]);

export type McpRepoFilesView = typeof McpRepoFilesView.Type;
