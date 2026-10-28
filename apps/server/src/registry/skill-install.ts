// Installing Skills from GitHub into an Environment, or Global (ADR-0026, `docs/architecture/workspace.md` →
// _Installing from GitHub_): fetch the source's Skills at one commit (`../github/skill-fetch.ts`), then keep each as a save keeps a Skill, with its Skill
// source (repo, the Skill's path, the ref named, the commit). The agent's install records each Skill it keeps as an Agent
// change; the owner's, from the Skills page, as the owner's save, records none. The fetch is the only part that
// asks GitHub, and runs before any transaction: each Skill is kept in a transaction of its own, so one the checks refuse
// leaves the others installed. An install the owner approved (`pin`) reads exactly the folders they were shown.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import { MAX_APPROVED_SKILLS } from "@cloudpid/extensions/skill-checks";
import type {
  InstalledSkill,
  PreviewedSkill,
  SkillInstallation,
  SkillInstallPin,
  SkillInstallPreview,
  SkillSource,
} from "@cloudpid/protocol";
import { fetchSkills, type RepoReader } from "../github/skill-fetch.ts";
import { parseSkillSource } from "../github/skill-source.ts";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import { scopeOf } from "./secret-changes.ts";
import {
  contentHash,
  type HashedFiles,
  hashFiles,
  keepSkillAsOwner,
  previewSizeProblem,
  previewSkillSave,
  saveSkillAs,
  type SkillChangeContext,
} from "./skills.ts";

/** A digest of a Skill's files by their content hashes: what an Approval pins of a Skill. */
const digestOf = (files: HashedFiles): Promise<string> =>
  contentHash(
    JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  );

/** Why a Skill the owner was asked about was not installed after all. */
const SAVED_AGAIN =
  "the Skill of the name was saved again since the user was asked: nothing was installed. Ask again";

const NOT_SHOWN =
  "its files are not the ones the user was shown (the folder changed since the card): nothing was installed. Ask again";

const NOT_FOUND =
  "the folder the user was shown holds no Skill at that commit: nothing was installed. Ask again";

/** What an install or its preview is asked for. */
type InstallRequest = {
  readonly environment: string;
  readonly source: string;
  readonly skills?: ReadonlyArray<string> | undefined;
  /**
   * Read exactly the Skills in these folders (`""` is the repo's root) instead of choosing by `skills`: what the owner
   * picked on a repo's page, where two folders can declare one name. An approved `pin` names its own folders and wins.
   */
  readonly folders?: ReadonlyArray<string> | undefined;
};

/**
 * Read the Skills `input` asks for through `reader`, or answer why there are none to keep: no such Environment, a source
 * that is no source, GitHub's refusal, or a list to choose from. With `pin`, exactly the folders it names are read, at its
 * commit, and whatever `skills` says is not used to choose; with `limit`, more Skills than that are refused before any
 * Skill's files are read.
 */
const readSkills = async (
  context: Pick<SkillChangeContext, "store">,
  reader: RepoReader,
  input: InstallRequest & {
    readonly pin?: SkillInstallPin | undefined;
    readonly limit?: number | undefined;
  },
) => {
  const scope = scopeOf(input.environment, context.store);

  if (scope === null) return { status: "missing" } as const;

  const parsed = parseSkillSource(input.source);

  if (!parsed.ok) return { status: "refused", message: parsed.message } as const;

  const { pin } = input;

  const fetched = await fetchSkills(reader, {
    source: parsed.source,
    skills: input.skills,
    commit: pin?.commit,
    folders: pin?.skills.map(({ path }) => path) ?? input.folders,
    limit: input.limit,
  });

  if (fetched.status === "failed") return { status: "refused", message: fetched.message } as const;

  const { repo, ref, commit } = fetched;

  if (fetched.status === "listed") {
    return {
      status: "listed",
      environment: scope,
      repo,
      ref,
      commit,
      available: fetched.available,
    } as const;
  }

  return { status: "fetched", scope, repo, ref, commit, fetched } as const;
};

/**
 * Install into `environment` (an Environment's id, or `*` at Global) the Skills of `source` that `skills`
 * names (`["*"]` for every one it holds; absent: the only one it holds, else the list of them), read through `reader` at
 * one commit. By `author` as Agent changes, or with no author as the owner's install, which records none. The caller
 * hands the Session's own Workspace the new Skill set after.
 *
 * `pin` is what an Approval was asked against: exactly the folders it names are read, at its commit, and each Skill is
 * kept only if its name and its files' digest are the ones shown, and only while the Skill of its name was last saved when
 * the pin says (null: none kept). There is one result for each Skill the pin names, in its order, and none for anything
 * else the repo holds.
 */
export const installSkills = async (
  context: SkillChangeContext,
  reader: RepoReader,
  input: InstallRequest & {
    readonly author: AgentChangeAuthor | null;
    readonly pin?: SkillInstallPin | undefined;
  },
): Promise<SkillInstallation> => {
  const { environment, author, pin } = input;
  const read = await readSkills(context, reader, input);

  if (read.status !== "fetched") return read;

  const { scope, repo, ref, commit, fetched } = read;
  // Hashing is not synchronous, so every Skill's files are hashed before any is kept.
  const hashed = await Promise.all(fetched.skills.map(async (skill) => hashFiles(skill.files)));
  const digests = await Promise.all(hashed.map(async ({ files }) => digestOf(files)));

  /** The result of keeping fetched Skill `at`, if it may be kept. `savedAt`: what an Approval was asked against. */
  const keep = (at: number, expected: { readonly savedAt: number | null } | undefined) => {
    // SAFETY: `fetched.skills`, `hashed` and `digests` have one entry each, in order, and `at` indexes them.
    const skill = fetched.skills[at] as (typeof fetched.skills)[number];
    const source: SkillSource = { repo, path: skill.path, ref, commit };

    const toKeep = {
      environment,
      folder: skill.name,
      files: skill.files,
      // SAFETY: as above.
      hashed: hashed[at] as (typeof hashed)[number],
      source,
      folderHash: skill.folderHash,
    };

    const kept =
      author === null
        ? keepSkillAsOwner(context, toKeep)
        : saveSkillAs(context, { ...toKeep, author, expected });

    const named = { name: skill.name, path: skill.path };

    switch (kept.status) {
      case "saved": {
        const saved = {
          ...named,
          outcome: "installed" as const,
          overriddenIn: kept.overriddenIn,
        };

        return kept.change === undefined ? saved : { ...saved, change: kept.change };
      }

      case "unchanged":
        return { ...named, outcome: "unchanged" as const };
      case "rejected":
        return { ...named, outcome: "rejected" as const, message: kept.message };
      case "changed-since":
        return { ...named, outcome: "rejected" as const, message: SAVED_AGAIN };
      // The Environment was removed while the Skills were fetched.
      case "missing":
        return {
          ...named,
          outcome: "rejected" as const,
          message: "the Environment no longer exists",
        };
    }
  };

  const results: InstalledSkill[] = [];

  if (pin === undefined) {
    fetched.skills.forEach((_skill, at) => {
      results.push(keep(at, undefined));
    });

    for (const skipped of fetched.skipped) {
      results.push({
        name: skipped.name,
        path: skipped.path,
        outcome: "rejected",
        message: skipped.message,
      });
    }
  } else {
    // One result for each Skill the owner was shown, whatever the repo holds now.
    for (const shown of pin.skills) {
      const at = fetched.skills.findIndex((skill) => skill.path === shown.path);
      const skipped = fetched.skipped.find((skip) => skip.path === shown.path);
      const named = { name: shown.name, path: shown.path };

      if (at < 0) {
        results.push({
          ...named,
          outcome: "rejected",
          message: skipped === undefined ? NOT_FOUND : skipped.message,
        });
      } else if (fetched.skills[at]?.name !== shown.name || digests[at] !== shown.digest) {
        results.push({ ...named, outcome: "rejected", message: NOT_SHOWN });
      } else {
        results.push(keep(at, { savedAt: shown.savedAt }));
      }
    }
  }

  return { status: "installed", environment: scope, repo, ref, commit, results };
};

/**
 * What `installSkills` would do with the same source and Skills, checked as it checks them, with nothing kept or
 * recorded: the Approval card of an install at Global shows it before the owner is asked. More than
 * `MAX_APPROVED_SKILLS` Skills are refused before any Skill's files are read.
 */
export const previewSkillInstall = async (
  context: Pick<SkillChangeContext, "store" | "skills">,
  reader: RepoReader,
  input: InstallRequest,
): Promise<SkillInstallPreview> => {
  const read = await readSkills(context, reader, { ...input, limit: MAX_APPROVED_SKILLS });

  if (read.status !== "fetched") return read;

  const { scope, repo, ref, commit, fetched } = read;
  const hashed = await Promise.all(fetched.skills.map(async (skill) => hashFiles(skill.files)));
  const digests = await Promise.all(hashed.map(async ({ files }) => digestOf(files)));
  const skills: PreviewedSkill[] = [];
  const rejected: Array<{ name: string; path: string; message: string }> = [];

  fetched.skills.forEach((skill, at) => {
    const source: SkillSource = { repo, path: skill.path, ref, commit };

    const preview = previewSkillSave(context, {
      environment: input.environment,
      folder: skill.name,
      files: skill.files,
      // SAFETY: `hashed` holds one entry for each of `fetched.skills`, in order, and `at` indexes the latter.
      hashed: hashed[at] as (typeof hashed)[number],
      source,
    });

    if (preview.status === "rejected") {
      rejected.push({ name: skill.name, path: skill.path, message: preview.message });
    } else if (preview.status === "missing") {
      rejected.push({
        name: skill.name,
        path: skill.path,
        message: "the Environment no longer exists",
      });
    } else {
      skills.push({
        name: skill.name,
        path: skill.path,
        description: skill.description,
        files: skill.files,
        // SAFETY: `digests` holds one entry for each of `fetched.skills`, in order, and `at` indexes the latter.
        digest: digests[at] as string,
        unchanged: preview.status === "unchanged",
        current: preview.current,
      });
    }
  });

  for (const skipped of fetched.skipped) rejected.push(skipped);

  const tooLarge = previewSizeProblem(skills.map(({ files }) => files));

  if (tooLarge !== undefined) return { status: "refused", message: tooLarge };

  return { status: "previewed", environment: scope, repo, ref, commit, skills, rejected };
};
