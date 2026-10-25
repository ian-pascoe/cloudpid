// Fake lifecycle operations for the `environment` extension's tests: Environments in memory that apply each operation
// as the Registry does (the owner's name rules, the Repo directories) and record what was asked.
import type { AgentChange, EnvironmentRepo } from "@cloudpid/protocol";
import {
  BUILD_ASKED,
  BUILD_FIELD,
  CREATED_FIELD,
  environmentNameProblem,
  NAME_FIELD,
  repoField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ChangeAuthor } from "./environment.ts";
import type { EnvironmentLifecycle } from "./environment-lifecycle.ts";

type Held = { id: string; name: string; repos: EnvironmentRepo[] };

/** Operations that fail when called, for a fake that serves the other tools only. */
export const unusedLifecycle: EnvironmentLifecycle = {
  create: () => Effect.die("create is not used here"),
  rename: () => Effect.die("rename is not used here"),
  addRepo: () => Effect.die("addRepo is not used here"),
  removeRepo: () => Effect.die("removeRepo is not used here"),
  rebuild: () => Effect.die("rebuild is not used here"),
};

/** What a fake operation was asked, by operation. */
export type LifecycleCall = { readonly op: string; readonly author: ChangeAuthor };

/** A lifecycle over Environments `default` (named Default, repo app) and `0000abcd` (named Other, no Repos). */
export const fakeLifecycle = () => {
  const held = new Map<string, Held>([
    [
      "default",
      {
        id: "default",
        name: "Default",
        repos: [{ name: "app", url: "https://github.com/o/app.git" }],
      },
    ],
    ["0000abcd", { id: "0000abcd", name: "Other", repos: [] }],
  ]);

  const calls: LifecycleCall[] = [];
  let next = 1;
  let made = 0;

  const record = (
    scope: string,
    author: ChangeAuthor,
    field: string,
    before: AgentChange["before"],
    after: AgentChange["after"],
  ): AgentChange => ({
    id: next++,
    scope,
    at: 1_000,
    actor: "agent",
    session: "s-1",
    conversation: author.conversation,
    tool: author.tool,
    reason: author.reason,
    field,
    before,
    after,
    reverts: null,
    revertedBy: null,
  });

  const taken = (name: string, except: string) =>
    Arr.some(
      [...held.values()],
      (each) => each.id !== except && each.name.toLowerCase() === name.toLowerCase(),
    );

  const service: EnvironmentLifecycle = {
    create: ({ name, repos, author }) =>
      Effect.sync(() => {
        calls.push({ op: "create", author });

        const trimmed = name.trim();
        const problem = environmentNameProblem(trimmed);

        if (problem !== undefined) return { status: "rejected" as const, message: problem };

        if (taken(trimmed, "")) {
          return {
            status: "rejected" as const,
            message: `Another environment is already named "${trimmed}"`,
          };
        }

        const id = `0000ff0${made++}`;

        const parsed = Arr.map(repos, (source) => ({
          name:
            source
              .split("/")
              .pop()
              ?.replace(/\.git$/, "") ?? source,
          url: `https://github.com/${source}.git`,
        }));

        held.set(id, { id, name: trimmed, repos: parsed });

        return {
          status: "made" as const,
          environment: { id, name: trimmed },
          repos: parsed,
          change: record(id, author, CREATED_FIELD, null, { name: trimmed, repos: parsed }),
        };
      }),
    rename: ({ environment, name, author }) =>
      Effect.sync(() => {
        calls.push({ op: "rename", author });

        const found = held.get(environment);

        if (found === undefined) return { status: "missing" as const };

        const trimmed = name.trim();

        if (found.name === trimmed) {
          return {
            status: "unchanged" as const,
            environment: { id: found.id, name: found.name },
          };
        }

        if (taken(trimmed, found.id)) {
          return {
            status: "rejected" as const,
            message: `Another environment is already named "${trimmed}"`,
          };
        }

        held.set(environment, { ...found, name: trimmed });

        return {
          status: "changed" as const,
          environment: { id: found.id, name: trimmed },
          change: record(environment, author, NAME_FIELD, found.name, trimmed),
        };
      }),
    addRepo: ({ environment, source, name, author }) =>
      Effect.sync(() => {
        calls.push({ op: "addRepo", author });

        const found = held.get(environment);

        if (found === undefined) return { status: "missing" as const };

        const directory = name ?? source.split("/").pop() ?? source;
        const url = `https://github.com/${source}.git`;
        const same = Arr.findFirst(found.repos, (repo) => repo.name === directory);

        if (Option.isSome(same)) {
          return same.value.url === url
            ? { status: "unchanged" as const, environment: { id: found.id, name: found.name } }
            : {
                status: "rejected" as const,
                message: `The environment already has a repo in ${directory}: name this one`,
              };
        }

        held.set(environment, { ...found, repos: [...found.repos, { name: directory, url }] });

        return {
          status: "changed" as const,
          environment: { id: found.id, name: found.name },
          change: record(environment, author, repoField(directory), null, url),
        };
      }),
    removeRepo: ({ environment, name, author }) =>
      Effect.sync(() => {
        calls.push({ op: "removeRepo", author });

        const found = held.get(environment);

        if (found === undefined) return { status: "missing" as const };

        const repo = Arr.findFirst(found.repos, (each) => each.name === name);

        if (Option.isNone(repo)) {
          return { status: "rejected" as const, message: `The environment has no repo "${name}"` };
        }

        held.set(environment, {
          ...found,
          repos: Arr.filter(found.repos, (each) => each !== repo.value),
        });

        return {
          status: "changed" as const,
          environment: { id: found.id, name: found.name },
          change: record(environment, author, repoField(name), repo.value.url, null),
        };
      }),
    rebuild: ({ environment, author }) =>
      Effect.sync(() => {
        calls.push({ op: "rebuild", author });

        const found = held.get(environment);

        if (found === undefined) return { status: "missing" as const };

        if (found.repos.length === 0) {
          return {
            status: "rejected" as const,
            message:
              "The environment has no repos, no Setup Script and no Toolchains: there is nothing to build",
          };
        }

        return {
          status: "changed" as const,
          environment: { id: found.id, name: found.name },
          change: record(environment, author, BUILD_FIELD, null, BUILD_ASKED),
        };
      }),
  };

  return { service, calls, held };
};
