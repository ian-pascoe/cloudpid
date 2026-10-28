// The Skills kept for an Environment, and for every Environment (ADR-0026, `docs/architecture/workspace.md` → The Environment's own Skills):
// kept in the Registry DO's SQLite, each file's text once per content hash (`skill_files`), shared by the Skills kept
// now (`skills`, by scope, an Environment's id or `*` for every Environment, and name) and the Agent changes that saved
// or removed one (their files before and after, by hash, under the same scope). Text that neither refers to any more is
// dropped when the history is pruned. The Registry merges an Environment's own Skills over those kept for every
// Environment, into the Skill set its Workspaces serve (empty where none is kept), and
// hands it to a Workspace whose set's hash differs. Synchronous over SQLite, as the store is, but for the hashes, which
// are made before a transaction.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off
import {
  MAX_FILE_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  problemsIn,
  skillNameProblem,
} from "@cloudpid/extensions/skill-checks";
import { MAX_SKILLS, readFrontmatter } from "@cloudpid/extensions/skills-discovery";
import {
  type AgentChange,
  EVERY_ENVIRONMENT_SCOPE,
  fieldSkill,
  SkillChangeValue,
  type SkillExpectation,
  type SkillFile,
  skillField,
  SkillSource,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { SkillSet } from "../workspace/skill-set-schema.ts";
import type { AgentChangeAuthor, AgentChangeRevert, AgentChanges } from "./agent-changes.ts";
import { type SecretScope, scopeOf } from "./secret-changes.ts";
import type { EnvironmentRecord, RegistryStorage } from "./store.ts";

/** A Skill's files: each one's path in the Skill's folder (`SKILL.md`, `references/x.md`), with its text. */
export type SkillFiles = Readonly<Record<string, string>>;

/** A Skill's files by path, each as the hash of its content. */
export type HashedFiles = Readonly<Record<string, string>>;

/** A Skill's files hashed: each one's hash by path, and the texts by hash. */
export type Hashed = {
  readonly files: HashedFiles;
  readonly contents: ReadonlyMap<string, string>;
};

/** A Skill kept for a scope (an Environment's id). Times are epoch milliseconds. */
export type StoredSkill = {
  readonly name: string;
  readonly description: string;
  readonly files: HashedFiles;
  /** Where it was installed from (migration 23); null for one that was never installed. A save from a Workspace keeps the source it had. */
  readonly source: SkillSource | null;
  /**
   * Whether the agent saved over it since it was installed (migration 24): an update refuses it unless asked to
   * overwrite. Only a Skill with a source is.
   */
  readonly modified: boolean;
  /**
   * A digest of the git blob SHAs of the files its source's folder holds at the source's commit (`folderHashOf`), what
   * the daily check compares the ref's head with. Null until it is recorded (an install and an update record it; the
   * check fills it in for a Skill kept before).
   */
  readonly folderHash: string | null;
  /** Whether the daily check found the folder changed at the ref's head. */
  readonly updateAvailable: boolean;
  readonly savedAt: number;
};

type SkillRow = {
  name: string;
  description: string;
  files: string;
  source: string | null;
  modified: number;
  folder_hash: string | null;
  update_available: number;
  saved_at: number;
};

const COLUMNS =
  "name, description, files, source, modified, folder_hash, update_available, saved_at";

const decodeFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(SkillSource));

const toSkill = (row: SkillRow): StoredSkill => ({
  name: row.name,
  description: row.description,
  // Only ever written from a record of strings.
  files: Option.getOrElse(decodeFiles(row.files), () => ({})),
  source: row.source === null ? null : Option.getOrNull(decodeSource(row.source)),
  modified: row.modified !== 0,
  folderHash: row.folder_hash,
  updateAvailable: row.update_available !== 0,
  savedAt: row.saved_at,
});

/** Whether two Skill sources are the same: the same repo, path, ref and commit (both none counts). */
export const sameSource = (left: SkillSource | null, right: SkillSource | null): boolean =>
  left === null || right === null
    ? left === right
    : left.repo === right.repo &&
      left.path === right.path &&
      left.ref === right.ref &&
      left.commit === right.commit;

const hex = (buffer: ArrayBuffer): string =>
  Arr.join(
    Arr.map([...new Uint8Array(buffer)], (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/** The hash a text is kept under: SHA-256 of its UTF-8 bytes, in hex. */
export const contentHash = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** The size of `text` in UTF-8 bytes. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** `files` hashed, for a save: made before the transaction that keeps them, as hashing is not synchronous. */
export const hashFiles = async (files: SkillFiles): Promise<Hashed> => {
  const entries = await Promise.all(
    Arr.map(
      Record.toEntries(files),
      async ([path, text]) => [path, await contentHash(text), text] as const,
    ),
  );

  return {
    files: Object.fromEntries(Arr.map(entries, ([path, hash]) => [path, hash])),
    contents: new Map(Arr.map(entries, ([, hash, text]) => [hash, text])),
  };
};

/** Whether two Skills' files are the same: the same paths, with the same contents. */
export const sameFiles = (left: HashedFiles, right: HashedFiles): boolean =>
  Record.size(left) === Record.size(right) &&
  Arr.every(Record.toEntries(left), ([path, hash]) => right[path] === hash);

/**
 * Drop each file's text that no Skill kept now and no Agent change kept refers to: a Skill's change records its files
 * before and after by hash (`SkillChangeValue`), under a `skills.<name>` field.
 */
export const dropUnreferencedSkillFiles = (sql: SqlStorage): void => {
  sql.exec(`DELETE FROM skill_files WHERE hash NOT IN (
    SELECT files.value FROM skills, json_each(skills.files) AS files
    UNION SELECT files.value FROM agent_changes, json_each(agent_changes.before, '$.files') AS files
      WHERE agent_changes.field LIKE 'skills.%' AND agent_changes.before IS NOT NULL
    UNION SELECT files.value FROM agent_changes, json_each(agent_changes.after, '$.files') AS files
      WHERE agent_changes.field LIKE 'skills.%' AND agent_changes.after IS NOT NULL
  )`);
};

/** The Skills the Registry keeps, by scope (an Environment's id) and name, and their files' texts by hash. */
export type Skills = {
  /** The Skills kept for `scope`, by name. */
  readonly list: (scope: string) => ReadonlyArray<StoredSkill>;
  /** The Skill `name` kept for `scope`, or null. */
  readonly get: (scope: string, name: string) => StoredSkill | null;
  /** Every Skill that has a source, in any scope (an Environment's id, or `*`), for the daily check. */
  readonly listSourced: () => ReadonlyArray<StoredSkill & { readonly scope: string }>;
  /**
   * Record what the daily check or an update found of Skill `name` of `scope`, without touching its files or when it was
   * saved: the folder's hash at its source's commit, and whether an update is available. Only while the Skill still has
   * `commit` as its source's (it may have been saved again since the check read it); says whether it did.
   */
  readonly recordFound: (
    scope: string,
    name: string,
    commit: string,
    found: {
      readonly folderHash?: string | undefined;
      readonly updateAvailable?: boolean | undefined;
    },
  ) => boolean;
  /**
   * Keep `skill` for `scope` in place of one of its name, with the texts of its files that are not kept yet. A Skill that
   * says nothing of its marks and folder hash is kept without them.
   */
  readonly put: (
    scope: string,
    skill: Omit<StoredSkill, "savedAt" | "modified" | "folderHash" | "updateAvailable"> &
      Partial<Pick<StoredSkill, "modified" | "folderHash" | "updateAvailable">>,
    contents: ReadonlyMap<string, string>,
    now: number,
  ) => void;
  /** Stop keeping Skill `name` for `scope`; says whether it was kept. Its files' texts stay until nothing refers to them. */
  readonly remove: (scope: string, name: string) => boolean;
  /** The texts kept under `hashes`; a hash with none kept is left out. */
  readonly contents: (hashes: Iterable<string>) => ReadonlyMap<string, string>;
  /** The size in UTF-8 bytes of each text kept under `hashes`; a hash with none kept is left out. */
  readonly sizes: (hashes: Iterable<string>) => ReadonlyMap<string, number>;
};

/** The Skills over the Registry's storage, once it is migrated (`openRegistryStore`: migration 22). */
export const openSkills = ({ sql }: Pick<RegistryStorage, "sql">): Skills => ({
  list: (scope) =>
    Arr.map(
      sql
        .exec<SkillRow>(`SELECT ${COLUMNS} FROM skills WHERE scope = ? ORDER BY name`, scope)
        .toArray(),
      toSkill,
    ),
  get: (scope, name) => {
    const [row] = sql
      .exec<SkillRow>(`SELECT ${COLUMNS} FROM skills WHERE scope = ? AND name = ?`, scope, name)
      .toArray();

    return row === undefined ? null : toSkill(row);
  },
  listSourced: () =>
    Arr.map(
      sql
        .exec<SkillRow & { scope: string }>(
          `SELECT scope, ${COLUMNS} FROM skills WHERE source IS NOT NULL ORDER BY scope, name`,
        )
        .toArray(),
      (row) => ({ scope: row.scope, ...toSkill(row) }),
    ),
  recordFound: (scope, name, commit, { folderHash, updateAvailable }) => {
    const [row] = sql
      .exec<SkillRow>(`SELECT ${COLUMNS} FROM skills WHERE scope = ? AND name = ?`, scope, name)
      .toArray();

    if (row === undefined || toSkill(row).source?.commit !== commit) return false;

    if (folderHash !== undefined) {
      sql.exec(
        "UPDATE skills SET folder_hash = ? WHERE scope = ? AND name = ?",
        folderHash,
        scope,
        name,
      );
    }

    if (updateAvailable !== undefined) {
      sql.exec(
        "UPDATE skills SET update_available = ? WHERE scope = ? AND name = ?",
        updateAvailable ? 1 : 0,
        scope,
        name,
      );
    }

    return true;
  },
  put: (scope, skill, contents, now) => {
    // One row per text keeps each row below the 2 MB a row may hold: a file is at most 1.5 MiB.
    for (const hash of new Set(Record.values(skill.files))) {
      const text = contents.get(hash);

      if (text !== undefined) {
        sql.exec("INSERT OR IGNORE INTO skill_files (hash, content) VALUES (?, ?)", hash, text);
      }
    }

    sql.exec(
      `INSERT INTO skills (scope, name, description, files, source, modified, folder_hash, update_available, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, name) DO UPDATE SET description = excluded.description, files = excluded.files,
         source = excluded.source, modified = excluded.modified, folder_hash = excluded.folder_hash,
         update_available = excluded.update_available, saved_at = excluded.saved_at`,
      scope,
      skill.name,
      skill.description,
      JSON.stringify(skill.files),
      skill.source === null ? null : JSON.stringify(skill.source),
      skill.modified === true ? 1 : 0,
      skill.folderHash ?? null,
      skill.updateAvailable === true ? 1 : 0,
      now,
    );
  },
  remove: (scope, name) =>
    sql.exec("DELETE FROM skills WHERE scope = ? AND name = ?", scope, name).rowsWritten > 0,
  contents: (hashes) => {
    const found = new Map<string, string>();

    for (const hash of new Set(hashes)) {
      const [row] = sql
        .exec<{ content: string }>("SELECT content FROM skill_files WHERE hash = ?", hash)
        .toArray();

      if (row !== undefined) found.set(hash, row.content);
    }

    return found;
  },
  sizes: (hashes) => {
    const found = new Map<string, number>();

    for (const hash of new Set(hashes)) {
      const [row] = sql
        .exec<{ size: number }>(
          "SELECT length(CAST(content AS BLOB)) AS size FROM skill_files WHERE hash = ?",
          hash,
        )
        .toArray();

      if (row !== undefined) found.set(hash, row.size);
    }

    return found;
  },
});

/**
 * Why `path` is not a file's path in a Skill's folder: segments joined by `/`, none empty, `.` or `..`, and no `\`, as a
 * walk of the mount lists them.
 */
const pathProblem = (path: string): string | undefined => {
  if (path.includes("\\")) return `${path}: a path may not hold a backslash`;

  return Arr.some(
    path.split("/"),
    (segment) => segment === "" || segment === "." || segment === "..",
  )
    ? `${path}: a path may not hold an empty, \`.\` or \`..\` segment`
    : undefined;
};

/** What a `SKILL.md` declares: its name and description, or why they are not a Skill's. */
const declaredSkill = (
  text: string,
): { readonly name: string; readonly description: string } | { readonly problem: string } => {
  const frontmatter = readFrontmatter(text);

  if (frontmatter === undefined) {
    return {
      problem:
        "SKILL.md has no YAML frontmatter: it must start with a --- block that sets name and description",
    };
  }

  const { name, description } = frontmatter;

  if (!Predicate.isString(name)) return { problem: "SKILL.md's frontmatter sets no name" };

  if (!Predicate.isString(description) || description.trim() === "") {
    return { problem: "SKILL.md's frontmatter sets no description" };
  }

  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return {
      problem: `SKILL.md's description is ${description.length} characters, more than the ${MAX_SKILL_DESCRIPTION_LENGTH} a Skill's may be`,
    };
  }

  return { name, description };
};

/** A Skill a save may keep: its name and description, from its `SKILL.md`. */
export type CheckedSkill = { readonly name: string; readonly description: string };

/**
 * The Skill in folder `folder` with `files`, as a save checks it (ADR-0026): a `SKILL.md` whose frontmatter names it by
 * the Agent Skills rules (the folder's own name) and describes it in at most 1024 characters, and files that are text,
 * at most 1.5 MiB each and 4 MiB together, with nothing that looks like a credential or a local path. Each problem is a
 * line of the answer.
 */
export const checkSkill = (
  folder: string,
  files: SkillFiles,
):
  | { readonly ok: true; readonly skill: CheckedSkill }
  | { readonly ok: false; readonly message: string } => {
  const problems: string[] = [];
  const skillMd = files["SKILL.md"];

  let skill: CheckedSkill | undefined;

  if (skillMd === undefined) {
    problems.push("The folder holds no SKILL.md");
  } else {
    const declared = declaredSkill(skillMd);

    if ("problem" in declared) {
      problems.push(declared.problem);
    } else {
      const nameProblem = skillNameProblem(declared.name);

      if (nameProblem !== undefined) problems.push(`SKILL.md's name: ${nameProblem}`);
      else if (declared.name !== folder) {
        problems.push(
          `SKILL.md's name is ${JSON.stringify(declared.name)}, but its folder is ${JSON.stringify(folder)}: they must be the same`,
        );
      } else skill = declared;
    }
  }

  let total = 0;
  const encoder = new TextEncoder();

  for (const [path, text] of Record.toEntries(files)) {
    const bytes = encoder.encode(text);
    total += bytes.length;

    const problem = pathProblem(path);

    if (problem !== undefined) problems.push(problem);

    problems.push(...problemsIn(path, bytes));
  }

  if (total > MAX_SKILL_BYTES) {
    problems.push(
      `The files are ${total} bytes together, more than the ${MAX_SKILL_BYTES} a Skill may be (and ${MAX_FILE_BYTES} each)`,
    );
  }

  return skill === undefined || problems.length > 0
    ? { ok: false, message: Arr.join(problems, "\n") }
    : { ok: true, skill };
};

/**
 * A Skill set as the Registry merges it, before its texts are read: its hash, the names of its Skills, and each file's
 * content hash by its path under the mount.
 */
export type MergedSkills = {
  readonly hash: string;
  readonly names: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly hash: string }>;
};

/**
 * The layers of `environment`'s Skill set, nearest first: its own Skills, then those kept for every Environment (an
 * Environment's own of a name hides the one kept for every Environment). The Skills kept for every Environment are the
 * only layer of their own scope.
 */
export const skillLayers = (
  skills: Skills,
  environment: string,
): ReadonlyArray<ReadonlyArray<StoredSkill>> =>
  environment === EVERY_ENVIRONMENT_SCOPE
    ? [skills.list(EVERY_ENVIRONMENT_SCOPE)]
    : [skills.list(environment), skills.list(EVERY_ENVIRONMENT_SCOPE)];

/**
 * The Skill set of `layers` (the scopes' Skills, nearest first: an Environment's own, then those kept for every
 * Environment): a Skill of a nearer layer hides the others of its name. Its hash is that of every file's path and
 * content hash, in order, so with no Skill in any layer it is the empty set's (`EMPTY_SKILL_SET_HASH`), and a Workspace
 * that holds the empty set is handed nothing.
 */
export const mergeSkills = async (
  layers: ReadonlyArray<ReadonlyArray<Pick<StoredSkill, "name" | "files">>>,
): Promise<MergedSkills> => {
  const taken = new Set<string>();
  const entries: Array<MergedSkills["entries"][number]> = [];

  for (const layer of layers) {
    for (const skill of layer) {
      if (taken.has(skill.name)) continue;

      taken.add(skill.name);

      for (const [path, hash] of Record.toEntries(skill.files)) {
        entries.push({ path: `${skill.name}/${path}`, hash });
      }
    }
  }

  const ordered = Arr.sort(
    entries,
    Order.mapInput(Order.String, (entry: MergedSkills["entries"][number]) => entry.path),
  );

  return {
    hash: await contentHash(
      Arr.join(
        Arr.map(ordered, ({ path, hash }) => `${path}\0${hash}\n`),
        "",
      ),
    ),
    names: [...taken],
    entries: ordered,
  };
};

/** The Skill set `merged` describes, with its texts from `skills`. */
export const skillSetOf = (merged: MergedSkills, skills: Skills): SkillSet => {
  const kept = skills.contents(Arr.map(merged.entries, ({ hash }) => hash));

  return {
    hash: merged.hash,
    // A text that is not kept (which the pruning never leaves) is left out rather than served empty.
    files: Object.fromEntries(
      Arr.flatMap(merged.entries, ({ path, hash }) => {
        const text = kept.get(hash);

        return text === undefined ? [] : [[path, text] as const];
      }),
    ),
  };
};

/**
 * The most UTF-8 bytes an Environment's Skill set may hold: the whole set goes to a Workspace in one Durable Object
 * call, and each Workspace keeps a copy.
 */
export const MAX_SKILL_SET_BYTES = 8 * 1024 * 1024;

/** A Skill as a set counts it: its name and files. */
type Counted = Pick<StoredSkill, "name" | "files">;

/** A Skill a layer would hold in place of the one of its name, or none (`files: null`: it is taken out). */
type Change = { readonly name: string; readonly files: HashedFiles | null };

/** `kept` with `change` made to it. */
const withChange = (kept: ReadonlyArray<Counted>, change: Change): ReadonlyArray<Counted> => [
  ...Arr.filter(kept, ({ name }) => name !== change.name),
  ...(change.files === null ? [] : [{ name: change.name, files: change.files }]),
];

/**
 * Why a set of `layers` (nearest first, a Skill of a nearer layer hiding the others of its name) is too large, saying
 * whose it is (`who`), or undefined when it is not: more than `MAX_SKILLS` Skills, or more than `MAX_SKILL_SET_BYTES`.
 * `contents` holds the texts of the files not kept yet.
 */
const sizeProblem = (
  skills: Skills,
  who: string,
  layers: ReadonlyArray<ReadonlyArray<Counted>>,
  contents: ReadonlyMap<string, string>,
): string | undefined => {
  const served = new Map<string, Counted>();

  for (const layer of layers) {
    for (const skill of layer) if (!served.has(skill.name)) served.set(skill.name, skill);
  }

  if (served.size > MAX_SKILLS) {
    return `${who} would hold ${served.size} Skills, more than the ${MAX_SKILLS} a set may`;
  }

  const hashes = Arr.flatMap([...served.values()], (kept) => Record.values(kept.files));
  const sizes = skills.sizes(hashes);

  const bytes = Arr.reduce(hashes, 0, (total, hash) => {
    const text = contents.get(hash);

    return total + (sizes.get(hash) ?? (text === undefined ? 0 : utf8Bytes(text)));
  });

  return bytes > MAX_SKILL_SET_BYTES
    ? `${who} would be ${bytes} bytes, more than the ${MAX_SKILL_SET_BYTES} a set may`
    : undefined;
};

/** The part of the Registry a check of the Skill sets reads. */
type SetContext = {
  readonly store: Pick<SkillStore, "listEnvironments">;
  readonly skills: Skills;
};

/**
 * Why the Skill sets are refused once `change` is made to the Skills kept in `scope` (an Environment's id, or `*`), or
 * undefined when they are not: more than `MAX_SKILLS` Skills, or more than `MAX_SKILL_SET_BYTES`, every layer counted
 * (`contents`: the texts of the files not kept yet). A change to an Environment's Skills checks that
 * Environment's set; one to those kept for every Environment checks every Environment's, and the set of an
 * Environment keeping none of its own, and the message names the first that would pass, as ADR-0023 does for variables.
 */
const setProblem = (
  { store, skills }: SetContext,
  scope: string,
  change: Change,
  contents: ReadonlyMap<string, string> = new Map(),
): string | undefined => {
  const every = skills.list(EVERY_ENVIRONMENT_SCOPE);

  if (scope !== EVERY_ENVIRONMENT_SCOPE) {
    return sizeProblem(
      skills,
      "The Environment's Skill set",
      [withChange(skills.list(scope), change), every],
      contents,
    );
  }

  const kept = withChange(every, change);

  // An Environment with none of its own Skills (a new one, or one that removes its override) serves these alone.
  const alone = sizeProblem(
    skills,
    "The Skill set of an Environment keeping none of its own Skills",
    [kept],
    contents,
  );

  if (alone !== undefined) return alone;

  for (const { id, name } of store.listEnvironments()) {
    const problem = sizeProblem(
      skills,
      `Environment ${JSON.stringify(name)} (${id})'s Skill set`,
      [skills.list(id), kept],
      contents,
    );

    if (problem !== undefined) return problem;
  }

  return undefined;
};

/** Why bringing a Skill in is refused: the problem, and what to do about it. */
const refusedToKeep = (problem: string): string => `${problem}: remove a Skill first`;

/**
 * Why taking Skill `name` out of `scope` is refused, or undefined when it is not. Taking a Skill out only grows a set
 * where the Skill of its name kept for every Environment, which an Environment's own Skill hides, is served in its
 * place, so that is what is checked: the sets that would then be served. A Skill kept for every Environment hides
 * nothing.
 */
const refusedToTakeOut = (context: SetContext, scope: string, name: string): string | undefined => {
  const { skills } = context;

  const exposed =
    scope !== EVERY_ENVIRONMENT_SCOPE && skills.get(EVERY_ENVIRONMENT_SCOPE, name) !== null;

  const problem = exposed ? setProblem(context, scope, { name, files: null }) : undefined;

  return problem === undefined
    ? undefined
    : `${problem} once the Skill of the name in the layer below, which ${name} hides, is served instead: remove another Skill first`;
};

/**
 * A Skill's files, where it was installed from if it was, and whether it was marked modified, as an Agent change records
 * them: a revert puts all three back.
 */
const changeValue = ({
  files,
  source,
  modified,
}: Pick<StoredSkill, "files" | "source" | "modified">): SkillChangeValue => {
  const value = { files: { ...files } };

  if (source === null) return value;

  // Only an installed Skill is ever marked.
  return modified ? { ...value, source, modified } : { ...value, source };
};

const decodeChangeValue = Schema.decodeUnknownOption(SkillChangeValue);

/**
 * Why the Registry refuses an agent's change to the Skills kept for every Environment that was made with no Approval, or
 * undefined when it may go on. The Session asks the owner first and passes what they were shown (`expected`, or an
 * install's `pin`), so a call without it is not one that asked: a second guard, for a caller that skips the first.
 */
export const unapprovedEveryChange = (scope: string, approved: boolean): string | undefined =>
  scope === EVERY_ENVIRONMENT_SCOPE && !approved
    ? "a change to the Skills kept for every Environment is made only against what the owner approved (no Approval was passed): nothing was changed"
    : undefined;

/** The files an Agent change of a Skill records, or null where there were none (or the value is not a Skill's). */
export const changeFiles = (value: AgentChange["before"]): HashedFiles | null =>
  value === null
    ? null
    : Option.getOrNull(Option.map(decodeChangeValue(value), ({ files }) => files));

/** An Environment, or every Environment (id `*`), as a Skill's change names it. */
export type SkillScope = SecretScope;

/** The Skill source an Agent change of a Skill records, or null where it recorded none. */
export const changeSource = (value: AgentChange["before"]): SkillSource | null =>
  value === null
    ? null
    : Option.getOrNull(Option.map(decodeChangeValue(value), ({ source }) => source ?? null));

/** Whether an Agent change of a Skill records the Skill as marked modified. */
export const changeModified = (value: AgentChange["before"]): boolean =>
  value === null
    ? false
    : Option.getOrElse(
        Option.map(decodeChangeValue(value), ({ modified }) => modified === true),
        () => false,
      );

/** How the agent's save of a Skill went. */
export type SkillSave =
  | {
      readonly status: "saved";
      readonly environment: SkillScope;
      readonly change: AgentChange;
      readonly skill: StoredSkill;
      /** Whether it is an Environment's own Skill that hides the one of the name kept for every Environment. */
      readonly inherited: boolean;
      /**
       * For a Skill kept for every Environment: the Environments whose own Skill of the name hides it, so it does not
       * reach them. None for an Environment's own.
       */
      readonly overriddenIn: ReadonlyArray<SkillScope>;
    }
  /** The scope holds the Skill with these files already: nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly environment: SkillScope }
  /** The Skill of the name was saved again since the owner was asked (`expected`): nothing was saved or recorded. */
  | { readonly status: "changed-since"; readonly environment: SkillScope }
  /** The Skill is not one a save keeps, each problem a line: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** How the agent's removal of a Skill went. */
export type SkillRemoval =
  | {
      readonly status: "removed";
      readonly environment: SkillScope;
      readonly change: AgentChange;
      /** Whether the Skill of the name kept for every Environment is served in its place, for an Environment's own. */
      readonly inherited: boolean;
      /** For a Skill kept for every Environment: the Environments whose own Skill of the name stays served there. */
      readonly overriddenIn: ReadonlyArray<SkillScope>;
    }
  /** The scope keeps no Skill of the name: nothing was recorded. */
  | { readonly status: "absent"; readonly environment: SkillScope }
  /** The Skill of the name was saved again since the owner was asked (`expected`): nothing was removed or recorded. */
  | { readonly status: "changed-since"; readonly environment: SkillScope }
  /** Removing it would serve a Skill from the layer below that does not fit: nothing was removed or recorded. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** A Skill the agent would save, checked as a save checks it, with what the scope keeps of the name. */
export type SkillPreview =
  | {
      /** `ready`: a save would keep it. `unchanged`: the scope keeps the Skill with these files already. */
      readonly status: "ready" | "unchanged";
      readonly environment: SkillScope;
      readonly name: string;
      readonly description: string;
      /** The Skill of the name the scope keeps now, with its files' paths. Null for a new Skill. */
      readonly current: {
        readonly description: string;
        readonly savedAt: number;
        readonly files: ReadonlyArray<string>;
      } | null;
    }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** The part of the store a Skill's change uses. */
export type SkillStore = {
  readonly getEnvironment: (id: string) => EnvironmentRecord | null;
  readonly listEnvironments: () => ReadonlyArray<EnvironmentRecord>;
};

/**
 * What a change of a Skill reads and writes: the Registry's storage (for the transaction) and store, the Skills kept,
 * the Agent changes, and the time of the change.
 */
export type SkillChangeContext = {
  readonly storage: Pick<RegistryStorage, "transactionSync">;
  readonly store: SkillStore;
  readonly skills: Skills;
  readonly changes: AgentChanges;
  readonly now: number;
};

/** A Skill to keep: its folder, its files (hashed beforehand), and where it was installed from, if it was. */
export type SkillToKeep = {
  /** An Environment's id, or `*` for every Environment. */
  readonly environment: string;
  readonly folder: string;
  readonly files: SkillFiles;
  readonly hashed: Hashed;
  /**
   * Where it was installed from, when it is installed or updated: the Skill is then as its source has it, so it is not
   * modified, and nothing is waiting for an update. Absent for a save from a Workspace, which keeps the source the Skill
   * had and marks a Skill that has one **modified**.
   */
  readonly source?: SkillSource | undefined;
  /** With `source`: the hash of the folder at its commit (`folderHashOf`), which the daily check compares with. */
  readonly folderHash?: string | undefined;
};

/** A save of a Skill that was checked: what the scope keeps of the name (`before`) and what the save would keep. */
type SavePlan =
  | {
      readonly status: "ready" | "unchanged";
      readonly environment: SkillScope;
      readonly name: string;
      readonly description: string;
      readonly before: StoredSkill | null;
    }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/**
 * Check the save of `skill` (its files hashed beforehand, `hashFiles`): as `checkSkill` checks it, refused when a Skill
 * set would hold more than `MAX_SKILLS` Skills or `MAX_SKILL_SET_BYTES` (those of every Environment, for one kept for
 * every Environment). The same files as kept (and the same source, when one is given) are `unchanged`, and not refused
 * for the size.
 */
const planSave = (
  { store, skills }: Pick<SkillChangeContext, "store" | "skills">,
  { environment, folder, files, hashed, source }: SkillToKeep,
): SavePlan => {
  const scope = scopeOf(environment, store);

  if (scope === null) return { status: "missing" };

  const checked = checkSkill(folder, files);

  if (!checked.ok) return { status: "rejected", message: checked.message };

  const { name, description } = checked.skill;
  const before = skills.get(environment, name);

  if (
    before !== null &&
    sameFiles(before.files, hashed.files) &&
    (source === undefined || (sameSource(before.source, source) && !before.modified))
  ) {
    return { status: "unchanged", environment: scope, name, description, before };
  }

  const problem = setProblem(
    { store, skills },
    environment,
    { name, files: hashed.files },
    hashed.contents,
  );

  return problem === undefined
    ? { status: "ready", environment: scope, name, description, before }
    : { status: "rejected", message: refusedToKeep(problem) };
};

/**
 * Keep the Skill a `ready` plan describes, in place of one of its name. With a source it is as that source has it: not
 * modified, no update waiting. Without one the source it had is kept and, if it had one, the Skill is marked modified.
 */
const keepPlanned = (
  { skills, now }: Pick<SkillChangeContext, "skills" | "now">,
  { environment, hashed, source, folderHash }: SkillToKeep,
  { name, description, before }: Extract<SavePlan, { status: "ready" | "unchanged" }>,
): StoredSkill => {
  const kept: Omit<StoredSkill, "savedAt"> =
    source === undefined
      ? {
          name,
          description,
          files: hashed.files,
          source: before?.source ?? null,
          modified: (before?.source ?? null) !== null,
          folderHash: before?.folderHash ?? null,
          updateAvailable: before?.updateAvailable ?? false,
        }
      : {
          name,
          description,
          files: hashed.files,
          source,
          modified: false,
          folderHash: folderHash ?? null,
          updateAvailable: false,
        };

  skills.put(environment, kept, hashed.contents, now);

  return { ...kept, savedAt: now };
};

/**
 * What a save of the Skill in folder `folder` with `files` for `environment` would do, checked as the save checks it,
 * with nothing saved or recorded: the agent's Approval card shows it before the owner is asked.
 */
export const previewSkillSave = (
  context: Pick<SkillChangeContext, "store" | "skills">,
  input: SkillToKeep,
): SkillPreview => {
  const plan = planSave(context, input);

  if (plan.status === "rejected" || plan.status === "missing") return plan;

  const { status, environment, name, description, before } = plan;

  return {
    status,
    environment,
    name,
    description,
    current:
      before === null
        ? null
        : {
            description: before.description,
            savedAt: before.savedAt,
            files: Arr.sort(Record.keys(before.files), Order.String),
          },
  };
};

/**
 * The agent saves the Skill in folder `folder` with `files` (hashed beforehand, `hashFiles`) for `environment` (an
 * Environment's id, or `*` for every Environment), in place of one of its name: checked as `previewSkillSave` checks
 * it; installed from GitHub when `source` is given. Recorded as an Agent change by `author` under the same scope, with
 * the files before (none for a new Skill) and after; the same files as kept record nothing. With `expected`, only while
 * the Skill of the name was last saved then (`null`: none kept), which the owner's Approval was asked against.
 */
export const saveSkillAs = (
  context: SkillChangeContext,
  input: SkillToKeep & {
    readonly author: AgentChangeAuthor;
    readonly expected?: SkillExpectation | undefined;
  },
): SkillSave =>
  context.storage.transactionSync((): SkillSave => {
    const { author, environment, expected } = input;
    const plan = planSave(context, input);

    if (plan.status === "rejected" || plan.status === "missing") return plan;

    const { before } = plan;

    if (plan.status === "unchanged") return { status: "unchanged", environment: plan.environment };

    if (expected !== undefined && (before?.savedAt ?? null) !== expected.savedAt) {
      return { status: "changed-since", environment: plan.environment };
    }

    const skill = keepPlanned(context, input, plan);

    const change = context.changes.record({
      scope: environment,
      at: context.now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: skillField(skill.name),
      before: before === null ? null : changeValue(before),
      after: changeValue(skill),
      reverts: null,
      approved: author.approved,
    });

    return {
      status: "saved",
      environment: plan.environment,
      change,
      skill,
      ...layersAround(context, environment, skill.name),
    };
  });

/**
 * What a change to Skill `name` in `scope` (an Environment's id, or `*`) meets in the layers around it, once it is made:
 * whether the Skill of the name kept for every Environment does, for an Environment's own (`inherited`), and, for one
 * kept for every Environment, the Environments whose own Skill of the name hides it (`overriddenIn`).
 */
const layersAround = (
  { store, skills }: SetContext & { readonly store: SkillStore },
  scope: string,
  name: string,
) => {
  const everywhere = scope === EVERY_ENVIRONMENT_SCOPE;

  return {
    inherited: !everywhere && skills.get(EVERY_ENVIRONMENT_SCOPE, name) !== null,
    overriddenIn: everywhere
      ? Arr.flatMap(store.listEnvironments(), ({ id, name: environmentName }) =>
          skills.get(id, name) === null ? [] : [{ id, name: environmentName }],
        )
      : [],
  };
};

/**
 * The owner installs a Skill from the Environments page: kept as `saveSkillAs` keeps it, and, as the owner's removal,
 * not an Agent change.
 */
export const keepSkillAsOwner = (
  context: Omit<SkillChangeContext, "changes">,
  input: SkillToKeep,
): SkillKept =>
  context.storage.transactionSync((): SkillKept => {
    const plan = planSave(context, input);

    if (plan.status === "rejected" || plan.status === "missing") return plan;

    if (plan.status === "unchanged") return { status: "unchanged", environment: plan.environment };

    const skill = keepPlanned(context, input, plan);

    return {
      status: "saved",
      environment: plan.environment,
      skill,
      ...layersAround(context, input.environment, skill.name),
    };
  });

/** How the owner's install of a Skill went: as the agent's save, with no Agent change. */
export type SkillKept =
  | (Omit<Extract<SkillSave, { status: "saved" }>, "change"> & { readonly change?: undefined })
  | Extract<SkillSave, { status: "unchanged" | "rejected" | "missing" }>;

/**
 * The agent removes Skill `name` kept for `environment` (an Environment's id, or `*`), recorded as an Agent change by
 * `author` with its files before. With `expected`, only while it was last saved then, which the owner's Approval was
 * asked against.
 */
export const removeSkillAs = (
  { storage, store, skills, changes, now }: SkillChangeContext,
  {
    environment,
    name,
    author,
    expected,
  }: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
    readonly expected?: SkillExpectation | undefined;
  },
): SkillRemoval =>
  storage.transactionSync((): SkillRemoval => {
    const scope = scopeOf(environment, store);

    if (scope === null) return { status: "missing" };

    const before = skills.get(environment, name);

    if (before === null) return { status: "absent", environment: scope };

    if (expected !== undefined && before.savedAt !== expected.savedAt) {
      return { status: "changed-since", environment: scope };
    }

    const problem = refusedToTakeOut({ store, skills }, environment, name);

    if (problem !== undefined) return { status: "rejected", message: problem };

    skills.remove(environment, name);

    const change = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: skillField(name),
      before: changeValue(before),
      after: null,
      reverts: null,
      approved: author.approved,
    });

    return {
      status: "removed",
      environment: scope,
      change,
      ...layersAround({ store, skills }, environment, name),
    };
  });

/** How the owner's removal of a Skill went. */
export type OwnerRemoval =
  | { readonly status: "removed" | "absent" }
  /** Removing it would serve a Skill from the layer below that does not fit: nothing was removed. */
  | { readonly status: "rejected"; readonly message: string };

/**
 * The owner removes Skill `name` kept for `environment` (an Environment's id, or `*`) from the Environments page, as an
 * owner's save: not an Agent change, and no Approval, but refused as an agent's removal is when it would serve a Skill
 * from the layer below that does not fit. Says whether it was kept; the texts no Skill or change refers to any more are
 * dropped.
 */
export const removeSkill = (
  {
    storage,
    store,
    skills,
  }: Pick<SkillChangeContext, "storage" | "store" | "skills"> & {
    readonly storage: RegistryStorage;
  },
  { environment, name }: { readonly environment: string; readonly name: string },
): OwnerRemoval =>
  storage.transactionSync((): OwnerRemoval => {
    if (skills.get(environment, name) === null) return { status: "absent" };

    const problem = refusedToTakeOut({ store, skills }, environment, name);

    if (problem !== undefined) return { status: "rejected", message: problem };

    skills.remove(environment, name);
    dropUnreferencedSkillFiles(storage.sql);

    return { status: "removed" };
  });

/** A Skill's files as `hashes`, with their texts, by path; one whose text is not kept is left out. */
const filesOf = (skills: Skills, hashes: HashedFiles | null): ReadonlyArray<SkillFile> | null => {
  if (hashes === null) return null;

  const texts = skills.contents(Record.values(hashes));

  return Arr.flatMap(
    Arr.sort(
      Record.toEntries(hashes),
      Order.mapInput(Order.String, ([path]: readonly [string, string]) => path),
    ),
    ([path, hash]) => {
      const text = texts.get(hash);

      return text === undefined ? [] : [{ path, text }];
    },
  );
};

/** The files before and after Agent change `change` of a Skill, with their texts; null for a change of another field. */
export const skillChangeFiles = (
  skills: Skills,
  change: AgentChange,
): {
  readonly before: ReadonlyArray<SkillFile> | null;
  readonly after: ReadonlyArray<SkillFile> | null;
} | null =>
  fieldSkill(change.field) === null
    ? null
    : {
        before: filesOf(skills, changeFiles(change.before)),
        after: filesOf(skills, changeFiles(change.after)),
      };

/** The description `SKILL.md`'s text gives, for a Skill a revert brings back. */
const descriptionOf = (text: string | undefined): string => {
  const declared = text === undefined ? undefined : declaredSkill(text);

  return declared === undefined || "problem" in declared ? "" : declared.description;
};

/**
 * The owner's revert of `change`, a save or removal of Skill `name` in `environment` (an Environment's id, or `*` for
 * every Environment): the files before written back (a save of a new Skill is removed, a removal brings the Skill
 * back), recorded as the owner's change, under the same scope. It is the owner's own save, so it waits for no Approval.
 * Refused when the Skill no longer has the files the change gave it, or bringing it back would take a Skill set (every
 * Environment's, for the scope `*`) past its limits.
 */
export const revertSkillChange = (
  { store, skills, changes, now }: Pick<SkillChangeContext, "store" | "skills" | "changes" | "now">,
  environment: string,
  change: AgentChange,
): AgentChangeRevert => {
  const name = fieldSkill(change.field);

  if (name === null) return { status: "missing" };

  const current = skills.get(environment, name);
  const after = changeFiles(change.after);
  const before = changeFiles(change.before);
  const beforeSource = changeSource(change.before);
  const beforeModified = changeModified(change.before);

  const unchanged =
    current === null
      ? after === null
      : after !== null &&
        sameFiles(current.files, after) &&
        sameSource(current.source, changeSource(change.after));

  if (!unchanged) {
    return {
      status: "refused",
      message:
        current === null
          ? `The Skill ${name} has been removed since, so the change is not reverted`
          : `The Skill ${name} has been saved again since, so the change is not reverted`,
    };
  }

  if (before === null) {
    const problem = refusedToTakeOut({ store, skills }, environment, name);

    if (problem !== undefined) return { status: "refused", message: `Not reverted: ${problem}` };

    skills.remove(environment, name);
  } else {
    const problem = setProblem({ store, skills }, environment, { name, files: before });

    if (problem !== undefined) {
      return { status: "refused", message: `Not reverted: ${refusedToKeep(problem)}` };
    }

    const texts = skills.contents(Record.values(before));

    // Back at the same commit (a save's revert) the folder's hash and the mark it has are kept. At another commit what
    // they would be is not known (the ref may be anywhere from it), so they are left to the next check, which records the
    // hash again from the tree at that commit and marks the Skill if its ref has moved.
    const sameCommit = current?.source?.commit === beforeSource?.commit;

    skills.put(
      environment,
      {
        name,
        description: descriptionOf(texts.get(before["SKILL.md"] ?? "")),
        files: before,
        source: beforeSource,
        modified: beforeModified,
        folderHash: sameCommit ? (current?.folderHash ?? null) : null,
        updateAvailable: sameCommit ? (current?.updateAvailable ?? false) : false,
      },
      texts,
      now,
    );
  }

  const recorded = changes.record({
    scope: environment,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: `Reverted change ${change.id}${change.tool === null ? "" : ` (${change.tool})`}`,
    field: change.field,
    before: current === null ? null : changeValue(current),
    after:
      before === null
        ? null
        : changeValue({ files: before, source: beforeSource, modified: beforeModified }),
    reverts: change.id,
  });

  return { status: "reverted", change: recorded };
};
