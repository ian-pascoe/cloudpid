// Fake Skills for the `environment` extension's tests: an Environment's own Skills kept in memory, saved and removed as
// the Registry does (by name, the same files recording nothing), and a Workspace folder to save from.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  type EnvironmentSkill,
  type SkillInstallPin,
  type SkillInstallPreview,
  type SkillExpectation,
  skillField,
} from "@cloudpid/protocol";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { ChangeAuthor } from "./environment.ts";
import type {
  EnvironmentSkills,
  SkillPreview,
  SkillsInstalled,
  SkillsUpdated,
  SkillUpdatesPreview,
} from "./environment-skills.ts";

/** Skills that fail when called, for a fake that serves the other tools only. */
export const unusedSkills: EnvironmentSkills = {
  saveSkill: () => Effect.die("saveSkill is not used here"),
  previewSkill: () => Effect.die("previewSkill is not used here"),
  removeSkill: () => Effect.die("removeSkill is not used here"),
  installSkills: () => Effect.die("installSkills is not used here"),
  updateSkills: () => Effect.die("updateSkills is not used here"),
  previewUpdates: () => Effect.die("previewUpdates is not used here"),
  previewInstall: () => Effect.die("previewInstall is not used here"),
};

/** The description a `SKILL.md`'s frontmatter gives, for a fake that does not parse YAML. */
const descriptionOf = (files: Readonly<Record<string, string>>): string =>
  /^description: (.*)$/m.exec(files["SKILL.md"] ?? "")?.[1] ?? "";

/**
 * Skills over Environments `default` (named Default, this Session's) and `0000abcd` (named Other), and every Environment
 * (`*`), each keeping none at first, and a bundle of `pr`. A save is refused with `refusal` when it is set, as the Registry
 * refuses one. A scope's Skill of a name hides the one kept for every Environment, as the Registry's layers do.
 */
export const fakeSkills = () => {
  const names = new Map([
    ["default", "Default"],
    ["0000abcd", "Other"],
    ["*", "every Environment"],
  ]);

  /** What each scope keeps, by `<scope>:<name>`. */
  const kept = new Map<string, Readonly<Record<string, string>>>();
  /** When each was last saved. */
  const savedAt = new Map<string, number>();

  const saves: Array<{
    environment: string;
    folder: string;
    files: Readonly<Record<string, string>>;
    expected?: SkillExpectation | undefined;
  }> = [];

  const removals: Array<{ environment: string; name: string }> = [];

  /** The changes recorded, in order, as the Registry records them. */
  const recorded: AgentChange[] = [];

  let refusal: string | undefined;
  let removalRefusal: string | undefined;
  let next = 1;
  let clock = 1_000;

  /** What the Registry answers an install with, and what it was asked. */
  let installation: SkillsInstalled | undefined;

  const installs: Array<{
    environment: string;
    source: string;
    skills: ReadonlyArray<string> | undefined;
    reason: string;
    /** Whether the owner approved the install first (an Agent change made as approved). */
    approved?: boolean | undefined;
    pin?: SkillInstallPin | undefined;
  }> = [];

  /** What the Registry answers a preview of an install with, and what it was asked. */
  let preview: SkillInstallPreview | undefined;

  const previews: Array<{
    environment: string;
    source: string;
    skills: ReadonlyArray<string> | undefined;
  }> = [];

  /** What the Registry answers an update and its preview with, and what each was asked. */
  let update: SkillsUpdated | undefined;
  let updatePreview: SkillUpdatesPreview | undefined;

  const updates: Array<{
    environment: string;
    names: ReadonlyArray<string> | undefined;
    overwrite: boolean;
    pins:
      | ReadonlyArray<{ name: string; savedAt: number; commit: string; folderHash: string }>
      | undefined;
    reason: string;
    approved: boolean;
  }> = [];

  const updatePreviews: Array<{
    environment: string;
    names: ReadonlyArray<string> | undefined;
    overwrite: boolean;
  }> = [];

  const changeOf = (
    environment: string,
    name: string,
    author: ChangeAuthor,
    before: Readonly<Record<string, string>> | undefined,
    after: Readonly<Record<string, string>> | undefined,
  ): AgentChange => {
    const change: AgentChange = {
      id: next++,
      scope: environment,
      at: 1_000,
      actor: "agent",
      session: "s-1",
      conversation: 0,
      tool: author.tool,
      reason: author.reason,
      field: skillField(name),
      before: before === undefined ? null : { files: { ...before } },
      after: after === undefined ? null : { files: { ...after } },
      reverts: null,
      revertedBy: null,
    };

    const made = author.approved === true ? { ...change, approved: true as const } : change;

    recorded.push(made);

    return made;
  };

  const sameFiles = (
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
  ) =>
    Record.size(before) === Record.size(after) &&
    Arr.every(Record.toEntries(after), ([path, text]) => before[path] === text);

  /** The Environments (not `*`) whose own Skill of `name` hides the one kept for every Environment. */
  const overriding = (name: string) =>
    Arr.filter(
      Arr.map(
        Arr.filter([...names], ([id]) => id !== "*"),
        ([id, label]) => ({ id, name: label }),
      ),
      ({ id }) => kept.has(`${id}:${name}`),
    );

  const check = ({
    environment,
    folder,
    files,
  }: {
    environment: string;
    folder: string;
    files: Readonly<Record<string, string>>;
  }): SkillPreview => {
    const known = names.get(environment);

    if (known === undefined) return { status: "missing" };

    if (refusal !== undefined) return { status: "rejected", message: refusal };

    const before = kept.get(`${environment}:${folder}`);
    const when = savedAt.get(`${environment}:${folder}`);

    return {
      status: before !== undefined && sameFiles(before, files) ? "unchanged" : "ready",
      environment: { id: environment, name: known },
      name: folder,
      description: descriptionOf(files),
      current:
        before === undefined || when === undefined
          ? null
          : {
              description: descriptionOf(before),
              savedAt: when,
              files: Arr.sort(Record.keys(before), Order.String),
            },
    };
  };

  const service: EnvironmentSkills = {
    saveSkill: ({ environment, folder, files, expected, author }) =>
      Effect.sync(() => {
        saves.push({ environment, folder, files, expected });

        const checked = check({ environment, folder, files });

        if (checked.status === "missing" || checked.status === "rejected") return checked;

        const key = `${environment}:${folder}`;

        if (checked.status === "unchanged") {
          return { status: "unchanged" as const, environment: checked.environment, name: folder };
        }

        if (expected !== undefined && (savedAt.get(key) ?? null) !== expected.savedAt) {
          return { status: "changed-since" as const, environment: checked.environment };
        }

        const before = kept.get(key);

        kept.set(key, files);
        savedAt.set(key, clock++);

        const everywhere = environment === "*";
        const hiding = everywhere ? overriding(folder) : [];

        return {
          status: "saved" as const,
          environment: checked.environment,
          change: changeOf(environment, folder, author, before, files),
          name: folder,
          bundled: folder === "pr",
          inherited: !everywhere && kept.has(`*:${folder}`),
          overriddenIn: hiding,
          // The Session's own Workspace takes it unless its Environment (default) keeps its own of the name.
          handed: everywhere
            ? !Arr.some(hiding, ({ id }) => id === "default")
            : environment === "default",
        };
      }),
    previewSkill: (input) => Effect.sync(() => check(input)),
    removeSkill: ({ environment, name, expected, author }) =>
      Effect.sync(() => {
        removals.push({ environment, name });

        const known = names.get(environment);

        if (known === undefined) return { status: "missing" as const };

        const where = { id: environment, name: known };
        const key = `${environment}:${name}`;
        const before = kept.get(key);

        if (before === undefined) return { status: "absent" as const, environment: where };

        if (removalRefusal !== undefined) {
          return { status: "rejected" as const, message: removalRefusal };
        }

        if (expected !== undefined && (savedAt.get(key) ?? null) !== expected.savedAt) {
          return { status: "changed-since" as const, environment: where };
        }

        kept.delete(key);
        savedAt.delete(key);

        const everywhere = environment === "*";
        const hiding = everywhere ? overriding(name) : [];

        return {
          status: "removed" as const,
          environment: where,
          change: changeOf(environment, name, author, before, undefined),
          bundled: name === "pr",
          inherited: !everywhere && kept.has(`*:${name}`),
          overriddenIn: hiding,
          handed: everywhere
            ? !Arr.some(hiding, ({ id }) => id === "default")
            : environment === "default",
        };
      }),
    previewInstall: ({ environment, source, skills }) =>
      Effect.sync(() => {
        previews.push({ environment, source, skills });

        return (
          preview ?? {
            status: "refused" as const,
            message: "the fake Registry was given no preview",
          }
        );
      }),
    installSkills: ({ environment, source, skills, author, pin }) =>
      Effect.sync(() => {
        installs.push({
          environment,
          source,
          skills,
          reason: author.reason,
          approved: author.approved,
          pin,
        });

        return (
          installation ?? {
            status: "refused" as const,
            message: "the fake Registry was given no answer",
          }
        );
      }),
    updateSkills: ({ environment, names, overwrite, pins, author }) =>
      Effect.sync(() => {
        updates.push({
          environment,
          names,
          overwrite,
          pins,
          reason: author.reason,
          approved: author.approved === true,
        });

        return update ?? { status: "missing" as const };
      }),
    previewUpdates: ({ environment, names, overwrite }) =>
      Effect.sync(() => {
        updatePreviews.push({ environment, names, overwrite });

        return updatePreview ?? { status: "missing" as const };
      }),
  };

  /** The Skills kept for a scope, as the Registry lists them. */
  const listed = (scope: string): ReadonlyArray<EnvironmentSkill> =>
    Arr.filterMap([...kept], ([key, files]) =>
      key.startsWith(`${scope}:`)
        ? Result.succeed({
            name: key.slice(scope.length + 1),
            description: descriptionOf(files),
            savedAt: savedAt.get(key) ?? 0,
          })
        : Result.failVoid,
    );

  return {
    service,
    kept,
    saves,
    removals,
    listed,
    recorded,
    installs,
    updates,
    updatePreviews,
    /** Answer the next updates with `answer`. */
    answerUpdate: (answer: SkillsUpdated) => {
      update = answer;
    },
    /** Answer the next previews of an update with `answer`. */
    answerUpdatePreview: (answer: SkillUpdatesPreview) => {
      updatePreview = answer;
    },
    previews,
    /** Answer the next previews of an install with `answer`. */
    answerPreview: (answer: SkillInstallPreview) => {
      preview = answer;
    },
    /** Answer the next installs with `answer`. */
    answerInstall: (answer: SkillsInstalled) => {
      installation = answer;
    },
    refuse: (message: string) => {
      refusal = message;
    },
    /** Refuse the next removals, as the Registry does one that would serve a Skill that does not fit. */
    refuseRemoval: (message: string) => {
      removalRefusal = message;
    },
    /** Put a Skill in a scope as if saved long ago, with no change recorded. */
    keep: (scope: string, name: string, files: Readonly<Record<string, string>>) => {
      kept.set(`${scope}:${name}`, files);
      savedAt.set(`${scope}:${name}`, clock++);
    },
  };
};

const notFound = (path: string) =>
  err<never, FileError>(new FileError("not_found", `No such file: ${path}`, path));

/**
 * A Workspace's files for a save to read: each file's content by its absolute path, and the symbolic links among them.
 * Relative paths are resolved against `/workspace`.
 */
export const fakeFolderEnv = (
  files: Readonly<Record<string, string | Uint8Array>>,
  links: ReadonlyArray<string> = [],
  /** Whether a path is Container-only; without it, the environment cannot say; `"fails"`: the check fails. */
  containerOnly?: ((path: string) => boolean) | "fails",
): Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile"> => {
  const bytes = (content: string | Uint8Array) =>
    content instanceof Uint8Array ? content : new TextEncoder().encode(content);

  const isDirectory = (path: string) =>
    Arr.some([...Record.keys(files), ...links], (file) => file.startsWith(`${path}/`));

  const env: Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile"> = {
    absolutePath: (path) => Promise.resolve(ok(path.startsWith("/") ? path : `/workspace/${path}`)),
    fileInfo: (path) => {
      const content = files[path];
      const name = path.slice(path.lastIndexOf("/") + 1);

      if (content !== undefined) {
        return Promise.resolve(
          ok({ name, path, kind: "file" as const, size: bytes(content).length, mtimeMs: 0 }),
        );
      }

      return Promise.resolve(
        isDirectory(path)
          ? ok({ name, path, kind: "directory" as const, size: 0, mtimeMs: 0 })
          : notFound(path),
      );
    },
    listFiles: (path) => {
      const below = Arr.filter([...Record.keys(files), ...links], (file) =>
        file.startsWith(`${path}/`),
      );

      return Promise.resolve(
        ok({
          entries: Arr.map(below, (file) => ({
            path: file.slice(path.length + 1),
            kind: links.includes(file) ? ("symlink" as const) : ("file" as const),
          })),
          truncated: false,
        }),
      );
    },
    readBinaryFile: (path) => {
      const content = files[path];

      return Promise.resolve(content === undefined ? notFound(path) : ok(bytes(content)));
    },
  };

  if (containerOnly === undefined) return env;

  const classifying = {
    ...env,
    containerOnly: (paths: readonly string[]) =>
      Promise.resolve(
        containerOnly === "fails"
          ? err<readonly boolean[], FileError>(
              new FileError("unknown", "The Workspace did not answer", paths[0]),
            )
          : ok(Arr.map(paths, (path) => containerOnly(path))),
      ),
  };

  return classifying;
};
