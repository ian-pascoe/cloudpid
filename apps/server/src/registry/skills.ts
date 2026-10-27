// An Environment's own Skills (ADR-0026, `docs/spec.md` → Agent changes → Skills): kept in the Registry DO's SQLite,
// each file's text once per content hash (`skill_files`), shared by the Skills kept now (`skills`, by scope and name) and
// the Agent changes that saved or removed one (their files before and after, by hash). Text that neither refers to any
// more is dropped when the history is pruned. The Registry merges an Environment's own Skills over the bundle (the
// lowest layer until it is removed) into the Skill set its Workspaces serve, and hands it to a Workspace whose set's
// hash differs. Synchronous over SQLite, as the store is, but for the hashes, which are made before a transaction.
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
  fieldSkill,
  SKILLS_ROOT,
  SkillChangeValue,
  type SkillFile,
  skillField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { SkillSet } from "../workspace/bundled-skill-set.ts";
import type { AgentChangeAuthor, AgentChangeRevert, AgentChanges } from "./agent-changes.ts";
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
  readonly savedAt: number;
};

type SkillRow = { name: string; description: string; files: string; saved_at: number };

const decodeFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const toSkill = (row: SkillRow): StoredSkill => ({
  name: row.name,
  description: row.description,
  // Only ever written from a record of strings.
  files: Option.getOrElse(decodeFiles(row.files), () => ({})),
  savedAt: row.saved_at,
});

const hex = (buffer: ArrayBuffer): string =>
  Arr.join(
    Arr.map([...new Uint8Array(buffer)], (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/** The hash a text is kept under: SHA-256 of its UTF-8 bytes, in hex. */
export const contentHash = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

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
  /** Keep `skill` for `scope` in place of one of its name, with the texts of its files that are not kept yet. */
  readonly put: (
    scope: string,
    skill: Omit<StoredSkill, "savedAt">,
    contents: ReadonlyMap<string, string>,
    now: number,
  ) => void;
  /** Stop keeping Skill `name` for `scope`; says whether it was kept. Its files' texts stay until nothing refers to them. */
  readonly remove: (scope: string, name: string) => boolean;
  /** The texts kept under `hashes`; a hash with none kept is left out. */
  readonly contents: (hashes: Iterable<string>) => ReadonlyMap<string, string>;
};

/** The Skills over the Registry's storage, once it is migrated (`openRegistryStore`: migration 22). */
export const openSkills = ({ sql }: Pick<RegistryStorage, "sql">): Skills => ({
  list: (scope) =>
    Arr.map(
      sql
        .exec<SkillRow>(
          "SELECT name, description, files, saved_at FROM skills WHERE scope = ? ORDER BY name",
          scope,
        )
        .toArray(),
      toSkill,
    ),
  get: (scope, name) => {
    const [row] = sql
      .exec<SkillRow>(
        "SELECT name, description, files, saved_at FROM skills WHERE scope = ? AND name = ?",
        scope,
        name,
      )
      .toArray();

    return row === undefined ? null : toSkill(row);
  },
  put: (scope, skill, contents, now) => {
    // One row per text keeps each row far below the 2 MB a row may hold: a file is at most 128 KB.
    for (const hash of new Set(Record.values(skill.files))) {
      const text = contents.get(hash);

      if (text !== undefined) {
        sql.exec("INSERT OR IGNORE INTO skill_files (hash, content) VALUES (?, ?)", hash, text);
      }
    }

    sql.exec(
      `INSERT INTO skills (scope, name, description, files, saved_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, name) DO UPDATE SET description = excluded.description, files = excluded.files,
         saved_at = excluded.saved_at`,
      scope,
      skill.name,
      skill.description,
      JSON.stringify(skill.files),
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

  if (!Predicate.isObject(frontmatter) || Arr.isArray(frontmatter)) {
    return {
      problem:
        "SKILL.md has no YAML frontmatter: it must start with a --- block that sets name and description",
    };
  }

  const { name, description } = frontmatter as {
    readonly name?: unknown;
    readonly description?: unknown;
  };

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
 * at most 128 KB each and 1 MB together, with nothing that looks like a credential or a local path. Each problem is a
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

/** The bundle, hashed once per isolate: its set, the names of its Skills, and each file's content hash by mount path. */
export type HashedBundle = {
  readonly set: SkillSet;
  readonly names: ReadonlySet<string>;
  readonly hashes: Readonly<Record<string, string>>;
};

/** The Skill a path under the mount belongs to: its first segment. */
const skillOf = (path: string): string => path.split("/", 1)[0] ?? path;

export const hashBundle = async (set: SkillSet): Promise<HashedBundle> => ({
  set,
  names: new Set(Arr.map(Record.keys(set.files), skillOf)),
  hashes: Object.fromEntries(
    await Promise.all(
      Arr.map(
        Record.toEntries(set.files),
        async ([path, text]) => [path, await contentHash(text)] as const,
      ),
    ),
  ),
});

/**
 * A Skill set as the Registry merges it, before its texts are read: its hash, the names of its Skills, and each file's
 * content hash by its path under the mount, with whether the bundle holds its text.
 */
export type MergedSkills = {
  readonly hash: string;
  readonly names: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly hash: string;
    readonly bundled: boolean;
  }>;
};

/**
 * The Skill set of `layers` (the scopes' Skills, nearest first: an Environment's own) over the bundle, the lowest layer:
 * a Skill of a nearer layer hides the others of its name. With no Skill in any layer it is the bundle, under the
 * bundle's own hash, so a Workspace that holds the bundle is handed nothing; otherwise its hash is that of every file's
 * path and content hash, in order.
 */
export const mergeSkills = async (
  layers: ReadonlyArray<ReadonlyArray<Pick<StoredSkill, "name" | "files">>>,
  bundle: HashedBundle,
): Promise<MergedSkills> => {
  const taken = new Set<string>();
  const entries: Array<MergedSkills["entries"][number]> = [];

  for (const layer of layers) {
    for (const skill of layer) {
      if (taken.has(skill.name)) continue;

      taken.add(skill.name);

      for (const [path, hash] of Record.toEntries(skill.files)) {
        entries.push({ path: `${skill.name}/${path}`, hash, bundled: false });
      }
    }
  }

  if (taken.size === 0) {
    return {
      hash: bundle.set.hash,
      names: [...bundle.names],
      entries: Arr.map(Record.toEntries(bundle.hashes), ([path, hash]) => ({
        path,
        hash,
        bundled: true,
      })),
    };
  }

  for (const [path, hash] of Record.toEntries(bundle.hashes)) {
    if (!taken.has(skillOf(path))) entries.push({ path, hash, bundled: true });
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
    names: [...new Set([...taken, ...bundle.names])],
    entries: ordered,
  };
};

/** The Skill set `merged` describes, with its texts: the bundle's from the bundle, the others from `skills`. */
export const skillSetOf = (
  merged: MergedSkills,
  bundle: HashedBundle,
  skills: Skills,
): SkillSet => {
  const kept = skills.contents(
    Arr.flatMap(merged.entries, ({ hash, bundled }) => (bundled ? [] : [hash])),
  );

  return {
    hash: merged.hash,
    files: Object.fromEntries(
      Arr.map(merged.entries, ({ path, hash, bundled }) => [
        path,
        (bundled ? bundle.set.files[path] : kept.get(hash)) ?? "",
      ]),
    ),
  };
};

/** Where a Skill named `name` is served in every Workspace of its Environment. */
export const skillPath = (name: string): string => `${SKILLS_ROOT}/${name}`;

/** How many Skills the merged set of an Environment with `own` would hold, with the bundle's. */
const mergedCount = (own: ReadonlyArray<string>, bundle: HashedBundle): number =>
  new Set([...own, ...bundle.names]).size;

/** Why a set of `count` Skills is refused, or undefined when it is not. */
const countProblem = (count: number): string | undefined =>
  count > MAX_SKILLS
    ? `the Environment's Skill set would hold ${count} Skills, more than the ${MAX_SKILLS} a set may: remove one first`
    : undefined;

/** A Skill's files as an Agent change records them. */
const changeValue = (files: HashedFiles): SkillChangeValue => ({ files: { ...files } });

const decodeChangeValue = Schema.decodeUnknownOption(SkillChangeValue);

/** The files an Agent change of a Skill records, or null where there were none (or the value is not a Skill's). */
export const changeFiles = (value: AgentChange["before"]): HashedFiles | null =>
  value === null
    ? null
    : Option.getOrNull(Option.map(decodeChangeValue(value), ({ files }) => files));

/** How the agent's save of a Skill went. */
export type SkillSave =
  | {
      readonly status: "saved";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
      readonly skill: StoredSkill;
      /** Whether a bundled Skill of the name is hidden by it. */
      readonly shadows: boolean;
    }
  /** The Environment holds the Skill with these files already: nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly environment: EnvironmentRecord }
  /** The Skill is not one a save keeps, each problem a line: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** How the agent's removal of a Skill went. */
export type SkillRemoval =
  | {
      readonly status: "removed";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
      /** Whether a bundled Skill of the name is served in its place. */
      readonly bundled: boolean;
    }
  /** The Environment keeps no Skill of the name: nothing was recorded. */
  | { readonly status: "absent"; readonly environment: EnvironmentRecord }
  | { readonly status: "missing" };

/** The part of the store a Skill's change uses. */
export type SkillStore = { readonly getEnvironment: (id: string) => EnvironmentRecord | null };

/**
 * The agent saves the Skill in folder `folder` with `files` (hashed beforehand, `hashFiles`) for `environment`, in
 * place of one of its name: checked as `checkSkill` checks it, and refused when the Environment's Skill set would hold
 * more than `MAX_SKILLS` Skills. Recorded as an Agent change by `author`, with the files before (none for a new Skill)
 * and after; the same files as kept records nothing.
 */
export const saveSkillAs = (
  storage: Pick<RegistryStorage, "transactionSync">,
  store: SkillStore,
  skills: Skills,
  changes: AgentChanges,
  bundle: HashedBundle,
  {
    environment,
    folder,
    files,
    hashed,
    author,
  }: {
    readonly environment: string;
    readonly folder: string;
    readonly files: SkillFiles;
    readonly hashed: Hashed;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): SkillSave =>
  storage.transactionSync((): SkillSave => {
    const record = store.getEnvironment(environment);

    if (record === null) return { status: "missing" };

    const checked = checkSkill(folder, files);

    if (!checked.ok) return { status: "rejected", message: checked.message };

    const { name, description } = checked.skill;
    const before = skills.get(environment, name);

    if (before !== null && sameFiles(before.files, hashed.files)) {
      return { status: "unchanged", environment: record };
    }

    const problem = countProblem(
      mergedCount([...Arr.map(skills.list(environment), (kept) => kept.name), name], bundle),
    );

    if (problem !== undefined) return { status: "rejected", message: problem };

    skills.put(environment, { name, description, files: hashed.files }, hashed.contents, now);

    const change = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: skillField(name),
      before: before === null ? null : changeValue(before.files),
      after: changeValue(hashed.files),
      reverts: null,
      approved: author.approved,
    });

    return {
      status: "saved",
      environment: record,
      change,
      skill: { name, description, files: hashed.files, savedAt: now },
      shadows: bundle.names.has(name),
    };
  });

/** The agent removes Skill `name` kept for `environment`, recorded as an Agent change by `author` with its files before. */
export const removeSkillAs = (
  storage: Pick<RegistryStorage, "transactionSync">,
  store: SkillStore,
  skills: Skills,
  changes: AgentChanges,
  bundle: HashedBundle,
  {
    environment,
    name,
    author,
  }: { readonly environment: string; readonly name: string; readonly author: AgentChangeAuthor },
  now: number,
): SkillRemoval =>
  storage.transactionSync((): SkillRemoval => {
    const record = store.getEnvironment(environment);

    if (record === null) return { status: "missing" };

    const before = skills.get(environment, name);

    if (before === null) return { status: "absent", environment: record };

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
      before: changeValue(before.files),
      after: null,
      reverts: null,
      approved: author.approved,
    });

    return { status: "removed", environment: record, change, bundled: bundle.names.has(name) };
  });

/**
 * The owner removes Skill `name` kept for `environment` from the Environments page, as an owner's save: not an Agent
 * change. Says whether it was kept; the texts no Skill or change refers to any more are dropped.
 */
export const removeSkill = (
  storage: RegistryStorage,
  skills: Skills,
  { environment, name }: { readonly environment: string; readonly name: string },
): boolean =>
  storage.transactionSync(() => {
    const removed = skills.remove(environment, name);

    if (removed) dropUnreferencedSkillFiles(storage.sql);

    return removed;
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
 * The owner's revert of `change`, a save or removal of Skill `name` in `environment`: the files before written back (a
 * save of a new Skill is removed, a removal brings the Skill back), recorded as the owner's change. Refused when the
 * Skill no longer has the files the change gave it.
 */
export const revertSkillChange = (
  skills: Skills,
  changes: AgentChanges,
  bundle: HashedBundle,
  environment: string,
  change: AgentChange,
  now: number,
): AgentChangeRevert => {
  const name = fieldSkill(change.field);

  if (name === null) return { status: "missing" };

  const current = skills.get(environment, name);
  const after = changeFiles(change.after);
  const before = changeFiles(change.before);

  const unchanged =
    current === null ? after === null : after !== null && sameFiles(current.files, after);

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
    skills.remove(environment, name);
  } else {
    const problem = countProblem(
      mergedCount([...Arr.map(skills.list(environment), (kept) => kept.name), name], bundle),
    );

    if (problem !== undefined) return { status: "refused", message: `Not reverted: ${problem}` };

    const texts = skills.contents(Record.values(before));

    skills.put(
      environment,
      { name, description: descriptionOf(texts.get(before["SKILL.md"] ?? "")), files: before },
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
    before: current === null ? null : changeValue(current.files),
    after: before === null ? null : changeValue(before),
    reverts: change.id,
  });

  return { status: "reverted", change: recorded };
};
