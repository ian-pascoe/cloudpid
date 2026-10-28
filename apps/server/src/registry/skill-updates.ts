// Updating installed Skills (ADR-0026, GLOSSARY.md → Skill source, `docs/architecture/workspace.md` → Installing from GitHub → Updates): a
// Skill stays as it was fetched until someone updates it. An update fetches the latest commit of each Skill's recorded ref
// (`../github/skill-fetch.ts`, as an install does) and keeps the files in place of the Skill's, with the new Skill source,
// as a save keeps a Skill. The agent's update records an Agent change for each Skill moved, with the files and the source
// before and after, so a revert brings back the earlier commit and the edits an overwrite replaced; the owner's, from the
// Environments page, is the owner's save and records none. The daily check (`checkSkillUpdates`) only reads GitHub, one
// request for each repo and ref, and marks the Skills whose folder changed at the ref's head; it applies nothing.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- GitHub is read through a Promise API, and the reads and the checks run over native arrays.
import { MAX_APPROVED_SKILLS } from "@cloudpid/extensions/skill-checks";
import type {
  SkillSource,
  SkillUpdateEntry,
  SkillUpdatePin,
  SkillUpdatePreview,
  SkillUpdateReady,
  SkillUpdateRun,
} from "@cloudpid/protocol";
import {
  fetchSkillsAt,
  GithubReadError,
  type RepoReader,
  type SkillRepo,
} from "../github/skill-fetch.ts";
import { folderHashOf, skillMdIn } from "../github/skill-paths.ts";
import * as Schema from "effect/Schema";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import { scopeOf } from "./secret-changes.ts";
import {
  hashFiles,
  keepSkillAsOwner,
  previewSizeProblem,
  previewSkillSave,
  sameFiles,
  saveSkillAs,
  type SkillChangeContext,
  type SkillScope,
  type Skills,
  type StoredSkill,
} from "./skills.ts";

/** The Registry document that keeps when the daily check last ran (epoch milliseconds, as text). */
export const SKILL_CHECK_DOCUMENT = "skill-update-check";

/** The most often the daily check runs. */
export const SKILL_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/** How long after a run the rate limit ended the next is due. */
export const SKILL_CHECK_RETRY_MS = 60 * 60_000;

/** The repo `owner/name` names. */
const repoOf = (repo: string): SkillRepo => {
  const slash = repo.indexOf("/");

  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

/** The key of one read of GitHub: a repo at a ref (or a commit; "" for the repo's default branch). */
const readKey = (repo: string, at: string | null): string => `${repo}\0${at ?? ""}`;

/** What a `readKey` names, for a message. */
const readKeyText = (key: string): string => key.replace("\0", "@");

/** A full commit SHA: a ref that names one never moves. */
const isCommit = (ref: string): boolean => /^[0-9a-f]{40}$/.test(ref);

/** What an update is asked: the Skills (absent: every one marked update available), and whether edits may be replaced. */
export type UpdateRequest = {
  /** An Environment's id, or `*` for every Environment. */
  readonly environment: string;
  readonly names?: ReadonlyArray<string> | undefined;
  readonly overwrite: boolean;
  /** The updates the owner approved: read at those commits and made only against what they were shown. */
  readonly pins?: ReadonlyArray<SkillUpdatePin> | undefined;
};

/** Whether `skill` is, unedited, at the commit and folder `pin` approved: the approved update was made already. */
const isAtPin = (
  skill: StoredSkill & { readonly source: SkillSource },
  pin: SkillUpdatePin | undefined,
) =>
  pin !== undefined &&
  !skill.modified &&
  skill.source.commit === pin.commit &&
  skill.folderHash === pin.folderHash;

/** A Skill to move, read at the commit it moves to. */
type Candidate = {
  readonly skill: StoredSkill & { readonly source: SkillSource };
  /** What the update would take, as the Approval card shows it. */
  readonly ready: SkillUpdateReady;
  readonly hashed: Awaited<ReturnType<typeof hashFiles>>;
  /** Its files at the new commit are the ones it has: only its mark and hash are brought up to date. */
  readonly same: boolean;
};

/** What reading the Skills of a request came to: an entry for each that is settled already, and those to apply. */
type Planned = {
  readonly environment: SkillScope;
  readonly settled: ReadonlyArray<SkillUpdateEntry>;
  readonly candidates: ReadonlyArray<Candidate>;
  /** The order the Skills were asked in, to answer in. */
  readonly order: ReadonlyArray<string>;
};

const withSource = (skill: StoredSkill): skill is StoredSkill & { readonly source: SkillSource } =>
  skill.source !== null;

/**
 * Read the Skills `request` names (else those marked update available) at the latest commit of their recorded ref, or at
 * the pinned commit, and decide what each would do. One commit and one tree for each repo and ref. Nothing is written.
 */
const plan = async (
  { store, skills }: Pick<SkillChangeContext, "store" | "skills">,
  reader: RepoReader,
  request: UpdateRequest,
  limit?: number,
): Promise<
  | Planned
  | { readonly status: "missing" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "nothing"; readonly environment: SkillScope }
> => {
  const { environment, overwrite, pins } = request;
  const scope = scopeOf(environment, store);

  if (scope === null) return { status: "missing" };

  const kept = skills.list(environment);
  const pinned = new Map((pins ?? []).map((pin) => [pin.name, pin] as const));

  const asked =
    request.names === undefined
      ? kept.filter((skill) => skill.updateAvailable).map((skill) => skill.name)
      : [...new Set(request.names)];

  if (asked.length === 0) return { status: "nothing", environment: scope };

  if (limit !== undefined && asked.length > limit) {
    return {
      status: "refused",
      message: `${asked.length} Skills would be updated (${asked.join(", ")}), and one request for the user's Approval shows at most ${limit}, each with its files: name up to ${limit} of them, then call again for the rest`,
    };
  }

  const settled: SkillUpdateEntry[] = [];
  const toRead: Array<StoredSkill & { readonly source: SkillSource }> = [];

  for (const name of asked) {
    const skill = kept.find((candidate) => candidate.name === name);

    if (skill === undefined) {
      settled.push({
        name,
        outcome: "rejected",
        message: `${scope.name} keeps no Skill named ${JSON.stringify(name)}`,
      });
    } else if (!withSource(skill)) {
      settled.push({
        name,
        outcome: "rejected",
        message:
          "it has no Skill source (it was written or saved, not installed from GitHub), so there is nothing to update from",
      });
    } else if (skill.modified && !overwrite) {
      settled.push({
        name,
        outcome: "modified",
        message: "it was edited since it was installed, and an update would replace the edits",
      });
    } else if (isAtPin(skill, pinned.get(name))) {
      // A rerun of an update made already (the Session was evicted before it saw the answer): saving it moved `savedAt`,
      // which is not a reason to call the approved update failed.
      settled.push({
        name,
        outcome: "unchanged",
        message: "it is at the commit and files the user approved already",
      });
    } else if (pinned.has(name) && pinned.get(name)?.savedAt !== skill.savedAt) {
      settled.push({
        name,
        outcome: "changed-since",
        message: "it was saved again since the user was asked",
      });
    } else {
      toRead.push(skill);
    }
  }

  // One read of GitHub for each repo and ref: the pinned commit when the owner approved one.
  const groups = new Map<string, Array<(typeof toRead)[number]>>();

  for (const skill of toRead) {
    const at = pinned.get(skill.name)?.commit ?? skill.source.ref ?? "";
    const key = readKey(skill.source.repo, at);

    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }

  const candidates: Candidate[] = [];

  for (const [key, group] of groups) {
    const at = key.slice(key.indexOf("\0") + 1);
    const first = group[0];

    if (first === undefined) continue;

    const fetched = await fetchSkillsAt(reader, {
      repo: repoOf(first.source.repo),
      ref: at === "" ? null : at,
      folders: group.map((skill) => skill.source.path),
    });

    if (fetched.status === "failed") {
      for (const skill of group) {
        settled.push({ name: skill.name, outcome: "rejected", message: fetched.message });
      }

      continue;
    }

    for (const [index, skill] of group.entries()) {
      const read = fetched.skills[index];

      if (read === undefined) continue;

      if (!read.ok) {
        settled.push({ name: skill.name, outcome: "rejected", message: read.message });
        continue;
      }

      if (read.name !== skill.name) {
        settled.push({
          name: skill.name,
          outcome: "rejected",
          message: `at ${fetched.commit.slice(0, 7)} its SKILL.md is named ${JSON.stringify(read.name)}, not ${JSON.stringify(skill.name)}: install it again under that name if it is wanted`,
        });

        continue;
      }

      const pin = pinned.get(skill.name);

      if (pin !== undefined && pin.folderHash !== read.folderHash) {
        settled.push({
          name: skill.name,
          outcome: "changed-since",
          message: "the commit's files are not the ones the user was shown",
        });

        continue;
      }

      const hashed = await hashFiles(read.files);

      candidates.push({
        skill,
        hashed,
        same: sameFiles(skill.files, hashed.files) && !skill.modified,
        ready: {
          name: skill.name,
          outcome: "ready",
          from: skill.source,
          to: { ...skill.source, commit: fetched.commit },
          description: read.description,
          files: read.files,
          folderHash: read.folderHash,
          savedAt: skill.savedAt,
          overwrites: skill.modified,
          current: {
            description: skill.description,
            files: Object.keys(skill.files).toSorted(),
          },
        },
      });
    }
  }

  return { environment: scope, settled, candidates, order: asked };
};

/** The answer, in the order the Skills were asked in. */
const ordered = <Entry extends { readonly name: string }>(
  order: ReadonlyArray<string>,
  entries: ReadonlyArray<Entry>,
): Entry[] => order.flatMap((name) => entries.filter((entry) => entry.name === name));

/**
 * What an update of the Skills `request` names would do, with nothing saved or recorded: the files each would take, for
 * the owner's Approval card of an update for every Environment.
 */
export const previewSkillUpdates = async (
  context: Pick<SkillChangeContext, "store" | "skills">,
  reader: RepoReader,
  request: UpdateRequest,
): Promise<SkillUpdatePreview> => {
  const planned = await plan(context, reader, request, MAX_APPROVED_SKILLS);

  if ("status" in planned) return planned;

  const { settled, candidates, order, environment } = planned;

  const results = ordered<SkillUpdateEntry | SkillUpdateReady>(order, [
    ...settled,
    ...candidates.map(({ ready, same, skill, hashed }): SkillUpdateEntry | SkillUpdateReady => {
      if (same) {
        return {
          name: skill.name,
          outcome: "unchanged",
          message: "its folder is the same at the ref's latest commit",
        };
      }

      // The caps are checked before the owner is asked, as a save's are: against the sets the update would make.
      const checked = previewSkillSave(context, {
        environment: request.environment,
        folder: skill.name,
        files: ready.files,
        hashed,
      });

      return checked.status === "rejected"
        ? { name: skill.name, outcome: "rejected", message: checked.message }
        : ready;
    }),
  ]);

  const tooLarge = previewSizeProblem(
    results.flatMap((result) => (result.outcome === "ready" ? [result.files] : [])),
  );

  if (tooLarge !== undefined) return { status: "refused", message: tooLarge };

  return { status: "done", environment, results };
};

/**
 * Update the Skills `request` names (else those marked update available) to the latest commit of their recorded ref: each
 * is kept as a save keeps a Skill, with its new Skill source and not modified, and recorded as an Agent change by
 * `author` with the files and source before and after (so a revert brings back the earlier commit and any edits an
 * overwrite replaced). With no author it is the owner's, which records none. A Skill whose folder is the same at the new
 * commit records nothing. Reads GitHub first, then keeps each Skill in a transaction of its own, so one the checks
 * refuse leaves the others updated.
 */
export const updateSkills = async (
  context: SkillChangeContext,
  reader: RepoReader,
  request: UpdateRequest & { readonly author: AgentChangeAuthor | null },
): Promise<SkillUpdateRun> => {
  const planned = await plan(context, reader, request);

  if ("status" in planned) return planned;

  const { settled, candidates, order, environment } = planned;
  const { author } = request;
  const results: SkillUpdateEntry[] = [...settled];

  for (const { skill, ready, hashed, same } of candidates) {
    if (same) {
      // Nothing to keep: its mark is cleared, and the hash of the folder recorded for the next check.
      context.skills.recordFound(request.environment, skill.name, skill.source.commit, {
        folderHash: ready.folderHash,
        updateAvailable: false,
      });

      results.push({
        name: skill.name,
        outcome: "unchanged",
        message: "its folder is the same at the ref's latest commit",
      });

      continue;
    }

    const toKeep = {
      environment: request.environment,
      folder: skill.name,
      files: ready.files,
      hashed,
      source: ready.to,
      folderHash: ready.folderHash,
    };

    // With the owner's Approval, only what they were shown is applied.
    if (request.pins !== undefined && !request.pins.some((pin) => pin.name === skill.name)) {
      results.push({
        name: skill.name,
        outcome: "changed-since",
        message: "it was not part of the update the user approved",
      });

      continue;
    }

    // Between reading GitHub and now the Skill may have been saved again: only the Skill that was read is replaced.
    if (context.skills.get(request.environment, skill.name)?.savedAt !== skill.savedAt) {
      results.push({
        name: skill.name,
        outcome: "changed-since",
        message: "it was saved again while the update was read",
      });

      continue;
    }

    const kept =
      author === null
        ? keepSkillAsOwner(context, toKeep)
        : saveSkillAs(context, { ...toKeep, author, expected: { savedAt: skill.savedAt } });

    switch (kept.status) {
      case "saved": {
        const done = {
          name: skill.name,
          outcome: "updated" as const,
          from: ready.from,
          to: ready.to,
          overwrote: ready.overwrites,
        };

        results.push(kept.change === undefined ? done : { ...done, change: kept.change });
        break;
      }

      case "unchanged":
        results.push({
          name: skill.name,
          outcome: "unchanged",
          message: "it already has these files from that commit",
        });
        break;
      case "changed-since":
        results.push({
          name: skill.name,
          outcome: "changed-since",
          message: "it was saved again while the update was read",
        });
        break;
      case "rejected":
        results.push({ name: skill.name, outcome: "rejected", message: kept.message });
        break;
      case "missing":
        results.push({
          name: skill.name,
          outcome: "rejected",
          message: "the Environment no longer exists",
        });
        break;
    }
  }

  return { status: "done", environment, results: ordered(order, results) };
};

/** What the daily check came to. */
export type SkillCheck = {
  /** How many Skills it compared with their ref's head. */
  readonly checked: number;
  /** How many it marked update available, and how many it took the mark off (the ref went back). */
  readonly marked: number;
  readonly cleared: number;
  /** Why it left some alone, for the log. */
  readonly problems: ReadonlyArray<string>;
  /** GitHub's rate limit was hit: it stopped, and a later run tries again. */
  readonly rateLimited: boolean;
};

/**
 * The daily check of the installed Skills (ADR-0026): for each repo and ref the Skills of every scope were installed from,
 * one request for the ref's tree at its head (`headTree`), compared with the digest of each Skill's folder at the commit
 * it was installed at (`folderHash`; for a Skill kept before it was recorded, read from the tree at its commit and
 * recorded now). A Skill whose folder moved is marked update available; one whose folder is back where it was loses the
 * mark. It applies nothing and tells nobody. A repo it cannot read, a tree GitHub cut short, and a folder that is gone
 * leave the marks as they are; the rate limit ends the run. A ref that names a commit never moves and is not looked at.
 */
export const checkSkillUpdates = async (
  skills: Pick<Skills, "listSourced" | "recordFound">,
  reader: RepoReader,
): Promise<SkillCheck> => {
  const sourced = skills
    .listSourced()
    .flatMap((skill) =>
      skill.source === null || (skill.source.ref !== null && isCommit(skill.source.ref))
        ? []
        : [{ ...skill, source: skill.source }],
    );

  const groups = new Map<string, typeof sourced>();

  for (const skill of sourced) {
    const key = readKey(skill.source.repo, skill.source.ref);

    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }

  const problems: string[] = [];
  let checked = 0;
  let marked = 0;
  let cleared = 0;

  // The tree a Skill was installed at, read once for all the Skills of a repo at one commit.
  const installedTrees = new Map<string, Promise<Awaited<ReturnType<RepoReader["tree"]>>>>();

  for (const [key, group] of groups) {
    const first = group[0];

    if (first === undefined) continue;

    const repo = repoOf(first.source.repo);
    const ref = first.source.ref;

    try {
      const head = await reader.headTree(repo, ref);

      if (head.truncated) {
        problems.push(`${readKeyText(key)}: GitHub listed only part of the repo's files`);
        continue;
      }

      for (const skill of group) {
        const headMd = skillMdIn({ tree: head.entries }, skill.source.path);

        if (headMd === undefined) {
          problems.push(
            `${skill.name}: its folder holds no SKILL.md at the head of ${first.source.repo}`,
          );
          continue;
        }

        let installed = skill.folderHash;

        if (installed === null) {
          const treeKey = readKey(first.source.repo, skill.source.commit);
          let tree = installedTrees.get(treeKey);

          if (tree === undefined) {
            tree = reader.tree(repo, skill.source.commit);
            installedTrees.set(treeKey, tree);
          }

          // A commit GitHub no longer has (a force-push) leaves this Skill alone, not the others of the repo and ref.
          let why = "";

          const at = await tree.catch((cause: unknown) => {
            if (Schema.is(GithubReadError)(cause) && cause.kind !== "rate_limited") {
              why = `: ${cause.message}`;

              return undefined;
            }

            throw cause;
          });

          const atMd =
            at === undefined || at.truncated
              ? undefined
              : skillMdIn({ tree: at.entries }, skill.source.path);

          if (at === undefined || atMd === undefined) {
            problems.push(
              `${skill.name}: its folder at the installed commit could not be read${why}`,
            );
            continue;
          }

          installed = await folderHashOf({ tree: at.entries }, atMd);
          skills.recordFound(skill.scope, skill.name, skill.source.commit, {
            folderHash: installed,
          });
        }

        const moved = (await folderHashOf({ tree: head.entries }, headMd)) !== installed;

        checked += 1;

        if (moved && !skill.updateAvailable) marked += 1;

        if (!moved && skill.updateAvailable) cleared += 1;

        skills.recordFound(skill.scope, skill.name, skill.source.commit, {
          updateAvailable: moved,
        });
      }
    } catch (cause) {
      if (Schema.is(GithubReadError)(cause)) {
        problems.push(`${readKeyText(key)}: ${cause.message}`);

        if (cause.kind === "rate_limited")
          return { checked, marked, cleared, problems, rateLimited: true };

        continue;
      }

      throw cause;
    }
  }

  return { checked, marked, cleared, problems, rateLimited: false };
};

/**
 * Run the daily check (`checkSkillUpdates`) if it is due: at most once a day (`SKILL_CHECK_DOCUMENT` keeps when it last
 * ran), and only when some Skill has a source. The run is claimed before GitHub is read, so two calls at once make one;
 * one the rate limit ended is due again in an hour. Says nothing (undefined) when it is not due.
 */
export const runDailySkillCheck = async (
  {
    skills,
    documents,
  }: {
    readonly skills: Pick<Skills, "listSourced" | "recordFound">;
    readonly documents: {
      readonly getDocument: (name: string) => string | null;
      readonly putDocument: (name: string, body: string, now: number) => void;
    };
  },
  reader: RepoReader,
  now: number,
): Promise<SkillCheck | undefined> => {
  const last = Number(documents.getDocument(SKILL_CHECK_DOCUMENT) ?? "0");

  if (now - last < SKILL_CHECK_INTERVAL_MS || skills.listSourced().length === 0) return undefined;

  documents.putDocument(SKILL_CHECK_DOCUMENT, String(now), now);

  const retrySoon = () => {
    documents.putDocument(
      SKILL_CHECK_DOCUMENT,
      String(now - SKILL_CHECK_INTERVAL_MS + SKILL_CHECK_RETRY_MS),
      now,
    );
  };

  try {
    const check = await checkSkillUpdates(skills, reader);

    if (check.rateLimited) retrySoon();

    return check;
  } catch (cause) {
    // An error that is not GitHub's answer (the caller logs it) is tried again in an hour, not tomorrow.
    retrySoon();

    throw cause;
  }
};
