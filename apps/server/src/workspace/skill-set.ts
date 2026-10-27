// The Skill set a Workspace holds (ADR-0026): the files its read-only mount at `/workspace/.agents/skills` serves and its
// Skill discovery reads, with their content hash. It is kept in the Workspace DO's own storage, and is the bundle
// (`BUNDLED_SKILLS`) until one is handed over (`Workspace.updateSkills`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { type EagerMount, WorkerBundle } from "@cloudflare/computer";
import * as Predicate from "effect/Predicate";
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

/** The mount serving `set`, as computer's `WorkerBundle`: it throws on a path that leaves the mount, or names a file and a directory. */
const bundleOf = (set: SkillSet): EagerMount =>
  WorkerBundle({ version: set.hash, files: set.files });

// @effect-diagnostics-next-line schemaSync:off -- the Workspace DO's methods are plain async: a set it cannot decode is refused by throwing, as an RPC error.
const decodeSkillSet = Schema.decodeUnknownSync(SkillSet);

/**
 * `set` as the mount would serve it, or an error saying why it cannot be: a set comes over RPC, so its shape is decoded,
 * and its paths are checked as the mount checks them, before anything is kept.
 */
export const checkSkillSet = (set: SkillSet): SkillSet => {
  const decoded = decodeSkillSet(set);

  bundleOf(decoded);

  return decoded;
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

    /** Keep `set` in place of the one held, in one transaction. */
    replace: (set: SkillSet): void => {
      storage.transactionSync(() => {
        for (const [key] of storage.kv.list({ prefix: FILE_PREFIX })) storage.kv.delete(key);

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
 * holds the bundle is not copied again.
 */
export const skillSetMount = (current: () => SkillSet): EagerMount => ({
  kind: "skill-set",
  mode: "read-only",
  strategy: "eager",
  version: async () => current().hash,
  materialize: (api) => bundleOf(current()).materialize(api),
});
