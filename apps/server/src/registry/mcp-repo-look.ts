// Looking at a Repo's `.pi/mcp.json` on its default branch (`docs/architecture/mcp-configuration.md` → A Repo's
// `.pi/mcp.json`; ADR-0029, D3 and D7 of the MCP server configuration design): through the Skills' `RepoReader`, as the
// GitHub App, the blob SHA telling a change so that a file that did not change is not read again. Each look is kept
// (`mcp_repo_files`) with what it found:
//
// - the file is there: its text (`read`);
// - the Repo is readable and the file is not there: no servers, no problem (`absent`);
// - the file is over 64 KiB: it is not read, no servers, a problem (`oversize`); one that reads but is not JSON, or has no
//   `mcpServers`, is a `read` whose parse says so (`readMcpRepoFile`), and the new text replaces any old copy;
// - the Repo cannot be read (no repo or lost access, rate limit, 5xx, network): the last good copy stays, marked with
//   the error and since when (`unreadable`), a problem after 24 h; the owner's Reload drops it;
// - the Repo is not on GitHub: not read (`not_github`).
//
// A look never throws: what goes wrong is `unreadable`. Looks of one Repo that overlap are one.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off -- GitHub is read through a Promise API; plain functions over values.
import { MCP_LIMITS } from "@cloudpid/config";
import { type EnvironmentRepo, MCP_REPO_FILE_PATH } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { GithubReadError, type RepoReader } from "../github/skill-fetch.ts";
import { githubRepoOf } from "../workspace/github-pulls.ts";
import {
  MCP_REPO_LOOK_INTERVAL_MS,
  MCP_REPO_THROTTLE_MS,
  type McpRepoFileRecord,
  recordOf,
} from "./mcp-repo-files.ts";
import type { RegistryStore } from "./store.ts";

/** What a look reads of GitHub: a file's blob and size, and the blob. */
export type McpRepoReader = Pick<RepoReader, "file" | "blob">;

/** The store as the looks use it. */
export type McpRepoLookStore = Pick<
  RegistryStore,
  "getEnvironment" | "getMcpRepoFiles" | "putMcpRepoFile"
>;

const isReadError = Schema.is(GithubReadError);

/** Why a look failed, in words for the owner: GitHub's own account of it, or what went wrong. */
const failureText = (cause: unknown): string =>
  isReadError(cause)
    ? cause.message
    : `the read failed (${cause instanceof Error ? cause.message : String(cause)})`;

/**
 * What the look at `repo` (as `slug` on GitHub) of `environment` found, given the record the last look left (`held`):
 * the new record. With `drop`, a Repo that cannot be read does not keep its last good copy (the owner's Reload).
 */
export const lookAtMcpRepo = async (
  reader: McpRepoReader,
  input: {
    readonly environment: string;
    readonly repo: EnvironmentRepo;
    readonly held: McpRepoFileRecord | null;
    readonly now: number;
    readonly drop: boolean;
  },
): Promise<McpRepoFileRecord> => {
  const { environment, repo, now } = input;
  const remote = githubRepoOf(repo.url);

  const bare: McpRepoFileRecord = {
    environment,
    repo: repo.name,
    slug: null,
    state: "not_github",
    blob: null,
    text: null,
    size: null,
    readAt: null,
    lookedAt: now,
    error: null,
    failingSince: null,
  };

  if (remote === undefined) return bare;

  const slug = `${remote.owner}/${remote.name}`;

  // What the last look left of this Repo's own file; another address under the same directory name is another Repo.
  const last = input.held?.slug === slug ? input.held : null;

  try {
    const file = await reader.file(remote, null, MCP_REPO_FILE_PATH);

    if (file === null) return { ...bare, slug, state: "absent" };

    if (file.size > MCP_LIMITS.repoFileBytes) {
      return { ...bare, slug, state: "oversize", blob: file.sha, size: file.size };
    }

    // The same blob as the copy held: nothing to read again.
    if (last !== null && last.text !== null && last.blob === file.sha) {
      return { ...last, state: "read", lookedAt: now, error: null, failingSince: null };
    }

    const text = new TextDecoder().decode(await reader.blob(remote, file.sha));

    return { ...bare, slug, state: "read", blob: file.sha, text, readAt: now };
  } catch (cause) {
    const kept = !input.drop && last !== null && last.text !== null;

    return {
      ...bare,
      slug,
      state: "unreadable",
      blob: kept ? last.blob : null,
      text: kept ? last.text : null,
      readAt: kept ? last.readAt : null,
      error: failureText(cause),
      failingSince:
        last?.state === "unreadable" && last.failingSince !== null ? last.failingSince : now,
    };
  }
};

/** Why a look is made: what decides whether the last one is recent enough. */
export type McpRepoLookReason =
  /** The host asks for the set: a Repo not looked at in 10 minutes. */
  | "due"
  /** A Build that noticed the default branch moved: unless looked at in the last 30 s. */
  | "moved"
  /** `addRepo`: a Repo just added, looked at at once (there is no look of it to be recent). */
  | "added"
  /** The owner's Reload: at once, and a Repo that cannot be read loses its last good copy. */
  | "reload";

/** The looks at an Environment's Repos' files. */
export type McpRepoLooks = {
  /**
   * Look at `environment`'s Repos (only `repos` when given) as `reason` says; what is kept is written to the store. The
   * Repos that were looked at, by directory name. Never throws.
   */
  readonly look: (input: {
    readonly environment: string;
    readonly repos?: ReadonlyArray<string> | undefined;
    readonly reason: McpRepoLookReason;
    readonly now: number;
  }) => Promise<ReadonlyArray<string>>;
};

/** Whether a look as `reason` is due, `held` being what the last look left of the Repo and `now` the time. */
const lookDue = (
  reason: McpRepoLookReason,
  held: McpRepoFileRecord | null,
  now: number,
): boolean => {
  if (reason === "reload" || reason === "added" || held === null) return true;

  return (
    now - held.lookedAt >= (reason === "due" ? MCP_REPO_LOOK_INTERVAL_MS : MCP_REPO_THROTTLE_MS)
  );
};

/**
 * The looks over `reader`, kept in `store`. Looks of one Repo that overlap are one, whoever asks, so the scheduled looks and
 * an owner's Reload never read the same file twice at once; the record is written only if the Repo is still the
 * Environment's, so a Repo removed meanwhile is not left a row.
 */
export const openMcpRepoLooks = (store: McpRepoLookStore, reader: McpRepoReader): McpRepoLooks => {
  const inFlight = new Map<
    string,
    { readonly reason: McpRepoLookReason; readonly promise: Promise<void> }
  >();

  const once = async (
    environment: string,
    repo: EnvironmentRepo,
    reason: McpRepoLookReason,
    now: number,
  ): Promise<void> => {
    const held = recordOf(store.getMcpRepoFiles(environment), repo.name);

    if (!lookDue(reason, held, now)) return;

    const record = await lookAtMcpRepo(reader, {
      environment,
      repo,
      held,
      now,
      drop: reason === "reload",
    });

    const current = store.getEnvironment(environment);

    if (
      current !== null &&
      Arr.some(current.repos, (it) => it.name === repo.name && it.url === repo.url)
    ) {
      store.putMcpRepoFile(record);
    }
  };

  const lookAt = (
    environment: string,
    repo: EnvironmentRepo,
    reason: McpRepoLookReason,
    now: number,
  ): Promise<void> => {
    const key = `${environment}\n${repo.name}`;
    const running = inFlight.get(key);

    // A look joins the one running, unless it is a Reload joining another: that look would keep the copy a Reload drops,
    // so the Reload looks again once it is over.
    if (running !== undefined && (reason !== "reload" || running.reason === "reload")) {
      return running.promise;
    }

    const promise: Promise<void> = (running?.promise.catch(() => undefined) ?? Promise.resolve())
      .then(() => once(environment, repo, reason, now))
      .finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      });

    inFlight.set(key, { reason, promise });

    return promise;
  };

  return {
    look: async ({ environment, repos, reason, now }) => {
      const known = store.getEnvironment(environment);

      if (known === null) return [];

      const wanted = Arr.filter(
        known.repos,
        (repo) => repos === undefined || Arr.contains(repos, repo.name),
      );

      await Promise.all(wanted.map((repo) => lookAt(environment, repo, reason, now)));

      return Arr.map(wanted, (repo) => repo.name);
    },
  };
};
