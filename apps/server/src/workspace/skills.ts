// The Workspace DO's side of skills (docs/spec.md → Filesystem and tools): finding them next to the files, so a Session's
// request is one RPC, and keeping what a Workspace had at the bundled skills' mount before the mount existed.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import type { Workspace as ComputerWorkspace, WorkerBundleSource } from "@cloudflare/computer";
import { posixCode, type ReadEnv } from "@cloudpid/computer-env";
import { discoverSkills, type Skill, skillsOfFiles } from "@cloudpid/extensions/skills-discovery";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { SKILLS_MOUNT } from "./binding.ts";

/** The bundled skills of the version last asked for: a bundle is fixed for the life of the Worker's code. */
let cached: { readonly version: string; readonly skills: ReadonlyArray<Skill> } | undefined;

/**
 * The skills `bundle` mounts at `mount`, read from the bundle in memory instead of from the mounted files. The mount is
 * read-only and holds exactly the bundle (`WorkerBundle` copies it again when its version changes), so this is what a
 * walk of the mount finds, without a listing and a read per skill. Parsed once per version, so asking costs nothing.
 */
export const bundledSkills = (
  bundle: WorkerBundleSource,
  mount: string = SKILLS_MOUNT,
): ReadonlyArray<Skill> => {
  const version = bundle.version;

  if (version !== undefined && cached?.version === version) return cached.skills;

  const skills = skillsOfFiles(
    mount,
    Object.entries(bundle.files).flatMap(([path, content]) =>
      Predicate.isString(content) ? [[path, content] as const] : [],
    ),
  );

  if (version !== undefined) cached = { version, skills };

  return skills;
};

/**
 * The skills a conversation in `env`'s `cwd` can use. Everything above the Workspace root's `.agents/skills` is walked
 * in process (a listing and the reads of each skill, next to the storage); the bundled skills are not walked at all.
 */
export const discoverWorkspaceSkills = (
  env: ReadEnv,
  bundle: WorkerBundleSource,
): Promise<ReadonlyArray<Skill>> =>
  Effect.runPromise(discoverSkills(env, new Map([[SKILLS_MOUNT, bundledSkills(bundle)]])));

/**
 * Where a Workspace's own files at the skills' mount are kept: the directory beside it. It is not a skills directory,
 * so nothing discovers what is in it.
 */
export const PRIOR_SKILLS = `${SKILLS_MOUNT}.pre-bundle`;

const lstatOf = async (fs: PriorSkillsOptions["fs"], path: string) => {
  try {
    return await fs.lstat(path);
  } catch (cause) {
    if (posixCode(cause) === "ENOENT") return undefined;

    throw cause;
  }
};

export type PriorSkillsOptions = {
  readonly fs: Pick<ComputerWorkspace["fs"], "lstat" | "readdir" | "rename">;
  /** Whether the Workspace has indexed the mount before: it replaces whatever is at the mount when it first does. */
  readonly indexed: () => boolean;
  readonly warn: (message: string) => void;
};

/**
 * What is at the mount before the Workspace first indexes it is the Workspace's own (an agent wrote a skill there before
 * the bundled skills existed). computer clears a mount's root when it indexes it, so those files are moved to
 * `PRIOR_SKILLS` first, unless there are none (no directory, or an empty one). A mount that was indexed once is
 * read-only, so what is there is the bundle's and is left to computer, which replaces it when the bundle changes.
 * Returns where the files went.
 */
export const keepPriorSkills = async (options: PriorSkillsOptions): Promise<string | undefined> => {
  const { fs } = options;

  if (options.indexed()) return undefined;

  const stat = await lstatOf(fs, SKILLS_MOUNT);

  if (stat === undefined) return undefined;

  if (stat.isDirectory && (await fs.readdir(SKILLS_MOUNT)).length === 0) return undefined;

  let target = PRIOR_SKILLS;

  for (let attempt = 2; (await lstatOf(fs, target)) !== undefined; attempt++) {
    target = `${PRIOR_SKILLS}-${attempt}`;
  }

  await fs.rename(SKILLS_MOUNT, target);

  options.warn(
    `${SKILLS_MOUNT} is the bundled skills' read-only mount now: what the Workspace had there was moved to ${target}`,
  );

  return target;
};
