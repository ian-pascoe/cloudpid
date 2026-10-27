// The Skill set a Workspace holds (ADR-0026): the files its read-only mount at `/workspace/.agents/skills` serves and its
// Skill discovery reads, with their content hash. It is kept in the Workspace DO's own storage, and is the bundle
// (`BUNDLED_SKILLS`) until one is handed over (`Workspace.updateSkills`).
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { type EagerMount, type MountWriteAPI, WorkerBundle } from "@cloudflare/computer";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";

/**
 * A set of Skills as the mount serves it: each file's text by its path under the mount (`<skill>/SKILL.md`, …), and a
 * hash of the contents, which says whether two sets differ without comparing their files.
 */
export const SkillSet = Schema.Struct({
  hash: Schema.NonEmptyString,
  files: Schema.Record(Schema.String, Schema.String),
});

export type SkillSet = typeof SkillSet.Type;

/** The Skills bundled with this Worker (`skills/`), with the hash computer recorded for the mount before sets existed. */
export const BUNDLED_SKILL_SET: SkillSet = {
  // SAFETY: the generator always writes a version (`bundled-skills.test.ts` recomputes it).
  hash: BUNDLED_SKILLS.version!,
  // Every file of the bundle is a `?raw` import, a string.
  files: Object.fromEntries(
    Object.entries(BUNDLED_SKILLS.files).flatMap(([path, content]) =>
      Predicate.isString(content) ? [[path, content] as const] : [],
    ),
  ),
};

/** What a hand-over of a Skill set answers: whether the Workspace holds it now, or why not. */
export type SkillSetAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** The mount serving `set`, as computer's `WorkerBundle`. Making it throws when a path names a file and a directory. */
const bundleOf = (set: SkillSet): EagerMount =>
  WorkerBundle({ version: set.hash, files: set.files });

/** Writes `set` under the mount's root, as computer's `WorkerBundle` would. */
export const writeSkillSet = (set: SkillSet, api: MountWriteAPI): Promise<void> =>
  bundleOf(set).materialize(api);

/**
 * Why `path` is not a file's path under the mount as a walk of it lists it: segments joined by `/`, none empty, `.` or
 * `..`, and no `\`. computer would normalize some of these, so discovery would list a path the mount does not have.
 */
const pathProblem = (path: string): string | undefined => {
  if (path.includes("\\")) return "has a backslash";

  const segments = path.split("/");

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "has an empty, `.` or `..` segment";
  }

  return undefined;
};

const decodeSkillSet = Schema.decodeUnknownResult(SkillSet);

/**
 * `set` as the mount would serve it, or why it cannot be: a set comes over RPC, so its shape is decoded, and its paths
 * are checked before anything is kept.
 */
export const checkSkillSet = (
  set: SkillSet,
):
  | { readonly ok: true; readonly set: SkillSet }
  | { readonly ok: false; readonly message: string } => {
  const decoded = decodeSkillSet(set);

  if (Result.isFailure(decoded)) {
    return { ok: false, message: `Not a Skill set: ${decoded.failure.message}` };
  }

  for (const path of Object.keys(decoded.success.files)) {
    const problem = pathProblem(path);

    if (problem !== undefined) return { ok: false, message: `Skill file path ${path} ${problem}` };
  }

  try {
    // Only for its check that no path names both a file and a directory.
    bundleOf(decoded.success);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }

  return { ok: true, set: decoded.success };
};

/** Where the held set's hash is kept; absent, the Workspace holds the bundle. */
const HASH_KEY = "cloudpid:skills:hash";

/** Where each file of the held set is kept, under `<prefix><path>`: one entry per file keeps each value small. */
const FILE_PREFIX = "cloudpid:skills:file:";

export type SkillSetStorage = {
  readonly kv: SyncKvStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
};

/** The Skill set kept in `storage`, read once per instance and replaced as a whole. */
export const skillSetStore = (storage: SkillSetStorage) => {
  let held: SkillSet | undefined;

  const load = (): SkillSet => {
    const hash = storage.kv.get<string>(HASH_KEY);

    if (hash === undefined) return BUNDLED_SKILL_SET;

    const files: Record<string, string> = {};

    for (const [key, content] of storage.kv.list<string>({ prefix: FILE_PREFIX })) {
      files[key.slice(FILE_PREFIX.length)] = content;
    }

    return { hash, files };
  };

  return {
    /** The set the Workspace holds. */
    current: (): SkillSet => (held ??= load()),

    /**
     * Keep `set` in place of the one held, in one transaction. The bundle is kept as nothing, so a deploy that changes
     * the bundle reaches a Workspace that holds it.
     */
    replace: (set: SkillSet): void => {
      storage.transactionSync(() => {
        for (const [key] of storage.kv.list({ prefix: FILE_PREFIX })) storage.kv.delete(key);

        if (set.hash === BUNDLED_SKILL_SET.hash) {
          storage.kv.delete(HASH_KEY);

          return;
        }

        for (const [path, content] of Object.entries(set.files)) {
          storage.kv.put(`${FILE_PREFIX}${path}`, content);
        }

        storage.kv.put(HASH_KEY, set.hash);
      });

      held = set;
    },
  };
};

/**
 * The read-only mount of the set `current` answers: its version is the set's hash, so computer copies the files again
 * (clearing the mount first) only when the hash differs from the one it recorded, at the first index of each instance
 * and at each `remount()`. The bundle's hash is the version the mount had before sets existed, so a Workspace that
 * holds the bundle is not copied again. `write` writes a set's files (`writeSkillSet`; a test Worker makes it fail).
 */
export const skillSetMount = (
  current: () => SkillSet,
  write: (set: SkillSet, api: MountWriteAPI) => Promise<void>,
): EagerMount => ({
  kind: "skill-set",
  mode: "read-only",
  strategy: "eager",
  version: async () => current().hash,
  materialize: (api) => write(current(), api),
});
