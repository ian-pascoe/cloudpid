// Installing Skills from GitHub into an Environment (ADR-0026, `docs/spec.md` → _Installing from GitHub_): fetch the
// source's Skills at one commit (`../github/skill-fetch.ts`), then keep each as a save keeps a Skill, with its Skill
// source (repo, the Skill's path, the ref named, the commit). The agent's install records each Skill it keeps as an Agent
// change; the owner's, from the Environments page, as the owner's save, records none. The fetch is the only part that
// asks GitHub, and runs before any transaction: each Skill is kept in a transaction of its own, so one the checks refuse
// leaves the others installed.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import type {
  AgentChange,
  ListedSkill,
  PreviewedSkill,
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
  previewSkillSave,
  saveSkillAs,
  type SkillChangeContext,
  type SkillScope,
} from "./skills.ts";

/** How the install of one Skill went. */
export type InstalledSkill = {
  readonly name: string;
  /** Its folder in the repo. */
  readonly path: string;
  readonly outcome: "installed" | "unchanged" | "rejected";
  /** Why it was refused. */
  readonly message?: string;
  /** The Agent change that kept it (the agent's install only). */
  readonly change?: AgentChange;
  /** Whether it hides the bundle's Skill of the name. */
  readonly shadows?: boolean;
  /** For a Skill kept for every Environment: the Environments whose own Skill of the name hides it. */
  readonly overriddenIn?: ReadonlyArray<SkillScope>;
};

export type SkillInstallation =
  | { readonly status: "missing" }
  /** Nothing was installed: the source is not one, GitHub gave no answer, or the repo holds no such Skill. */
  | { readonly status: "refused"; readonly message: string }
  /** The source holds several Skills and none was named: the list, and nothing installed. */
  | {
      readonly status: "listed";
      readonly environment: SkillScope;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
  | {
      readonly status: "installed";
      readonly environment: SkillScope;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly results: ReadonlyArray<InstalledSkill>;
    };

/** A digest of a Skill's files by their content hashes: what an Approval pins of a Skill. */
const digestOf = (files: HashedFiles): Promise<string> =>
  contentHash(
    JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  );

/** Why a Skill the owner was asked about was not installed after all. */
const SAVED_AGAIN =
  "the Skill of the name was saved again since the user was asked: nothing was installed. Ask again";

const NOT_SHOWN =
  "it is not the Skill the user was shown (the repo's Skill of that name differs from the one on the card): nothing was installed. Ask again";

/** What an install or its preview is asked for. */
type Asked = {
  readonly environment: string;
  readonly source: string;
  readonly skills?: ReadonlyArray<string> | undefined;
};

/**
 * Read the Skills `input` asks for through `reader`, at `commit` when one is given, or answer why there are none to
 * keep: no such Environment, a source that is no source, GitHub's refusal, or a list to choose from.
 */
const fetchFor = async (
  context: Pick<SkillChangeContext, "store">,
  reader: RepoReader,
  input: Asked & { readonly commit?: string | undefined },
) => {
  const scope = scopeOf(input.environment, context.store);

  if (scope === null) return { status: "missing" } as const;

  const parsed = parseSkillSource(input.source);

  if (!parsed.ok) return { status: "refused", message: parsed.message } as const;

  const fetched = await fetchSkills(reader, {
    source: parsed.source,
    skills: input.skills,
    commit: input.commit,
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
 * Install into `environment` (an Environment's id, or `*` for every Environment) the Skills of `source` that `skills`
 * names (`["*"]` for every one it holds; absent: the only one it holds, else the list of them), read through `reader` at
 * one commit. By `author` as Agent changes, or with no author as the owner's install, which records none. The caller
 * hands the Session's own Workspace the new Skill set after.
 *
 * `pin` is what an Approval was asked against: the Skills are read at its `commit`, and a Skill is kept only when it is
 * one the pin names, from the same folder with the same files, and only while the Skill of its name was last saved when the
 * pin says (null: none kept). Anything else the read gives is reported, and kept nowhere.
 */
export const installSkills = async (
  context: SkillChangeContext,
  reader: RepoReader,
  input: Asked & {
    readonly author: AgentChangeAuthor | null;
    readonly pin?: SkillInstallPin | undefined;
  },
): Promise<SkillInstallation> => {
  const { environment, author, pin } = input;
  const got = await fetchFor(context, reader, { ...input, commit: pin?.commit });

  if (got.status !== "fetched") return got;

  const { scope, repo, ref, commit, fetched } = got;
  // Hashing is not synchronous, so every Skill's files are hashed before any is kept.
  const hashed = await Promise.all(fetched.skills.map(async (skill) => hashFiles(skill.files)));
  const digests = await Promise.all(hashed.map(async ({ files }) => digestOf(files)));
  const results: InstalledSkill[] = [];

  fetched.skills.forEach((skill, at) => {
    const source: SkillSource = { repo, path: skill.path, ref, commit };
    const shown = pin?.skills.find(({ name }) => name === skill.name);

    if (pin !== undefined && (shown?.path !== skill.path || shown.digest !== digests[at])) {
      results.push({ name: skill.name, path: skill.path, outcome: "rejected", message: NOT_SHOWN });

      return;
    }

    const toKeep = {
      environment,
      folder: skill.name,
      files: skill.files,
      // SAFETY: `hashed` holds one entry for each of `fetched.skills`, in order, and `at` indexes the latter.
      hashed: hashed[at] as (typeof hashed)[number],
      source,
    };

    const kept =
      author === null
        ? keepSkillAsOwner(context, toKeep)
        : saveSkillAs(context, {
            ...toKeep,
            author,
            expected: shown === undefined ? undefined : { savedAt: shown.savedAt },
          });

    switch (kept.status) {
      case "saved":
        {
          const saved = {
            name: skill.name,
            path: skill.path,
            outcome: "installed" as const,
            shadows: kept.bundled,
            overriddenIn: kept.overriddenIn,
          };

          results.push(kept.change === undefined ? saved : { ...saved, change: kept.change });
        }

        break;
      case "unchanged":
        results.push({ name: skill.name, path: skill.path, outcome: "unchanged" });
        break;
      case "rejected":
        results.push({
          name: skill.name,
          path: skill.path,
          outcome: "rejected",
          message: kept.message,
        });
        break;
      case "changed-since":
        results.push({
          name: skill.name,
          path: skill.path,
          outcome: "rejected",
          message: SAVED_AGAIN,
        });
        break;
      // The Environment was removed while the Skills were fetched.
      case "missing":
        results.push({
          name: skill.name,
          path: skill.path,
          outcome: "rejected",
          message: "the Environment no longer exists",
        });
        break;
    }
  });

  for (const skipped of fetched.skipped) {
    results.push({
      name: skipped.name,
      path: skipped.path,
      outcome: "rejected",
      message: skipped.message,
    });
  }

  return { status: "installed", environment: scope, repo, ref, commit, results };
};

/**
 * What `installSkills` would do with the same source and Skills, checked as it checks them, with nothing kept or
 * recorded: the Approval card of an install for every Environment shows it before the owner is asked.
 */
export const previewSkillInstall = async (
  context: Pick<SkillChangeContext, "store" | "skills" | "bundle">,
  reader: RepoReader,
  input: Asked,
): Promise<SkillInstallPreview> => {
  const got = await fetchFor(context, reader, input);

  if (got.status !== "fetched") return got;

  const { scope, repo, ref, commit, fetched } = got;
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

  return { status: "previewed", environment: scope, repo, ref, commit, skills, rejected };
};
