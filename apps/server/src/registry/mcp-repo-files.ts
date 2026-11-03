// The Repo layer of an Environment's MCP server set, as the Registry holds it (`docs/architecture/mcp-configuration.md` → A
// Repo's `.pi/mcp.json`; ADR-0029): per (Environment, Repo) the last look at the Repo's file on its default branch, kept in
// `mcp_repo_files`. The looks themselves are `mcp-repo-look.ts`; this is what is kept, what the set is made of it
// (`mcpRepoLayers`), and what the page is told of it (`mcpRepoFileViews`). Pure over the store's rows.
// @effect-diagnostics missingPipeableSignature:off globalDate:off -- plain functions over values, not combinators; a read time is said as ISO text.
import { MCP_LIMITS, type McpRepoLayer } from "@cloudpid/config";
import type { McpRepoFileView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { EnvironmentBuild } from "../workspace/build-record.ts";
import type { RegistryStore } from "./store.ts";

/** The file a Repo's MCP servers are read from. */
export const MCP_REPO_FILE_PATH = ".pi/mcp.json";

/** How old the last look may be before the host's pull looks again. */
export const MCP_REPO_LOOK_INTERVAL_MS = 10 * 60_000;

/** The least time between two looks at one (Environment, Repo): the scheduled looks and a Build's are held to it. */
export const MCP_REPO_THROTTLE_MS = 30_000;

/** How long looks fail before the Repo's last good copy is a problem. */
export const MCP_REPO_STALE_MS = 24 * 60 * 60_000;

/** What the last look found, as kept: `read` holds a copy; `unreadable` holds the last good one, if there was one. */
export type McpRepoLookState = "read" | "absent" | "oversize" | "unreadable" | "not_github";

/** One Repo's row of `mcp_repo_files`. Times are epoch milliseconds. */
export type McpRepoFileRecord = {
  readonly environment: string;
  /** The Repo's directory name in the Environment. */
  readonly repo: string;
  /** `owner/repo`; null for a Repo that is not on GitHub. */
  readonly slug: string | null;
  readonly state: McpRepoLookState;
  /** The blob SHA of `text`, or of the file that was too large. */
  readonly blob: string | null;
  /** The last good copy of the file. */
  readonly text: string | null;
  /** The size of the file that was too large. */
  readonly size: number | null;
  /** When `text` was read. */
  readonly readAt: number | null;
  /** When the Repo was last looked at, whatever came of it. */
  readonly lookedAt: number;
  /** Why the last look failed. */
  readonly error: string | null;
  /** When the run of failed looks began. */
  readonly failingSince: number | null;
};

/** The store as the Repo layer reads it. */
export type McpRepoFilesStore = Pick<RegistryStore, "getEnvironment" | "getMcpRepoFiles">;

/** Whether `record` holds a copy whose servers are in the set: a good read, or the last one an unreadable Repo keeps. */
const holdsCopy = (record: McpRepoFileRecord): boolean =>
  record.text !== null && (record.state === "read" || record.state === "unreadable");

/**
 * The Repo layers of `environment`'s MCP server set, in its Repo order: each Repo whose file's last good copy is held, with
 * the text of that copy. A Repo with no copy (not looked at yet, no file, over 64 KiB, not on GitHub, unreadable from the
 * start) has none and adds no server. `[]` for no Environment, such as Global's.
 */
export const mcpRepoLayers = (
  store: McpRepoFilesStore,
  environment: string | null,
): ReadonlyArray<McpRepoLayer> => {
  const known = environment === null ? null : store.getEnvironment(environment);

  if (environment === null || known === null) return [];

  const records = store.getMcpRepoFiles(environment);

  return Arr.filterMap(known.repos, (repo) => {
    const record = Arr.findFirst(records, (held) => held.repo === repo.name).pipe(
      Option.getOrUndefined,
    );

    return record !== undefined && holdsCopy(record) && record.slug !== null && record.text !== null
      ? Result.succeed<McpRepoLayer>({
          directory: record.repo,
          slug: record.slug,
          path: MCP_REPO_FILE_PATH,
          text: record.text,
        })
      : Result.failVoid;
  });
};

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

const KIB = 1024;

/**
 * What is wrong with the file as a whole that its text would not say (D7): a Repo that cannot be read and has no copy
 * says why at once (a private repo the App cannot see is the owner's to install it on); one whose copy is kept becomes a
 * problem after 24 h of failed looks; a file over 64 KiB says its size. Worded to follow the Repo's name, as a parse
 * problem is (`is not valid JSON`).
 */
export const mcpRepoFileProblem = (record: McpRepoFileRecord, now: number): string | null => {
  switch (record.state) {
    case "oversize":
      return `is ${record.size === null ? "over" : `${Math.ceil(record.size / KIB)} KiB, over`} ${MCP_LIMITS.repoFileBytes / KIB} KiB, so it is not read`;
    case "unreadable": {
      const error = record.error ?? "GitHub gave no answer";

      if (!holdsCopy(record)) return `could not be read: ${error}`;

      const since = record.failingSince ?? record.lookedAt;

      return now - since >= MCP_REPO_STALE_MS
        ? `could not be read for over a day, so its servers are those of the copy read ${new Date(record.readAt ?? since).toISOString()}: ${error}`
        : null;
    }

    default:
      return null;
  }
};

/** Each of `environment`'s Repos' files as the page shows them, in the Environment's Repo order; null for no Environment. */
export const mcpRepoFileViews = (
  store: McpRepoFilesStore,
  environment: string,
  now: number,
): ReadonlyArray<McpRepoFileView> | null => {
  const known = store.getEnvironment(environment);

  if (known === null) return null;

  const records = store.getMcpRepoFiles(environment);

  return Arr.map(known.repos, (repo): McpRepoFileView => {
    const record = Arr.findFirst(records, (held) => held.repo === repo.name).pipe(
      Option.getOrUndefined,
    );

    if (record === undefined) return { repo: repo.name, path: MCP_REPO_FILE_PATH, state: "never" };

    const view: Mutable<McpRepoFileView> = {
      repo: repo.name,
      path: MCP_REPO_FILE_PATH,
      state: record.state,
      lookedAt: record.lookedAt,
    };

    if (record.slug !== null) view.slug = record.slug;

    if (record.blob !== null) view.blob = record.blob;

    if (record.text !== null) view.text = record.text;

    if (record.readAt !== null) view.readAt = record.readAt;

    if (record.error !== null) view.error = record.error;

    if (record.failingSince !== null) view.errorSince = record.failingSince;

    const problem = mcpRepoFileProblem(record, now);

    if (problem !== null) view.problem = problem;

    return view;
  });
};

/**
 * The Repos whose default branch a Build found moved: those the Build `after` has a commit for that the Build `before` did
 * not have or had another one for (a Build that found a Repo with no commits yet moved none). The Registry looks at those
 * Repos' files (`docs/architecture/mcp-configuration.md` → A Repo's `.pi/mcp.json`).
 */
export const buildMovedRepos = (
  before: EnvironmentBuild | null,
  after: EnvironmentBuild | null,
): ReadonlyArray<string> =>
  after === null
    ? []
    : Arr.filter(
        Record.keys(after.commits),
        (repo) => after.commits[repo] !== null && after.commits[repo] !== before?.commits[repo],
      );

/** The Repos of `environment` that no look has left a row for: ones added before their files were read. */
export const mcpUnlookedRepos = (
  store: McpRepoFilesStore,
  environment: string,
): ReadonlyArray<string> => {
  const known = store.getEnvironment(environment);
  const records = store.getMcpRepoFiles(environment);

  return known === null
    ? []
    : Arr.filterMap(known.repos, (repo) =>
        Arr.some(records, (held) => held.repo === repo.name)
          ? Result.failVoid
          : Result.succeed(repo.name),
      );
};
