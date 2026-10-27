// Fake Skills for the `environment` extension's tests: an Environment's own Skills kept in memory, saved and removed as
// the Registry does (by name, the same files recording nothing), and a Workspace folder to save from.
// @effect-diagnostics missingPipeableSignature:off
import { type AgentChange, skillField } from "@cloudpid/protocol";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type { EnvironmentSkills } from "./environment-skills.ts";

/** Skills that fail when called, for a fake that serves the other tools only. */
export const unusedSkills: EnvironmentSkills = {
  saveSkill: () => Effect.die("saveSkill is not used here"),
  removeSkill: () => Effect.die("removeSkill is not used here"),
};

/**
 * Skills over Environments `default` (named Default, this Session's) and `0000abcd` (named Other), each keeping none at
 * first, and a bundle of `pr`. A save is refused with `refusal` when it is set, as the Registry refuses one.
 */
export const fakeSkills = () => {
  const names = new Map([
    ["default", "Default"],
    ["0000abcd", "Other"],
  ]);

  /** What each Environment keeps, by `<environment>:<name>`. */
  const kept = new Map<string, Readonly<Record<string, string>>>();

  const saves: Array<{
    environment: string;
    folder: string;
    files: Readonly<Record<string, string>>;
  }> = [];

  let refusal: string | undefined;
  let next = 1;

  const changeOf = (
    environment: string,
    name: string,
    tool: string,
    reason: string,
    before: Readonly<Record<string, string>> | undefined,
    after: Readonly<Record<string, string>> | undefined,
  ): AgentChange => ({
    id: next++,
    scope: environment,
    at: 1_000,
    actor: "agent",
    session: "s-1",
    conversation: 0,
    tool,
    reason,
    field: skillField(name),
    before: before === undefined ? null : { files: { ...before } },
    after: after === undefined ? null : { files: { ...after } },
    reverts: null,
    revertedBy: null,
  });

  const service: EnvironmentSkills = {
    saveSkill: ({ environment, folder, files, author }) =>
      Effect.sync(() => {
        const known = names.get(environment);

        if (known === undefined) return { status: "missing" as const };

        saves.push({ environment, folder, files });

        if (refusal !== undefined) return { status: "rejected" as const, message: refusal };

        const where = { id: environment, name: known };
        const key = `${environment}:${folder}`;
        const before = kept.get(key);
        // The fake keeps the texts themselves where the Registry keeps hashes.
        const after = files;

        if (
          before !== undefined &&
          Record.size(before) === Record.size(after) &&
          Arr.every(Record.toEntries(after), ([path, text]) => before[path] === text)
        ) {
          return { status: "unchanged" as const, environment: where, name: folder };
        }

        kept.set(key, after);

        return {
          status: "saved" as const,
          environment: where,
          change: changeOf(environment, folder, author.tool, author.reason, before, after),
          name: folder,
          shadows: folder === "pr",
          handed: environment === "default",
        };
      }),
    removeSkill: ({ environment, name, author }) =>
      Effect.sync(() => {
        const known = names.get(environment);

        if (known === undefined) return { status: "missing" as const };

        const where = { id: environment, name: known };
        const before = kept.get(`${environment}:${name}`);

        if (before === undefined) return { status: "absent" as const, environment: where };

        kept.delete(`${environment}:${name}`);

        return {
          status: "removed" as const,
          environment: where,
          change: changeOf(environment, name, author.tool, author.reason, before, undefined),
          bundled: name === "pr",
          handed: environment === "default",
        };
      }),
  };

  return {
    service,
    kept,
    saves,
    refuse: (message: string) => {
      refusal = message;
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
): Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile"> => {
  const bytes = (content: string | Uint8Array) =>
    content instanceof Uint8Array ? content : new TextEncoder().encode(content);

  const isDirectory = (path: string) =>
    Arr.some([...Record.keys(files), ...links], (file) => file.startsWith(`${path}/`));

  return {
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
};
