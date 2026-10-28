// Installing Skills from GitHub into an Environment (ADR-0026, `docs/spec.md` → _Installing from GitHub_): fetch the
// source's Skills at one commit (`../github/skill-fetch.ts`), then keep each as a save keeps a Skill, with its Skill
// source (repo, the Skill's path, the ref named, the commit). The agent's install records each Skill it keeps as an Agent
// change; the owner's, from the Environments page, as the owner's save, records none. The fetch is the only part that
// asks GitHub, and runs before any transaction: each Skill is kept in a transaction of its own, so one the checks refuse
// leaves the others installed.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import type { AgentChange, ListedSkill, SkillSource } from "@cloudpid/protocol";
import { fetchSkills, type RepoReader } from "../github/skill-fetch.ts";
import { parseSkillSource } from "../github/skill-source.ts";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import { hashFiles, keepSkillAsOwner, saveSkillAs, type SkillChangeContext } from "./skills.ts";
import type { EnvironmentRecord } from "./store.ts";

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
};

export type SkillInstallation =
  | { readonly status: "missing" }
  /** Nothing was installed: the source is not one, GitHub gave no answer, or the repo holds no such Skill. */
  | { readonly status: "refused"; readonly message: string }
  /** The source holds several Skills and none was named: the list, and nothing installed. */
  | {
      readonly status: "listed";
      readonly environment: EnvironmentRecord;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
  | {
      readonly status: "installed";
      readonly environment: EnvironmentRecord;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly results: ReadonlyArray<InstalledSkill>;
    };

/**
 * Install into `environment` the Skills of `source` that `skills` names (`["*"]` for every one it holds; absent: the only
 * one it holds, else the list of them), read through `reader` at one commit. By `author` as Agent changes, or with no
 * author as the owner's install, which records none. The caller hands the Session's own Workspace the new Skill set after.
 */
export const installSkills = async (
  context: SkillChangeContext,
  reader: RepoReader,
  input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly author: AgentChangeAuthor | null;
  },
): Promise<SkillInstallation> => {
  const { environment, author } = input;
  const record = context.store.getEnvironment(environment);

  if (record === null) return { status: "missing" };

  const parsed = parseSkillSource(input.source);

  if (!parsed.ok) return { status: "refused", message: parsed.message };

  const fetched = await fetchSkills(reader, { source: parsed.source, skills: input.skills });

  if (fetched.status === "failed") return { status: "refused", message: fetched.message };

  const { repo, ref, commit } = fetched;

  if (fetched.status === "listed") {
    return {
      status: "listed",
      environment: record,
      repo,
      ref,
      commit,
      available: fetched.available,
    };
  }

  // Hashing is not synchronous, so every Skill's files are hashed before any is kept.
  const hashed = await Promise.all(fetched.skills.map(async (skill) => hashFiles(skill.files)));
  const results: InstalledSkill[] = [];

  fetched.skills.forEach((skill, at) => {
    const source: SkillSource = { repo, path: skill.path, ref, commit };

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
        : saveSkillAs(context, { ...toKeep, author });

    switch (kept.status) {
      case "saved":
        {
          const saved = {
            name: skill.name,
            path: skill.path,
            outcome: "installed" as const,
            shadows: kept.bundled,
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

  return { status: "installed", environment: record, repo, ref, commit, results };
};
