// The Workspace DO's side of skills, Prompt templates and project instructions (docs/spec.md → Filesystem and tools):
// finding them next to the files, so a Session's request is one RPC, and keeping what a Workspace had at the skills'
// mount before the mount existed.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import type { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import { posixCode, type ReadEnv } from "@cloudpid/computer-env";
import { discoverSkills, type Skill, skillsOfFiles } from "@cloudpid/extensions/skills-discovery";
import {
  discoverInstructions,
  type InstructionFile,
} from "@cloudpid/extensions/agents-md-discovery";
import { discoverPrompts, type PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import * as Effect from "effect/Effect";
import { SKILLS_MOUNT } from "./binding.ts";
import type { SkillSet } from "./skill-set.ts";

/**
 * How many parsed Skill sets an isolate keeps: its Workspaces may each hold another set, and a set is fixed for its
 * hash, so one parse serves every Workspace that holds it.
 */
const PARSED_SETS = 16;

/** The Skills of the sets last asked for, by hash and mount, the least recently asked first. */
const parsed = new Map<string, ReadonlyArray<Skill>>();

const byPathSegments = (a: string, b: string): number => {
  const left = a.split("/");
  const right = b.split("/");

  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }

  return left.length - right.length;
};

/**
 * The Skills `set` mounts at `mount`, read from the set in memory instead of from the mounted files. The mount is
 * read-only and holds exactly the set the Workspace holds (`skillSetMount` copies it again when its hash changes), so
 * this is what a walk of the mount finds, without a listing and a read per Skill. Parsed once per hash, so asking costs
 * nothing.
 */
export const mountedSkills = (
  set: SkillSet,
  mount: string = SKILLS_MOUNT,
): ReadonlyArray<Skill> => {
  const key = `${set.hash}\0${mount}`;
  const known = parsed.get(key);

  if (known !== undefined) {
    parsed.delete(key);
    parsed.set(key, known);

    return known;
  }

  const skills = skillsOfFiles(
    mount,
    // In the order a walk of the mount lists them (by name, directory by directory), whatever order the set has.
    Object.entries(set.files).sort(([a], [b]) => byPathSegments(a, b)),
  );

  parsed.set(key, skills);

  for (const oldest of parsed.keys()) {
    if (parsed.size <= PARSED_SETS) break;

    parsed.delete(oldest);
  }

  return skills;
};

/**
 * The skills a conversation in `env`'s `cwd` can use. Everything above the Workspace root's `.agents/skills` is walked
 * in process (a listing and the reads of each skill, next to the storage); the Skill set the Workspace holds is not
 * walked at all.
 */
export const discoverWorkspaceSkills = (
  env: ReadEnv,
  set: SkillSet,
): Promise<ReadonlyArray<Skill>> =>
  Effect.runPromise(discoverSkills(env, new Map([[SKILLS_MOUNT, mountedSkills(set)]])));

/** The Prompt templates of `env`'s `cwd` and the directories above it, walked in process as the skills are. */
export const discoverWorkspacePrompts = (env: ReadEnv): Promise<ReadonlyArray<PromptTemplate>> =>
  Effect.runPromise(discoverPrompts(env));

/** The project instructions for the files of `directory`, read in process from the Workspace root down. */
export const discoverWorkspaceInstructions = (
  env: ReadEnv,
  directory: string,
): Promise<ReadonlyArray<InstructionFile>> =>
  Effect.runPromise(discoverInstructions(env, directory));

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
 * read-only, so what is there is the Skill set's and is left to computer, which replaces it when the set changes.
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
    `${SKILLS_MOUNT} is the Skills' read-only mount now: what the Workspace had there was moved to ${target}`,
  );

  return target;
};
