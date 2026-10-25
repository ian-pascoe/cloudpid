// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off
import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS, SettingsError } from "@cloudpid/config";
import type { AgentChangeRevert } from "./agent-changes.ts";
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import {
  type AgentChange,
  DEFAULT_ENVIRONMENT,
  EnvironmentError,
  type EnvironmentSecretRecord,
  forkTitle,
  MAX_ENVIRONMENT_SECRETS,
  MAX_TITLE_LENGTH,
  secretNameProblem,
  secretValueProblem,
  RegistryRpcs,
  RPC_PATH,
  SessionActionError,
  SessionNotFound,
  workspaceDirectory,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { expect, it } from "vitest";
import { type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { isRegistryRpc } from "../routes.ts";
import type { ForkPlan } from "../session/fork.ts";
import { buildKey, type BuildRequest, type BuildState } from "../workspace/build-record.ts";
import type { WorkspaceLookups } from "../session/lookups.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import { BUILD_LOOK_INTERVAL_MS, buildUpkeep, buildView } from "./builds.ts";
import type { RegistryMethods } from "./Registry.ts";
import { legacyCleanup, serveRegistryRpc, type SessionObjects, spareUpkeep } from "./rpc.ts";
import { SettingsUpdate } from "./settings.ts";
import type {
  BuildRecord,
  EnvironmentNaming,
  EnvironmentRecord,
  LegacyObject,
  RepoChange,
  SessionRecord,
  SessionRefusal,
  WorkspaceRecord,
  WorkspaceSetup,
} from "./store.ts";

/** An in-memory Registry behind `getByName`, as the Worker's binding presents it. */
const fakeRegistries = () => {
  const sessions: SessionRecord[] = [];
  const workspaces: WorkspaceRecord[] = [];

  const environments: EnvironmentRecord[] = [
    { id: DEFAULT_ENVIRONMENT, name: "Default", repos: [], createdAt: 0 },
  ];
  /** The Container settings overrides saved per Environment. */

  const overridesOf = new Map<string, Schema.Json>();
  /** What is left from before Environments, to wipe. */
  const legacyObjects: LegacyObject[] = [];
  const names: string[] = [];
  /** The endpoints of the Web Push subscriptions kept. */
  const pushes = new Set<string>();
  /** The Registry methods called, in order. */
  const calls: string[] = [];
  /** The kept Secrets, values included, as the Registry DO would open them. */
  const keptSecrets: Array<EnvironmentSecretRecord & { readonly value: string }> = [];
  /** The Agent changes recorded, oldest first. */
  const agentChanges: AgentChange[] = [];

  /** What `environment` uses: its own over those kept for every Environment, by name. */
  const keptFor = (environment: string): ReadonlyArray<KeptSecret> => {
    const byName = new Map<string, KeptSecret>();

    for (const scope of [null, environment]) {
      for (const kept of Arr.filter(keptSecrets, (item) => item.environment === scope)) {
        byName.set(kept.name, {
          name: kept.name,
          value: kept.value,
          scope: scope === null ? "every" : "environment",
          build: kept.build,
        });
      }
    }

    return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  };

  /** A stand-in for the Registry's keyed digest of the Secrets a Build gets: null when none does. */
  const buildDigestOf = (environment: string) => {
    const pairs = Arr.filter(keptFor(environment), (kept) => kept.build).map(
      (kept) => `${kept.name}=${kept.value.length}:${kept.value.charCodeAt(0)}`,
    );

    return pairs.length === 0 ? null : `digest(${pairs.join(",")})`;
  };

  /** Replace the first of `list` that `matches` with what `change` makes of it; the changed one, or null. */
  const replace = <A>(list: A[], matches: (item: A) => boolean, change: (item: A) => A) =>
    Option.getOrNull(
      Option.map(Arr.findFirstIndex(list, matches), (index) => {
        // SAFETY: the index was just found in `list`.
        const changed = change(list[index] as A);

        list.splice(index, 1, changed);

        return changed;
      }),
    );

  /** Remove the first of `list` that `matches`; says whether there was one. */
  const remove = <A>(list: A[], matches: (item: A) => boolean) =>
    Option.match(Arr.findFirstIndex(list, matches), {
      onNone: () => false,
      onSome: (index) => {
        list.splice(index, 1);

        return true;
      },
    });

  const setArchived = (id: string, archivedAt: number | null, call: string) =>
    Effect.sync(() => {
      calls.push(call);

      return replace(
        sessions,
        (session) => session.id === id,
        (session): SessionRecord => ({ ...session, archivedAt }),
      );
    });

  /** Whether `name` is another Environment's, whatever the case. */
  const nameTaken = (name: string, id: string) =>
    Arr.some(
      environments,
      (other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase(),
    );

  /** The Sessions whose object fails every call, with the message it fails with. */
  const brokenSessions = new Map<string, string>();

  /** An object that throws, or cannot be reached, is a defect of the call. */
  const sessionCall = (call: string, id: string) =>
    Effect.suspend(() => {
      calls.push(`${call}:${id}`);

      const broken = brokenSessions.get(id);

      return broken === undefined ? Effect.void : Effect.die(new Error(broken));
    });

  /** The Sessions whose Run is in progress, which refuse a Clone. */
  const runningSessions = new Set<string>();
  /** The entries each new Session's object was given, by their source IDs. */
  const imported = new Map<string, number[]>();
  /** What each new Session's object was finished with. */
  const finished = new Map<string, ForkPlan>();

  /** The objects behind the Sessions: what was asked of each, in `calls`. */
  const sessionObjects: SessionObjects = {
    stop: (id) => sessionCall("stop", id),
    destroy: (id) => sessionCall("destroy", id),
    forkSource: (id, { point, quiet }) =>
      sessionCall(`forkSource(${quiet})`, id).pipe(
        Effect.andThen(
          quiet !== "none" && runningSessions.has(id)
            ? Effect.die(new Error("The session's Run is in progress"))
            : Effect.succeed<ForkPlan>({
                conversationId: ROOT_CONVERSATION_ID,
                // A Session of 3 entries, its owner's messages 1 and 3.
                through:
                  point === undefined
                    ? 3
                    : point.position === "before"
                      ? point.entryId - 1
                      : point.entryId,
                text: point?.position === "before" ? `message ${point.entryId}` : null,
                agent: {},
                pick: {},
                context: null,
                todo: null,
              }),
        ),
      ),
    // One entry a page.
    exportEntries: (id, request) =>
      sessionCall("exportEntries", id).pipe(
        Effect.as({
          // SAFETY: the copy only passes entries on; their IDs are what the tests look at.
          entries: [{ id: (request.after ?? 0) + 1 } as EntryRecord],
          next: (request.after ?? 0) + 1 === request.through ? null : (request.after ?? 0) + 1,
        }),
      ),
    importStart: (id) =>
      sessionCall("importStart", id).pipe(
        Effect.tap(() => Effect.sync(() => imported.set(id, []))),
      ),
    importEntries: (id, entries) =>
      sessionCall("importEntries", id).pipe(
        Effect.tap(() =>
          Effect.sync(() => imported.get(id)?.push(...Arr.map(entries, (entry) => entry.id))),
        ),
      ),
    importFinish: (id, plan) =>
      sessionCall("importFinish", id).pipe(
        Effect.tap(() => Effect.sync(() => finished.set(id, plan))),
      ),
    releaseFork: (id) => sessionCall("releaseFork", id),
  };

  /** Runs the next times a Workspace's object is wiped: what happens meanwhile. */
  let duringDestroy: Array<() => void> = [];

  /** Why the Workspace objects' calls fail, if they do; and only their carries. */
  let workspaceFails: string | undefined;
  let carryFails: string | undefined;

  const workspaceCall = (call: string, name: string) => {
    calls.push(`${call}:${name}`);

    if (call === "carry" && carryFails !== undefined) return Promise.reject(new Error(carryFails));

    return workspaceFails === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(workspaceFails));
  };

  /** What each Environment's Build object holds, by object name (`build:<id>`), and what each was last asked for. */
  const buildObjects = new Map<string, BuildState>();
  const buildRequests = new Map<string, BuildRequest>();
  /** The Secrets each Build object was last handed with a request. */
  const buildSecrets = new Map<string, ReadonlyArray<KeptSecret>>();
  /** The Secrets each spare's object was handed with its set-up, and the Build. */
  const spareSecrets = new Map<string, ReadonlyArray<KeptSecret> | undefined>();
  const spareBuilds = new Map<string, BuildRecord["build"]>();
  /** What the Registry recorded of each Environment's Build. */
  const buildRecords = new Map<string, BuildRecord>();
  const NO_BUILD: BuildRecord = { build: null, status: null };

  const buildStateOf = (name: string): BuildState =>
    buildObjects.get(name) ?? { image: "img-1", last: null, progress: null, attemptedAt: null };

  /** The objects behind the Workspaces, by object name. */
  const workspaceObjects: WorkspaceObjects = {
    buildState: async (name) => {
      calls.push(`buildState:${name}`);

      if (workspaceFails !== undefined) throw new Error(workspaceFails);

      return buildStateOf(name);
    },
    startBuild: async (name, request, secrets) => {
      calls.push(`startBuild:${name}${request.check === true ? ":check" : ""}`);
      duringStartBuild?.();
      duringStartBuild = undefined;

      if (workspaceFails !== undefined) throw new Error(workspaceFails);

      buildSecrets.set(name, secrets);

      const state: BuildState = {
        ...buildStateOf(name),
        progress: {
          status: request.check === true ? "checking" : "building",
          key: request.key,
          startedAt: 50,
        },
      };

      buildObjects.set(name, state);
      buildRequests.set(name, request);

      return state;
    },
    destroy: (name) => {
      const result = workspaceCall("destroyWorkspace", name);

      duringDestroy.shift()?.();

      return result;
    },
    restartContainer: (name) => workspaceCall("restartContainer", name),
    carry: (name, branch, repos) => workspaceCall("carry", `${name}:${branch}:${repos.join(",")}`),
    prepareSpare: (name, setup) => {
      spareSecrets.set(name, "secrets" in setup ? setup.secrets : undefined);
      spareBuilds.set(name, setup.build ?? null);

      const result = workspaceCall("prepareSpare", name);

      duringPrepare?.();
      duringPrepare = undefined;

      return result;
    },
  };

  /** Each Environment's spare Workspace: its id, the addresses of the Repos and the Build it was made with. */
  const spares = new Map<
    string,
    { readonly id: string; readonly repos: string; readonly build: string | null }
  >();

  /** The snapshot id of `environment`'s last good Build, as recorded; null for none. */
  const goodBuildOf = (environment: string) =>
    buildRecords.get(environment)?.build?.snapshot.id ?? null;

  const addresses = (repos: EnvironmentRecord["repos"]) =>
    Arr.join(
      Arr.map(repos, (repo) => repo.url),
      " ",
    );

  let sparesMade = 0;

  /** Runs once, when the next Registry `createSession` is called: what happens just before it is answered. */
  let beforeCreate: (() => void) | undefined;
  /** Run once, as the next `forgetSpare`, `prepareSpare` or `startBuild` reaches its object: what happens meanwhile. */
  let beforeForgetSpare: (() => void) | undefined;
  let duringPrepare: (() => void) | undefined;
  let duringStartBuild: (() => void) | undefined;

  /** The work the endpoint handed to `background`, not yet run. */
  const queued: Array<Effect.Effect<void>> = [];

  /** What the draft composer's lookups were asked: each with the object and directory it looked in. */
  const lookupsAsked: string[] = [];

  /** The draft composer's lookups, answering a Skill and a path made of the query. */
  const lookups: WorkspaceLookups = {
    catalog: (place) =>
      Effect.sync(() => {
        lookupsAsked.push(`catalog:${place.object}:${place.directory}`);

        return {
          commands: [],
          templates: [],
          skills: [{ name: "tdd", description: "Test first" }],
        };
      }),
    files: (place, query) =>
      Effect.sync(() => {
        lookupsAsked.push(`files:${place.object}:${place.directory}:${query}`);

        return { paths: [`${query}.ts`] };
      }),
  };

  const registry = {
    createSession: ({ title, workspace, origin }) =>
      Effect.sync((): SessionRecord | SessionRefusal => {
        calls.push("createSession");
        beforeCreate?.();
        beforeCreate = undefined;

        let record: WorkspaceRecord | undefined;

        if (workspace.kind === "existing") {
          record = Arr.findFirst(workspaces, (held) => held.id === workspace.id).pipe(
            Option.getOrUndefined,
          );

          if (record === undefined) return { refused: "no-workspace" };
        } else {
          const environment = Arr.findFirst(
            environments,
            (held) => held.id === workspace.environment,
          );

          if (Option.isNone(environment)) return { refused: "no-environment" };

          const id = String(workspaces.length + 1).padStart(8, "0");
          const branch = workspace.branch ?? `cloudpid/${id}`;

          const taken = Arr.findFirst(
            workspaces,
            (held) => held.environment === workspace.environment && held.branch === branch,
          );

          if (Option.isSome(taken)) return { refused: "branch-taken", workspace: taken.value.id };

          const repoNames = Arr.map(environment.value.repos, (repo) => repo.name);

          record = {
            id,
            environment: workspace.environment,
            branch,
            base: workspace.base ?? null,
            repos: repoNames,
            directory: workspaceDirectory(repoNames),
            createdAt: 1,
          };
          workspaces.unshift(record);
        }

        const made: SessionRecord = {
          id: `session-${sessions.length + 1}`,
          title: title ?? null,
          titleSource: title === undefined ? null : "owner",
          environment: record.environment,
          workspace: record.id,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        };

        const created: SessionRecord = origin === undefined ? made : { ...made, origin };

        sessions.unshift(created);

        return created;
      }),
    listSessions: () => Effect.sync(() => [...sessions]),
    getSession: ({ id }) =>
      Effect.sync(() => Option.getOrNull(Arr.findFirst(sessions, (session) => session.id === id))),
    archiveSession: ({ id }) => setArchived(id, 7, "archiveSession"),
    unarchiveSession: ({ id }) => setArchived(id, null, "unarchiveSession"),
    deleteSession: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteSession:${id}`);

        return remove(sessions, (session) => session.id === id);
      }),
    renameSession: ({ id, title }) =>
      Effect.sync(() => {
        calls.push("renameSession");

        const found = Arr.findFirst(sessions, (session) => session.id === id);

        if (Option.isNone(found)) return null;

        const renamed: SessionRecord = { ...found.value, title, titleSource: "owner" };

        sessions.splice(sessions.indexOf(found.value), 1, renamed);

        return renamed;
      }),
    setSessionStatus: () => Effect.void,
    setGeneratedTitle: () => Effect.succeed(false),
    createEnvironment: ({ name }) =>
      Effect.sync((): EnvironmentNaming => {
        calls.push("createEnvironment");

        if (nameTaken(name, "")) return { status: "taken" };

        const environment: EnvironmentRecord = {
          id: String(environments.length).padStart(8, "0"),
          name,
          repos: [],
          createdAt: environments.length,
        };

        environments.unshift(environment);

        return { status: "named", environment };
      }),
    getEnvironment: ({ id }) =>
      Effect.sync(() => Option.getOrNull(Arr.findFirst(environments, (item) => item.id === id))),
    listEnvironments: () => Effect.sync(() => [...environments]),
    renameEnvironment: ({ id, name }) =>
      Effect.sync((): EnvironmentNaming => {
        calls.push("renameEnvironment");

        if (nameTaken(name, id)) return { status: "taken" };

        const renamed = replace(
          environments,
          (item) => item.id === id,
          (item): EnvironmentRecord => ({ ...item, name }),
        );

        return renamed === null ? { status: "missing" } : { status: "named", environment: renamed };
      }),
    deleteEnvironment: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteEnvironment:${id}`);

        if (id === DEFAULT_ENVIRONMENT) return "refused" as const;

        if (Arr.some(workspaces, (workspace) => workspace.environment === id) || spares.has(id)) {
          return "in-use" as const;
        }

        return remove(environments, (item) => item.id === id)
          ? ("deleted" as const)
          : ("missing" as const);
      }),
    addRepo: ({ environment, name, url }) =>
      Effect.sync((): RepoChange => {
        calls.push("addRepo");

        const found = Arr.findFirst(environments, (item) => item.id === environment);

        if (Option.isNone(found)) return "missing";

        if (Arr.some(found.value.repos, (repo) => repo.name === name)) return "taken";

        replace(
          environments,
          (item) => item.id === environment,
          (item): EnvironmentRecord => ({ ...item, repos: [...item.repos, { name, url }] }),
        );

        return "changed";
      }),
    removeRepo: ({ environment, name }) =>
      Effect.sync((): RepoChange => {
        calls.push("removeRepo");

        const found = Arr.findFirst(environments, (item) => item.id === environment);

        if (Option.isNone(found)) return "missing";

        if (!Arr.some(found.value.repos, (repo) => repo.name === name)) return "absent";

        replace(
          environments,
          (item) => item.id === environment,
          (item): EnvironmentRecord => ({
            ...item,
            repos: Arr.filter(item.repos, (repo) => repo.name !== name),
          }),
        );

        return "changed";
      }),
    getEnvironmentSettings: ({ environment }) =>
      Effect.sync(() => {
        if (!Arr.some(environments, (item) => item.id === environment)) return null;

        const overrides = overridesOf.get(environment) ?? {};

        return {
          // SAFETY: the tests only save overrides of the settings' own shape.
          settings: { ...DEFAULT_CONTAINER_SETTINGS, ...(overrides as object) },
          overrides,
        };
      }),
    updateEnvironmentSettings: ({ environment, overrides }) =>
      Effect.sync(() => {
        calls.push("updateEnvironmentSettings");

        if (!Arr.some(environments, (item) => item.id === environment)) {
          return { status: "missing" as const };
        }

        if (overrides === null) {
          return { status: "rejected" as const, message: "idleMinutes: Expected a number" };
        }

        overridesOf.set(environment, overrides);

        return {
          status: "saved" as const,
          // SAFETY: the tests only save overrides of the settings' own shape.
          state: {
            settings: { ...DEFAULT_CONTAINER_SETTINGS, ...(overrides as object) },
            overrides,
          },
        };
      }),
    // The Session DO makes Agent changes, never the endpoint.
    changeEnvironment: () => Effect.die("The endpoint makes no Agent change"),
    listAgentChanges: ({ environment }) =>
      Effect.sync(() =>
        Arr.some(environments, (item) => item.id === environment)
          ? Arr.filter(agentChanges, (change) => change.scope === environment).toReversed()
          : null,
      ),
    // A revert of a variable, over the saved overrides, as the Registry DO's (`revertAgentChange`).
    revertAgentChange: ({ environment, change }) =>
      Effect.sync((): AgentChangeRevert => {
        calls.push(`revertAgentChange:${change}`);

        const found = Arr.findFirst(
          agentChanges,
          (item) => item.scope === environment && item.id === change,
        );

        if (Option.isNone(found)) return { status: "missing" };

        if (found.value.actor === "owner")
          return { status: "refused", message: "A revert is not undone" };

        const name = found.value.field.slice("variables.".length);

        // SAFETY: the tests only save overrides of the settings' own shape.
        const overrides = (overridesOf.get(environment) ?? {}) as {
          readonly variables?: Readonly<Record<string, string>>;
        };

        const { [name]: now = null, ...others } = overrides.variables ?? {};

        if (now !== found.value.after) {
          return { status: "changed-since", field: found.value.field, current: now };
        }

        // The tests revert variables only, whose values are strings.
        const before = Option.getOrNull(
          Option.liftPredicate(found.value.before, Predicate.isString),
        );

        const variables = before === null ? others : { ...others, [name]: before };

        overridesOf.set(environment, { ...overrides, variables });

        const revert: AgentChange = {
          ...found.value,
          id: agentChanges.length + 1,
          actor: "owner",
          session: null,
          conversation: null,
          tool: null,
          reason: `Reverted change ${change}`,
          before: now,
          after: found.value.before,
          reverts: change,
        };

        agentChanges.push(revert);

        return {
          status: "reverted",
          change: revert,
          state: {
            settings: { ...DEFAULT_CONTAINER_SETTINGS, variables },
            overrides: { variables },
          },
        };
      }),
    getWorkspace: ({ id }) =>
      Effect.sync(() =>
        Option.getOrNull(Arr.findFirst(workspaces, (workspace) => workspace.id === id)),
      ),
    getWorkspaceSetup: ({ id }) =>
      Effect.sync(() => {
        const found = Arr.findFirst(workspaces, (workspace) => workspace.id === id);

        if (Option.isNone(found)) return null;

        const { environment, branch, base } = found.value;

        return {
          id,
          environment,
          branch,
          base,
          repos: [],
          settings: overridesOf.get(environment) ?? {},
          build: buildRecords.get(environment)?.build ?? null,
          secrets: keptFor(environment),
        };
      }),
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    upkeepSpares: ({ environments: named }) =>
      Effect.sync(() => {
        calls.push(`upkeepSpares:${named === undefined ? "*" : Arr.join(named, ",")}`);

        const stale: string[] = [];

        const made: Array<
          WorkspaceSetup & {
            settings: Schema.Json;
            build: BuildRecord["build"];
            secrets: ReadonlyArray<KeptSecret>;
          }
        > = [];

        for (const environment of named ?? Arr.map(environments, (item) => item.id)) {
          const found = Arr.findFirst(environments, (item) => item.id === environment);

          if (Option.isNone(found)) continue;

          const spare = spares.get(environment);
          const repos = addresses(found.value.repos);
          const build = goodBuildOf(environment);

          if (spare !== undefined) {
            if (spare.repos !== repos || spare.build !== build) stale.push(spare.id);

            continue;
          }

          const id = `5a${String(++sparesMade).padStart(6, "0")}`;

          spares.set(environment, { id, repos, build });
          made.push({
            id,
            environment,
            branch: "cloudpid/spare",
            base: null,
            repos: found.value.repos,
            settings: overridesOf.get(environment) ?? {},
            build: buildRecords.get(environment)?.build ?? null,
            secrets: keptFor(environment),
          });
        }

        return { stale, made };
      }),
    buildWork: ({ environments: named }) =>
      Effect.sync(() => {
        calls.push(`buildWork:${named === undefined ? "*" : Arr.join(named, ",")}`);

        return Arr.map(
          Arr.filter(environments, (item) => named === undefined || named.includes(item.id)),
          (item) => ({
            environment: item.id,
            repos: item.repos,
            settings: overridesOf.get(item.id) ?? {},
            recorded: buildRecords.get(item.id) ?? NO_BUILD,
            secrets: buildDigestOf(item.id),
          }),
        );
      }),
    recordBuild: ({ environment, build, status }) =>
      Effect.sync(() => {
        calls.push(`recordBuild:${environment}`);
        buildRecords.set(environment, { build, status });
      }),
    listBuilds: () =>
      Effect.sync(() =>
        Arr.map(environments, (item) => ({
          environment: item.id,
          build: buildView(buildRecords.get(item.id) ?? NO_BUILD),
        })),
      ),
    listEnvironmentSecrets: () =>
      Effect.sync(() => {
        calls.push("listEnvironmentSecrets");

        return Arr.map(keptSecrets, ({ value: _value, ...record }) => record);
      }),
    setEnvironmentSecret: ({ environment, name, value, build }) =>
      Effect.sync(() => {
        calls.push(`setEnvironmentSecret:${environment ?? "*"}:${name}`);

        const problem = secretNameProblem(name) ?? secretValueProblem(value);

        if (problem !== undefined) return { status: "rejected" as const, message: problem };

        if (environment !== null && !Arr.some(environments, (item) => item.id === environment)) {
          return { status: "missing" as const };
        }

        const known = Arr.findFirst(
          keptSecrets,
          (item) => item.environment === environment && item.name === name,
        );

        if (
          Option.isNone(known) &&
          Arr.filter(keptSecrets, (item) => item.environment === environment).length >=
            MAX_ENVIRONMENT_SECRETS
        ) {
          return { status: "full" as const };
        }

        const record = {
          environment,
          name,
          build:
            build ?? Option.match(known, { onNone: () => false, onSome: (item) => item.build }),
          updatedAt: 9,
        };

        remove(keptSecrets, (item) => item.environment === environment && item.name === name);
        keptSecrets.push({ ...record, value });

        return { status: "saved" as const, record };
      }),
    setEnvironmentSecretBuild: ({ environment, name, build }) =>
      Effect.sync(() => {
        calls.push(`setEnvironmentSecretBuild:${environment ?? "*"}:${name}`);

        const changed = replace(
          keptSecrets,
          (item) => item.environment === environment && item.name === name,
          (item) => ({ ...item, build }),
        );

        if (changed === null) return null;

        const { value: _value, ...record } = changed;

        return record;
      }),
    deleteEnvironmentSecret: ({ environment, name }) =>
      Effect.sync(() => {
        calls.push(`deleteEnvironmentSecret:${environment ?? "*"}:${name}`);

        return remove(
          keptSecrets,
          (item) => item.environment === environment && item.name === name,
        );
      }),
    environmentSecrets: ({ environment }) =>
      Effect.sync(() => {
        calls.push(`environmentSecrets:${environment}`);

        return keptFor(environment);
      }),
    sessionSecrets: ({ session }) =>
      Effect.sync(() =>
        Option.match(
          Arr.findFirst(sessions, (item) => item.id === session),
          { onNone: () => [], onSome: (item) => keptFor(item.environment) },
        ),
      ),
    getSpare: ({ environment }) => Effect.sync(() => spares.get(environment)?.id ?? null),
    forgetSpare: ({ id }) =>
      Effect.sync(() => {
        calls.push(`forgetSpare:${id}`);
        beforeForgetSpare?.();
        beforeForgetSpare = undefined;

        for (const [environment, spare] of spares) {
          if (spare.id === id) return spares.delete(environment);
        }

        return false;
      }),
    deleteWorkspace: ({ id }) =>
      Effect.sync(() => {
        calls.push(`deleteWorkspace:${id}`);

        if (Arr.some(sessions, (session) => session.workspace === id)) return "in-use" as const;

        return remove(workspaces, (workspace) => workspace.id === id)
          ? ("deleted" as const)
          : ("missing" as const);
      }),
    takeLegacy: ({ limit }) =>
      Effect.sync(() => {
        calls.push("takeLegacy");

        return legacyObjects.slice(0, limit);
      }),
    forgetLegacy: (object) =>
      Effect.sync(() => {
        calls.push(`forgetLegacy:${object.kind}:${object.id}`);
        remove(legacyObjects, (held) => held.kind === object.kind && held.id === object.id);
      }),
    getSettings: () =>
      Effect.sync(() => {
        calls.push("getSettings");

        return { settings: DEFAULT_SETTINGS, overrides: {} };
      }),
    getPush: ({ endpoint }) =>
      Effect.sync(() => {
        calls.push("getPush");

        return { publicKey: "PUBLIC", subscribed: endpoint !== undefined && pushes.has(endpoint) };
      }),
    subscribePush: ({ subscription }) =>
      Effect.sync(() => {
        calls.push("subscribePush");
        pushes.add(subscription.endpoint);
      }),
    unsubscribePush: ({ endpoint }) =>
      Effect.sync(() => {
        calls.push("unsubscribePush");
        pushes.delete(endpoint);
      }),
    notify: () => Effect.void,
    updateSettings: ({ overrides }) =>
      Effect.sync(() => {
        calls.push("updateSettings");

        return overrides === null
          ? SettingsUpdate.Rejected({ message: "model: Expected an object" })
          : SettingsUpdate.Saved({
              state: {
                settings: { ...DEFAULT_SETTINGS, thinkingLevel: "low" },
                overrides: { thinkingLevel: "low" },
              },
            });
      }),
  } satisfies RegistryMethods;

  // SAFETY: the endpoint only calls `getByName` on the namespace, and the result only through the methods above.
  const registries = {
    getByName: (name: string) => {
      names.push(name);

      return registry;
    },
  } as never;

  const upkeepOfSpares = spareUpkeep(registries, { workspaces: workspaceObjects });

  return {
    names,
    calls,
    sessions,
    workspaces,
    environments,
    agentChanges,
    sessionObjects,
    workspaceObjects,
    breakSession: (id: string, message: string) => {
      brokenSessions.set(id, message);
    },
    runningSessions,
    imported,
    finished,
    /** Fail the Workspace objects' carries with `message`. */
    failCarry: (message: string) => {
      carryFails = message;
    },
    /** Register the Session `make` gives while each of the next `times` Workspace objects is wiped, as a client starting one then would. */
    startDuringDestroy: (make: () => SessionRecord, times = 1) => {
      duringDestroy = Arr.makeBy(times, () => () => {
        sessions.push(make());
      });
    },
    /** Run `change` as the next `createSession` reaches the Registry, before it looks at what it is asked for. */
    beforeCreate: (change: () => void) => {
      beforeCreate = change;
    },
    /** Run `change` as the next `forgetSpare` reaches the Registry, before it looks. */
    beforeForgetSpare: (change: () => void) => {
      beforeForgetSpare = change;
    },
    /** Run `change` once the next `prepareSpare` has reached the spare's object. */
    duringPrepare: (change: () => void) => {
      duringPrepare = change;
    },
    /** Run `change` once the next `startBuild` has reached the Build object. */
    duringStartBuild: (change: () => void) => {
      duringStartBuild = change;
    },
    /** Fail the Workspace objects' calls with `message`; undefined, not any more. */
    failWorkspace: (message: string | undefined) => {
      workspaceFails = message;
    },
    /** The objects left from before Environments. */
    legacyObjects,
    /** What `legacy` ran: the cleanup the endpoint starts after a Session list. */
    legacy: Effect.sync(() => {
      calls.push("legacy");
    }),
    /** The work handed to `background` is run when the test says so. */
    background: (effect: Effect.Effect<void>) =>
      Effect.sync(() => {
        queued.push(effect);
      }),
    /** Run the work handed to `background` so far. */
    runBackground: async () => {
      for (const effect of queued.splice(0)) await Effect.runPromise(effect);
    },
    lookups,
    lookupsAsked,
    registries,
    /** The Registry's methods, as the Session DO calls them. */
    registry,
    /** Each Environment's spare Workspace. */
    spares,
    /** The upkeep of the spares, built once per fake as the main Worker builds it once per isolate. */
    spareUpkeep: upkeepOfSpares,
    /** The upkeep of the Builds, built once per fake too. */
    buildUpkeep: buildUpkeep(registries, { workspaces: workspaceObjects, spares: upkeepOfSpares }),
    spareBuilds,
    buildObjects,
    buildRequests,
    buildRecords,
    buildSecrets,
    spareSecrets,
    keptSecrets,
    overridesOf,
  };
};

class Registry extends Context.Service<
  Registry,
  RpcClient.FromGroup<typeof RegistryRpcs, RpcClientError>
>()("@cloudpid/server/registry/rpc.test/Registry") {}

/** The main Worker's routing and `RegistryRpcs` endpoint, answering `fetch` calls in memory. */
const worker =
  (fake: ReturnType<typeof fakeRegistries>) => (input: RequestInfo | URL, init?: RequestInit) => {
    const request = HttpServerRequest.fromWeb(new Request(input, init));

    // Routed as the main Worker routes it.
    if (!isRegistryRpc(request)) return Promise.resolve(new Response(null, { status: 404 }));

    return serveRegistryRpc(fake.registries, {
      workspaces: fake.workspaceObjects,
      sessions: fake.sessionObjects,
      legacy: fake.legacy,
      spares: fake.spareUpkeep,
      builds: fake.buildUpkeep,
      lookups: fake.lookups,
      background: fake.background,
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );
  };

/** Run `program` with a client of `RegistryRpcs` whose requests the main Worker's endpoint answers in memory. */
const withClient = <A, E>(
  program: Effect.Effect<A, E, Registry>,
  fake = fakeRegistries(),
): Promise<A> => {
  const client = Layer.effect(Registry, RpcClient.make(RegistryRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: `http://worker.test${RPC_PATH}` })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
    // SAFETY: the client calls `fetch` with a URL and an init only, which `worker` takes.
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, worker(fake) as typeof fetch)),
  );

  // The test is the client's entry point.
  // @effect-diagnostics-next-line strictEffectProvide:off
  return Effect.runPromise(program.pipe(Effect.provide(client)));
};

/**
 * Call `tag` with `payload` as a hand-written client would: one Effect RPC request in JSON, unchecked by the shared
 * schemas. The answer is the endpoint's JSON text, and the Registry methods the call reached.
 */
const callRaw = async (tag: string, payload: Schema.Json) => {
  const fake = fakeRegistries();

  const response = await worker(fake)(`http://worker.test${RPC_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"_tag":"Request","id":"1","tag":"${tag}","payload":${JSON.stringify(payload)},"headers":[]}`,
  });

  return { text: await response.text(), calls: fake.calls };
};

it("creates a Session in the singleton Registry and lists it", async () => {
  const fake = fakeRegistries();

  const [created, listed] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const session = yield* registry.createSession({ title: "Fix the build" });

      return [session, yield* registry.listSessions()] as const;
    }),
    fake,
  );

  expect(created).toMatchObject({ id: "session-1", title: "Fix the build", status: "idle" });
  expect(listed).toEqual([created]);
  expect(fake.names).toEqual(["registry", "registry"]);
});

it("renames a Session, which is the owner's title from then on", async () => {
  const fake = fakeRegistries();

  const [renamed, listed] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const session = yield* registry.createSession({});

      return [
        yield* registry.renameSession({ id: session.id, title: "Fix the build" }),
        yield* registry.listSessions(),
      ] as const;
    }),
    fake,
  );

  expect(renamed).toMatchObject({ title: "Fix the build", titleSource: "owner" });
  expect(listed).toEqual([renamed]);
});

it("fails to rename a Session the Registry does not know", async () => {
  const error = await withClient(
    Registry.pipe(
      Effect.flatMap((registry) => registry.renameSession({ id: "ghost", title: "Nope" })),
      Effect.flip,
    ),
  );

  expect(error).toBeInstanceOf(SessionNotFound);
  expect(error.message).toContain("ghost");
});

it("rejects a new title that is blank or longer than 200 characters, before it reaches the Registry", async () => {
  for (const title of ["   ", "a".repeat(201)]) {
    const { text, calls } = await callRaw("renameSession", { id: "s", title });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("trims a title on the server", async () => {
  const { text } = await callRaw("createSession", { title: "  Fix the build \n" });

  expect(JSON.parse(text)).toMatchObject([{ exit: { value: { title: "Fix the build" } } }]);
});

it("rejects a title that is blank or longer than 200 characters, before it reaches the Registry", async () => {
  for (const title of ["   ", "a".repeat(201)]) {
    const { text, calls } = await callRaw("createSession", { title });

    expect(text).toContain('"Failure"');
    expect(calls).toEqual([]);
  }

  expect((await callRaw("createSession", { title: "a".repeat(200) })).calls).toEqual([
    "createSession",
  ]);
});

it("subscribes a browser to Web Push, tells it so, and forgets it when it unsubscribes", async () => {
  const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/abc";

  const [before, after, gone] = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const before = yield* registry.getPush({ endpoint });

      yield* registry.subscribePush({
        subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
      });

      const after = yield* registry.getPush({ endpoint });

      yield* registry.unsubscribePush({ endpoint });

      return [before, after, yield* registry.getPush({ endpoint })] as const;
    }),
  );

  expect(before).toEqual({ publicKey: "PUBLIC", subscribed: false });
  expect(after).toEqual({ publicKey: "PUBLIC", subscribed: true });
  expect(gone.subscribed).toBe(false);
});

it("serves the VAPID public key to a browser that has no subscription yet", async () => {
  const state = await withClient(Effect.flatMap(Registry, (registry) => registry.getPush({})));

  expect(state).toEqual({ publicKey: "PUBLIC", subscribed: false });
});

it("rejects a subscription that is not at a known push service over https, before it reaches the Registry", async () => {
  for (const endpoint of [
    "http://updates.push.services.mozilla.com/wpush/v2/abc",
    "http://169.254.169.254/latest",
    "https://127.0.0.1/x",
    "https://internal.example/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    "https://push.apple.com/x",
  ]) {
    const { text, calls } = await callRaw("subscribePush", {
      subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
    });

    expect(text, endpoint).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("accepts the endpoints the browsers' push services give out", async () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGx",
    "https://wns2-by3p.notify.windows.com/?token=abc",
  ]) {
    const { calls } = await callRaw("subscribePush", {
      subscription: { endpoint, keys: { p256dh: "k", auth: "a" } },
    });

    expect(calls, endpoint).toEqual(["subscribePush"]);
  }
});

it("reads the settings from the singleton Registry", async () => {
  const fake = fakeRegistries();

  const state = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* registry.getSettings();
    }),
    fake,
  );

  expect(state).toEqual({ settings: DEFAULT_SETTINGS, overrides: {} });
  expect(fake.names).toEqual(["registry"]);
});

it("saves settings overrides in the Registry and answers the settings in force", async () => {
  const state = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* registry.updateSettings({ overrides: { thinkingLevel: "low" } });
    }),
  );

  expect(state).toMatchObject({
    settings: { thinkingLevel: "low" },
    overrides: { thinkingLevel: "low" },
  });
});

it("fails an update the Registry rejects with the Registry's readable message", async () => {
  const error = await withClient(
    Effect.gen(function* () {
      const registry = yield* Registry;

      return yield* Effect.flip(registry.updateSettings({ overrides: null }));
    }),
  );

  expect(error).toBeInstanceOf(SettingsError);
  expect(error.message).toBe("model: Expected an object");
});

/** A client of the endpoint, as `withClient` gives it. */
const call = <A, E>(
  fake: ReturnType<typeof fakeRegistries>,
  use: (registry: Registry["Service"]) => Effect.Effect<A, E>,
) => withClient(Effect.flatMap(Registry, use), fake);

/** The calls that reached a Session's or a Workspace's object, or forgot or archived a record, in order. */
const lifecycle = (fake: ReturnType<typeof fakeRegistries>) =>
  Arr.filter(fake.calls, (name) =>
    /^(stop|destroy|destroyWorkspace|restartContainer|prepareSpare|startBuild|deleteSession|deleteWorkspace|deleteEnvironment|forgetSpare):|^(archive|unarchive)Session$/.test(
      name,
    ),
  );

/** Make an Environment named `name`; its id. */
const makeEnvironment = (fake: ReturnType<typeof fakeRegistries>, name: string) =>
  call(fake, (registry) => registry.createEnvironment({ name })).then((made) => made.id);

it("creates a Session in a new Workspace of the default Environment, on its own branch", async () => {
  const fake = fakeRegistries();

  const created = await call(fake, (registry) => registry.createSession({}));
  const [workspace] = await call(fake, (registry) => registry.listWorkspaces());

  expect(created).toMatchObject({ environment: DEFAULT_ENVIRONMENT, workspace: "00000001" });
  expect(workspace).toEqual({
    id: "00000001",
    environment: DEFAULT_ENVIRONMENT,
    branch: "cloudpid/00000001",
    base: null,
    repos: [],
    directory: "/workspace",
    createdAt: 1,
  });
});

it("makes a new Workspace of the Environment, branch and base the Session names", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }));

  const created = await call(fake, (registry) =>
    registry.createSession({ environment, workspace: "new", branch: "feature/x", base: "dev" }),
  );

  expect(created).toMatchObject({ environment, workspace: "00000001" });
  expect(await call(fake, (registry) => registry.listWorkspaces())).toMatchObject([
    {
      environment,
      branch: "feature/x",
      base: "dev",
      repos: ["cloudpid"],
      directory: "/workspace/cloudpid",
    },
  ]);
});

it("makes every new Session a Workspace of its own", async () => {
  const fake = fakeRegistries();

  const first = await call(fake, (registry) => registry.createSession({}));
  const second = await call(fake, (registry) => registry.createSession({}));

  expect(second.workspace).not.toBe(first.workspace);
  expect(fake.workspaces).toHaveLength(2);
});

it("creates a Session in a Workspace that exists, which brings its Environment", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");
  const first = await call(fake, (registry) => registry.createSession({ environment }));

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  const third = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace, environment }),
  );

  expect(second).toMatchObject({ environment, workspace: first.workspace });
  expect(third).toMatchObject({ environment, workspace: first.workspace });
  expect(fake.workspaces).toHaveLength(1);
});

it("refuses a Session in a Workspace of another Environment than the one it names", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));
  const other = await makeEnvironment(fake, "Other");

  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: first.workspace, environment: other })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe(
    `Workspace "${first.workspace}" is in environment "${DEFAULT_ENVIRONMENT}"`,
  );
  expect(fake.calls).toEqual([]);
});

it("refuses a branch or a base for a Workspace that exists, before it reaches the Registry", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  for (const extra of [{ branch: "x" }, { base: "main" }]) {
    const error = await call(fake, (registry) =>
      Effect.flip(registry.createSession({ workspace: first.workspace, ...extra })),
    );

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.message).toBe("A branch and a base are only for a new workspace");
  }

  expect(fake.calls).toEqual([]);
});

it("refuses a Session in a Workspace the Registry does not list", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: "deadbeef" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('No workspace "deadbeef"');
  expect(fake.calls).toEqual([]);
});

it("says so when the Workspace is removed just before the Session is registered in it", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.beforeCreate(() => {
    fake.workspaces.length = 0;
  });

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ workspace: first.workspace })),
  );

  expect(error.message).toBe("That workspace does not exist any more");
});

it("refuses a Session in an Environment the Registry does not list", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ environment: "0000beef" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('Environment "0000beef" does not exist');
  expect(fake.workspaces).toEqual([]);
});

it("refuses a new Workspace on a branch another Workspace of the Environment is on, naming it", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createSession({ branch: "feature" }));

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ branch: "feature" })),
  );

  expect(error.message).toBe(
    'Workspace "00000001" is already on branch feature: start a session in it instead',
  );
  expect(fake.workspaces).toHaveLength(1);
  expect(fake.sessions).toHaveLength(1);
});

it("rejects an Environment, Workspace or branch that is not one, before it reaches the Registry", async () => {
  for (const payload of [
    { environment: "Not An Id" },
    { workspace: "Not-An-Id" },
    { workspace: "123" },
    { branch: "a..b" },
    { branch: "-x" },
    { base: "HEAD" },
  ]) {
    const { text, calls } = await callRaw("createSession", payload);

    expect(text, JSON.stringify(payload)).toContain('"Failure"');
    expect(calls).toEqual([]);
  }
});

it("deletes a Session without touching its Workspace while another Session, archived too, is in it", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  const archived = await call(fake, (registry) =>
    registry.createSession({ workspace: session.workspace }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: archived.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));

  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`, `deleteSession:${session.id}`]);
  expect(Arr.map(await call(fake, (registry) => registry.listSessions()), (s) => s.id)).toEqual([
    archived.id,
  ]);
  expect(await call(fake, (registry) => registry.listWorkspaces())).toMatchObject([
    { id: session.workspace },
  ]);
});

it("removes a Workspace with its last Session: the Session, then the Workspace's object, then its record", async () => {
  const fake = fakeRegistries();
  const kept = await call(fake, (registry) => registry.createSession({}));
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${session.id}`,
    `deleteSession:${session.id}`,
    `destroyWorkspace:ws:${session.workspace}`,
    `deleteWorkspace:${session.workspace}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([kept]);
  expect(Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.id)).toEqual([
    kept.workspace,
  ]);
});

it("deletes the last Session of a Workspace whose object cannot be wiped, keeping the Workspace listed", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.failWorkspace("unreachable");
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${session.id}`,
    `deleteSession:${session.id}`,
    `destroyWorkspace:ws:${session.workspace}`,
  ]);
  expect(fake.sessions).toEqual([]);
  expect(Arr.map(fake.workspaces, (w) => w.id)).toEqual([session.workspace]);
});

it("keeps the Workspace of a deleted last Session when another starts in it while its object is wiped", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.startDuringDestroy(() => ({ ...session, id: "late" }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteSession({ id: session.id }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${session.id}`,
    `deleteSession:${session.id}`,
    `destroyWorkspace:ws:${session.workspace}`,
    `deleteWorkspace:${session.workspace}`,
  ]);
  expect(Arr.map(fake.sessions, (s) => s.id)).toEqual(["late"]);
  expect(Arr.map(fake.workspaces, (w) => w.id)).toEqual([session.workspace]);
});

it("lists the default Environment, and the ones created, newest first", async () => {
  const fake = fakeRegistries();

  const made = await call(fake, (registry) => registry.createEnvironment({ name: "Cloudpid" }));
  const listed = await call(fake, (registry) => registry.listEnvironments());

  expect(made).toEqual({ id: "00000001", name: "Cloudpid", repos: [], createdAt: 1 });
  expect(Arr.map(listed, (environment) => environment.id)).toEqual([
    "00000001",
    DEFAULT_ENVIRONMENT,
  ]);
});

it("trims an Environment name on the server, and rejects one that is blank or too long", async () => {
  const { text } = await callRaw("createEnvironment", { name: "  Cloudpid \n" });

  expect(JSON.parse(text)).toMatchObject([{ exit: { value: { name: "Cloudpid" } } }]);

  for (const name of ["   ", "a".repeat(81)]) {
    const rejected = await callRaw("createEnvironment", { name });

    expect(rejected.text).toContain('"Failure"');
    expect(rejected.calls).toEqual([]);
  }
});

it("refuses an Environment name another has in any case", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createEnvironment({ name: "DEFAULT" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe('Another environment is already named "DEFAULT"');
});

it("renames an Environment, and refuses a name another has or an Environment that is not listed", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");

  const renamed = await call(fake, (registry) =>
    registry.renameEnvironment({ environment: id, name: "Pi" }),
  );

  const taken = await call(fake, (registry) =>
    Effect.flip(registry.renameEnvironment({ environment: id, name: "default" })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.renameEnvironment({ environment: "0000beef", name: "Anything" })),
  );

  expect(renamed).toMatchObject({ id, name: "Pi" });
  expect(taken.message).toBe('Another environment is already named "default"');
  expect(missing).toBeInstanceOf(EnvironmentError);
  expect(missing.message).toBe('Environment "0000beef" does not exist');
});

it("deletes an Environment: every Workspace made from it, with its Sessions (archived too), its Build object, then its record", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({ environment: id }));
  const second = await call(fake, (registry) => registry.createSession({ environment: id }));

  const sharing = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: sharing.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.deleteEnvironment({ environment: id }));

  // Newest Workspace first; in each, its Sessions newest first, then its object, then its record.
  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroyWorkspace:ws:${second.workspace}`,
    `deleteWorkspace:${second.workspace}`,
    `destroy:${sharing.id}`,
    `deleteSession:${sharing.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    `destroyWorkspace:ws:${first.workspace}`,
    `deleteWorkspace:${first.workspace}`,
    `destroyWorkspace:build:${id}`,
    `deleteEnvironment:${id}`,
    // Again, for a Build asked for after the first wipe.
    `destroyWorkspace:build:${id}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.id)).toEqual([
    elsewhere.workspace,
  ]);
  expect(
    Arr.map(await call(fake, (registry) => registry.listEnvironments()), (item) => item.id),
  ).toEqual([DEFAULT_ENVIRONMENT]);
});

it("deletes an Environment with no Workspaces: its Build object, then its record, then its Build object again", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Empty");

  await call(fake, (registry) => registry.deleteEnvironment({ environment: id }));

  expect(lifecycle(fake)).toEqual([
    `destroyWorkspace:build:${id}`,
    `deleteEnvironment:${id}`,
    `destroyWorkspace:build:${id}`,
  ]);
});

it("refuses to delete the default Environment, and touches nothing", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.createSession({}));
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: DEFAULT_ENVIRONMENT })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("The default environment cannot be deleted");
  expect(fake.calls).toEqual([]);
});

it("refuses to delete an Environment the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: "0000beef" })),
  );

  expect(error.message).toBe('Environment "0000beef" does not exist');
  expect(lifecycle(fake)).toEqual([]);
});

it("stops an Environment delete at a Session that cannot be wiped, keeping what is left listed", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");
  const session = await call(fake, (registry) => registry.createSession({ environment: id }));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: id })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("storage error");
  expect(error.message).toContain("The environment and its remaining workspaces are kept.");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
  expect(fake.environments).toHaveLength(2);
  expect(fake.workspaces).toHaveLength(1);
});

it("removes a Workspace: every Session in it, archived ones too, then its object, then its record", async () => {
  const fake = fakeRegistries();
  const elsewhere = await call(fake, (registry) => registry.createSession({}));
  const first = await call(fake, (registry) => registry.createSession({}));

  const second = await call(fake, (registry) =>
    registry.createSession({ workspace: first.workspace }),
  );

  await call(fake, (registry) => registry.archiveSession({ id: first.id }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: first.workspace }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${second.id}`,
    `deleteSession:${second.id}`,
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    `destroyWorkspace:ws:${first.workspace}`,
    `deleteWorkspace:${first.workspace}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([elsewhere]);
  expect(Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.id)).toEqual([
    elsewhere.workspace,
  ]);
});

it("removes a Workspace that has no Sessions left", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  // Its object could not be wiped with its last Session, so it is still listed.
  fake.failWorkspace("unreachable");
  await call(fake, (registry) => registry.deleteSession({ id: session.id }));
  fake.failWorkspace(undefined);
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: session.workspace }));

  expect(lifecycle(fake)).toEqual([
    `destroyWorkspace:ws:${session.workspace}`,
    `deleteWorkspace:${session.workspace}`,
  ]);
  expect(fake.workspaces).toEqual([]);
});

it("deletes a Session started in a Workspace while it was removed, before its record goes", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  fake.startDuringDestroy(() => ({ ...first, id: "late" }));
  fake.calls.length = 0;

  await call(fake, (registry) => registry.removeWorkspace({ id: first.workspace }));

  const object = `destroyWorkspace:ws:${first.workspace}`;
  const record = `deleteWorkspace:${first.workspace}`;

  expect(lifecycle(fake)).toEqual([
    `destroy:${first.id}`,
    `deleteSession:${first.id}`,
    object,
    record,
    "destroy:late",
    "deleteSession:late",
    object,
    record,
  ]);
  expect(fake.sessions).toEqual([]);
  expect(fake.workspaces).toEqual([]);
});

it("gives up on a Workspace Sessions keep starting in, keeping it listed", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));
  let started = 0;

  fake.startDuringDestroy(() => ({ ...first, id: `late-${started++}` }), 10);

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: first.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("kept starting");
  expect(fake.workspaces).toHaveLength(1);
});

it("stops a Workspace removal at a Session that cannot be wiped, before its files", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "storage error");
  fake.calls.length = 0;

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("storage error");
  expect(error.message).toContain("The workspace and its remaining sessions are kept.");
  expect(lifecycle(fake)).toEqual([`destroy:${session.id}`]);
  expect(fake.sessions).toHaveLength(1);
  expect(fake.workspaces).toHaveLength(1);
});

it("keeps a Workspace record whose object could not be wiped, with its Sessions already gone", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.failWorkspace("storage error");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("Could not delete the workspace's files: storage error");
  expect(fake.sessions).toEqual([]);
  expect(fake.workspaces).toHaveLength(1);
});

it("refuses to remove or restart a Workspace the Registry does not list, and touches no object", async () => {
  const fake = fakeRegistries();

  const removal = await call(fake, (registry) =>
    Effect.flip(registry.removeWorkspace({ id: "deadbeef" })),
  );

  const restart = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: "deadbeef" })),
  );

  expect(removal).toBeInstanceOf(EnvironmentError);
  expect(removal.message).toBe('No workspace "deadbeef"');
  expect(restart.message).toBe('No workspace "deadbeef"');
  expect(lifecycle(fake)).toEqual([]);
});

it("restarts a Workspace's Container by its object's name, keeping its Sessions", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.calls.length = 0;

  await call(fake, (registry) => registry.restartContainer({ workspace: session.workspace }));

  expect(lifecycle(fake)).toEqual([`restartContainer:ws:${session.workspace}`]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("looks up the draft's catalog and files in the Workspace it names, in its directory", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }));

  const session = await call(fake, (registry) => registry.createSession({ environment }));
  const workspace = session.workspace;

  const catalog = await call(fake, (registry) => registry.draftCatalog({ environment, workspace }));

  const files = await call(fake, (registry) =>
    registry.draftFiles({ environment, workspace, query: "src/app" }),
  );

  expect(catalog).toEqual({
    commands: [],
    templates: [],
    skills: [{ name: "tdd", description: "Test first" }],
  });
  expect(files).toEqual({ paths: ["src/app.ts"] });
  expect(fake.lookupsAsked).toEqual([
    `catalog:ws:${workspace}:/workspace/cloudpid`,
    `files:ws:${workspace}:/workspace/cloudpid:src/app`,
  ]);
});

it("looks up a new Workspace's draft in the Environment's spare, where its Repos are", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }));
  await call(fake, (registry) => registry.addRepo({ environment, source: "o/lib" }));
  fake.spares.set(environment, { id: "5a000009", repos: "", build: null });

  await call(fake, (registry) => registry.draftCatalog({ environment, workspace: "new" }));
  await call(fake, (registry) => registry.draftFiles({ environment, workspace: "new", query: "" }));

  expect(fake.lookupsAsked).toEqual([
    "catalog:ws:5a000009:/workspace",
    "files:ws:5a000009:/workspace:",
  ]);
});

it("answers a new Workspace's draft with nothing while its Environment has no spare, waking no object", async () => {
  const fake = fakeRegistries();

  const catalog = await call(fake, (registry) =>
    registry.draftCatalog({ environment: DEFAULT_ENVIRONMENT, workspace: "new" }),
  );

  const files = await call(fake, (registry) =>
    registry.draftFiles({ environment: DEFAULT_ENVIRONMENT, workspace: "new", query: "a" }),
  );

  expect(catalog).toEqual({ commands: [], templates: [], skills: [] });
  expect(files).toEqual({ paths: [] });
  expect(fake.lookupsAsked).toEqual([]);
});

it("refuses a draft lookup in an unknown Environment or Workspace, or one of another Environment", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");
  const session = await call(fake, (registry) => registry.createSession({}));

  const unknown = await call(fake, (registry) =>
    Effect.flip(registry.draftCatalog({ environment: "0000beef", workspace: "new" })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.draftFiles({ environment, workspace: "deadbeef", query: "" })),
  );

  const elsewhere = await call(fake, (registry) =>
    Effect.flip(registry.draftCatalog({ environment, workspace: session.workspace })),
  );

  expect(unknown.message).toBe('Environment "0000beef" does not exist');
  expect(missing.message).toBe('No workspace "deadbeef"');
  expect(elsewhere).toBeInstanceOf(EnvironmentError);
  expect(elsewhere.message).toBe(
    `Workspace "${session.workspace}" is in environment "${DEFAULT_ENVIRONMENT}"`,
  );
  expect(fake.lookupsAsked).toEqual([]);
});

it("fails a Container restart the Workspace could not do with its message", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.failWorkspace("container is gone");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.restartContainer({ workspace: session.workspace })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("Could not restart the Container: container is gone");
});

it("adds a Repo to an Environment from owner/repo, answering the directory it is cloned into", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  const name = await call(fake, (registry) =>
    registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }),
  );

  const url = await call(fake, (registry) =>
    registry.addRepo({ environment, source: "https://example.com/team/lib.git" }),
  );

  expect(name).toBe("cloudpid");
  expect(url).toBe("lib");
  expect(fake.environments[0]?.repos).toEqual([
    { name: "cloudpid", url: "https://github.com/ian-pascoe/cloudpid.git" },
    { name: "lib", url: "https://example.com/team/lib.git" },
  ]);
});

it("adds a Repo under the directory name the owner gives it", async () => {
  const fake = fakeRegistries();

  const name = await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app", name: "frontend" }),
  );

  expect(name).toBe("frontend");
  expect(fake.environments[0]?.repos).toEqual([
    { name: "frontend", url: "https://github.com/o/app.git" },
  ]);
});

it("refuses a Repo whose directory name the Environment has, asking for another", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app" }),
  );

  const error = await call(fake, (registry) =>
    Effect.flip(registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "p/app" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("The environment already has a repo in app: name this one");
  expect(fake.environments[0]?.repos).toHaveLength(1);

  // The owner's own name gets round it.
  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "p/app", name: "app-2" }),
  );
  expect(fake.environments[0]?.repos).toHaveLength(2);
});

it("refuses a source that is not a plain repo address before it reaches the Registry", async () => {
  const fake = fakeRegistries();

  for (const source of [
    "",
    "not a repo",
    "file:///etc/passwd",
    "ssh://git@github.com/o/r",
    "https://user:pw@github.com/o/r",
    "https://localhost/o/r",
    "--upload-pack=x",
  ]) {
    const error = await call(fake, (registry) =>
      Effect.flip(registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source })),
    );

    expect(error, source).toBeInstanceOf(EnvironmentError);
  }

  expect(fake.calls).toEqual([]);
});

it("refuses a Repo for an Environment the Registry does not list", async () => {
  const error = await call(fakeRegistries(), (registry) =>
    Effect.flip(registry.addRepo({ environment: "0000beef", source: "o/app" })),
  );

  expect(error.message).toBe('Environment "0000beef" does not exist');
});

it("rejects a directory name that is a path or an option, before it reaches the Registry", async () => {
  for (const name of ["..", "../x", "a/b", "-x", ".git", "a b"]) {
    const { text, calls } = await callRaw("addRepo", {
      environment: DEFAULT_ENVIRONMENT,
      source: "o/app",
      name,
    });

    expect(text, name).toContain('"Failure"');
    expect(calls).toEqual([]);
  }

  const removal = await callRaw("removeRepo", { environment: DEFAULT_ENVIRONMENT, repo: "../x" });

  expect(removal.text).toContain('"Failure"');
  expect(removal.calls).toEqual([]);
});

it("removes a Repo from an Environment, keeping the others", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/app" }),
  );
  await call(fake, (registry) =>
    registry.addRepo({ environment: DEFAULT_ENVIRONMENT, source: "o/pi" }),
  );
  await call(fake, (registry) =>
    registry.removeRepo({ environment: DEFAULT_ENVIRONMENT, repo: "app" }),
  );

  expect(Arr.map(fake.environments[0]?.repos ?? [], (repo) => repo.name)).toEqual(["pi"]);
});

it("refuses to remove a Repo the Environment does not have, or of an Environment not listed", async () => {
  const fake = fakeRegistries();

  const absent = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ environment: DEFAULT_ENVIRONMENT, repo: "ghost" })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.removeRepo({ environment: "0000beef", repo: "ghost" })),
  );

  expect(absent).toBeInstanceOf(EnvironmentError);
  expect(absent.message).toBe('The environment has no repo "ghost"');
  expect(missing.message).toBe('Environment "0000beef" does not exist');
});

it("reads an Environment's Container settings from the Registry", async () => {
  const fake = fakeRegistries();

  const state = await call(fake, (registry) =>
    registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
  );

  expect(state).toEqual({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} });
  expect(fake.names).toEqual(["registry"]);
});

it("saves an Environment's Container overrides and answers the settings in force", async () => {
  const fake = fakeRegistries();

  const saved = await call(fake, (registry) =>
    registry.updateEnvironmentSettings({
      environment: DEFAULT_ENVIRONMENT,
      overrides: { idleMinutes: 30 },
    }),
  );

  const read = await call(fake, (registry) =>
    registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
  );

  expect(saved).toMatchObject({ settings: { idleMinutes: 30 }, overrides: { idleMinutes: 30 } });
  expect(read).toEqual(saved);
});

it("fails overrides the Registry rejects with its readable message, saving nothing", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(
      registry.updateEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT, overrides: null }),
    ),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toBe("idleMinutes: Expected a number");
  expect(
    await call(fake, (registry) =>
      registry.getEnvironmentSettings({ environment: DEFAULT_ENVIRONMENT }),
    ),
  ).toMatchObject({ overrides: {} });
});

it("refuses the settings of an Environment the Registry does not list", async () => {
  const fake = fakeRegistries();

  for (const attempt of [
    (registry: Registry["Service"]) =>
      Effect.flip(registry.getEnvironmentSettings({ environment: "0000beef" })),
    (registry: Registry["Service"]) =>
      Effect.flip(registry.updateEnvironmentSettings({ environment: "0000beef", overrides: {} })),
  ]) {
    const error = await call(fake, attempt);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.message).toBe('Environment "0000beef" does not exist');
  }
});

/** An Agent change that set variable `name` of `environment` from `before` to `after`, as the Registry records it. */
const agentChange = (
  id: number,
  name: string,
  before: string | null,
  after: string | null,
  environment = DEFAULT_ENVIRONMENT,
): AgentChange => ({
  id,
  scope: environment,
  at: id * 1_000,
  actor: "agent",
  session: "s-1",
  conversation: 1,
  tool: "environment_variable_set",
  reason: "For the tests",
  field: `variables.${name}`,
  before,
  after,
  reverts: null,
  revertedBy: null,
});

it("lists an Environment's Agent changes, newest first, and refuses an Environment it does not list", async () => {
  const fake = fakeRegistries();

  fake.agentChanges.push(agentChange(1, "A", null, "1"), agentChange(2, "B", null, "2"));

  const listed = await call(fake, (registry) =>
    registry.listAgentChanges({ environment: DEFAULT_ENVIRONMENT }),
  );

  const error = await call(fake, (registry) =>
    Effect.flip(registry.listAgentChanges({ environment: "0000beef" })),
  );

  expect(Arr.map(listed, (change) => change.id)).toEqual([2, 1]);
  expect(error.message).toBe('Environment "0000beef" does not exist');
});

it("reverts an Agent change, answers the owner's change, and keeps the Build current after the answer", async () => {
  const fake = fakeRegistries();

  fake.overridesOf.set(DEFAULT_ENVIRONMENT, { variables: { A: "2" } });
  fake.agentChanges.push(agentChange(1, "A", "1", "2"));

  const reverted = await call(fake, (registry) =>
    registry.revertAgentChange({ environment: DEFAULT_ENVIRONMENT, change: 1 }),
  );

  expect(reverted).toMatchObject({ actor: "owner", before: "2", after: "1", reverts: 1 });
  expect(fake.overridesOf.get(DEFAULT_ENVIRONMENT)).toEqual({ variables: { A: "1" } });

  fake.calls.length = 0;
  await fake.runBackground();

  expect(fake.calls).toContain(`buildWork:${DEFAULT_ENVIRONMENT}`);
});

it("refuses to revert an Agent change whose variable changed since, showing its value now", async () => {
  const fake = fakeRegistries();

  fake.overridesOf.set(DEFAULT_ENVIRONMENT, { variables: { A: "3" } });
  fake.agentChanges.push(agentChange(1, "A", "1", "2"), agentChange(2, "B", "x", null));

  const changed = await call(fake, (registry) =>
    Effect.flip(registry.revertAgentChange({ environment: DEFAULT_ENVIRONMENT, change: 1 })),
  );

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.revertAgentChange({ environment: DEFAULT_ENVIRONMENT, change: 9 })),
  );

  expect(changed).toBeInstanceOf(EnvironmentError);
  expect(changed.message).toBe(
    'variables.A has changed since: it is "3" now, so the change is not reverted',
  );
  expect(missing.message).toBe('Environment "default" has no change 9');
  expect(fake.overridesOf.get(DEFAULT_ENVIRONMENT)).toEqual({ variables: { A: "3" } });
});

it("lists Workspaces of every Environment, newest first", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.createSession({}));
  await call(fake, (registry) => registry.createSession({ environment }));

  expect(
    Arr.map(await call(fake, (registry) => registry.listWorkspaces()), (w) => w.environment),
  ).toEqual([environment, DEFAULT_ENVIRONMENT]);
});

it("starts the legacy cleanup behind a Session list, after the answer", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
  // Handed to the background, not run before the answer.
  expect(fake.calls).not.toContain("legacy");

  await fake.runBackground();

  expect(fake.calls).toContain("legacy");
});

it("starts the legacy cleanup with no other call", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.listEnvironments());
  await call(fake, (registry) => registry.listWorkspaces());
  await fake.runBackground();

  expect(fake.calls).not.toContain("legacy");
});

/** Run `legacyCleanup` over the fake once, with the levels and messages it logged. */
const cleanup = async (fake: ReturnType<typeof fakeRegistries>) => {
  const logged: string[] = [];

  const collector = Logger.make((options) => {
    logged.push(`${options.logLevel}: ${String(Arr.ensure(options.message)[0])}`);
  });

  await Effect.runPromise(
    legacyCleanup(fake.registries, {
      sessions: fake.sessionObjects,
      workspaces: fake.workspaceObjects,
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collector]))),
  );

  return logged;
};

it("wipes what is left from before Environments: Session objects and Machines' Workspace objects, forgetting each", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    { kind: "session", id: "old-1" },
    { kind: "machine", id: "cloudpid" },
    { kind: "session", id: "old-2" },
  );

  expect(await cleanup(fake)).toEqual([]);

  expect(fake.calls).toEqual([
    "takeLegacy",
    "destroy:old-1",
    "forgetLegacy:session:old-1",
    // A Machine's object is named by its slug alone, not `ws:<id>`.
    "destroyWorkspace:cloudpid",
    "forgetLegacy:machine:cloudpid",
    "destroy:old-2",
    "forgetLegacy:session:old-2",
  ]);
  expect(fake.legacyObjects).toEqual([]);
});

it("logs an object it could not wipe and keeps it, going on with the rest", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    { kind: "session", id: "stuck" },
    { kind: "session", id: "fine" },
    { kind: "machine", id: "default" },
  );
  fake.breakSession("stuck", "unreachable");

  const logged = await cleanup(fake);

  expect(logged).toEqual(["Warn: Could not wipe the legacy session stuck"]);
  expect(fake.legacyObjects).toEqual([{ kind: "session", id: "stuck" }]);
  expect(fake.calls).toContain("forgetLegacy:session:fine");
  expect(fake.calls).toContain("forgetLegacy:machine:default");
  expect(fake.calls).not.toContain("forgetLegacy:session:stuck");
});

it("keeps a Machine's object it could not wipe", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push({ kind: "machine", id: "cloudpid" });
  fake.failWorkspace("storage error");

  const logged = await cleanup(fake);

  expect(logged).toEqual(["Warn: Could not wipe the legacy machine cloudpid"]);
  expect(fake.legacyObjects).toEqual([{ kind: "machine", id: "cloudpid" }]);
});

it("wipes a batch of ten at a time", async () => {
  const fake = fakeRegistries();

  fake.legacyObjects.push(
    ...Arr.makeBy(12, (index): LegacyObject => ({ kind: "session", id: `old-${index}` })),
  );

  await cleanup(fake);

  expect(fake.legacyObjects).toEqual([
    { kind: "session", id: "old-10" },
    { kind: "session", id: "old-11" },
  ]);
});

it("does nothing more in this isolate once a run found nothing left", async () => {
  const fake = fakeRegistries();

  const wipe = legacyCleanup(fake.registries, {
    sessions: fake.sessionObjects,
    workspaces: fake.workspaceObjects,
  });

  await Effect.runPromise(wipe);
  await Effect.runPromise(wipe);

  // The second run did not ask the Registry.
  expect(fake.calls).toEqual(["takeLegacy"]);

  fake.calls.length = 0;
  fake.legacyObjects.push({ kind: "session", id: "late" });
  await Effect.runPromise(wipe);

  expect(fake.calls).toEqual([]);
  expect(fake.legacyObjects).toHaveLength(1);
});

it("archives a Session after stopping everything it runs, and unarchives it", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  const archived = await call(fake, (registry) => registry.archiveSession({ id: session.id }));

  expect(archived).toEqual({ ...session, archivedAt: 7 });
  expect(lifecycle(fake)).toEqual([`stop:${session.id}`, "archiveSession"]);

  const restored = await call(fake, (registry) => registry.unarchiveSession({ id: session.id }));

  expect(restored).toEqual(session);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("leaves a Session unarchived when it cannot be stopped", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "object unreachable");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.archiveSession({ id: session.id })),
  );

  expect(error).toBeInstanceOf(SessionActionError);
  expect(error.message).toContain("object unreachable");
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("archives, unarchives and deletes no Session the Registry does not know, and wakes no object", async () => {
  const fake = fakeRegistries();

  for (const attempt of [
    (registry: Registry["Service"]) => Effect.flip(registry.archiveSession({ id: "ghost" })),
    (registry: Registry["Service"]) => Effect.flip(registry.unarchiveSession({ id: "ghost" })),
    (registry: Registry["Service"]) => Effect.flip(registry.deleteSession({ id: "ghost" })),
  ]) {
    const error = await call(fake, attempt);

    expect(error).toBeInstanceOf(SessionNotFound);
    expect(error.message).toContain("ghost");
  }

  expect(Arr.filter(fake.calls, (name) => /^(stop|destroy):/.test(name))).toEqual([]);
});

it("deletes a Session: wipes its object, then forgets it", async () => {
  const fake = fakeRegistries();
  const kept = await call(fake, (registry) => registry.createSession({}));
  const doomed = await call(fake, (registry) => registry.createSession({}));

  await call(fake, (registry) => registry.deleteSession({ id: doomed.id }));

  expect(lifecycle(fake)).toEqual([
    `destroy:${doomed.id}`,
    `deleteSession:${doomed.id}`,
    `destroyWorkspace:ws:${doomed.workspace}`,
    `deleteWorkspace:${doomed.workspace}`,
  ]);
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([kept]);
});

it("keeps a Session listed when its object could not be wiped, to try again", async () => {
  const fake = fakeRegistries();
  const session = await call(fake, (registry) => registry.createSession({}));

  fake.breakSession(session.id, "storage error");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteSession({ id: session.id })),
  );

  expect(error).toBeInstanceOf(SessionActionError);
  expect(error.message).toContain("storage error");
  expect(await call(fake, (registry) => registry.listSessions())).toEqual([session]);
});

it("makes the Environment's next spare Workspace after a Session is created in a new one, after the answer", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();
  fake.calls.length = 0;

  await call(fake, (registry) => registry.createSession({ environment }));

  expect(fake.calls).not.toContain(`upkeepSpares:${environment}`);

  fake.spares.clear();
  await fake.runBackground();

  expect(Arr.filter(fake.calls, (name) => /^(upkeepSpares|prepareSpare)/.test(name))).toEqual([
    `upkeepSpares:${environment}`,
    `prepareSpare:ws:${fake.spares.get(environment)?.id}`,
  ]);
});

it("makes a spare Workspace for an Environment once it is created", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();

  expect(fake.calls).toContain(`upkeepSpares:${environment}`);
  expect(lifecycle(fake)).toEqual([`prepareSpare:ws:${fake.spares.get(environment)?.id}`]);
});

it("keeps no spare up for a Session in a Workspace that exists", async () => {
  const fake = fakeRegistries();
  const first = await call(fake, (registry) => registry.createSession({}));

  await fake.runBackground();
  fake.calls.length = 0;
  await call(fake, (registry) => registry.createSession({ workspace: first.workspace }));
  await fake.runBackground();

  expect(fake.calls).not.toContain(`upkeepSpares:${DEFAULT_ENVIRONMENT}`);
});

it("refuses the spare Workspaces' branch for a new Workspace, before it reaches the Registry", async () => {
  const fake = fakeRegistries();

  const error = await call(fake, (registry) =>
    Effect.flip(registry.createSession({ branch: "cloudpid/spare" })),
  );

  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.message).toContain("spare");
  expect(fake.calls).not.toContain("createSession");
});

it("removes a stale spare once a Repo is added: its record, then its object, then makes the next", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();

  const stale = fake.spares.get(environment)?.id;

  fake.calls.length = 0;
  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await fake.runBackground();

  expect(Arr.filter(lifecycle(fake), (name) => !name.startsWith("startBuild:"))).toEqual([
    `forgetSpare:${stale}`,
    `destroyWorkspace:ws:${stale}`,
    `prepareSpare:ws:${fake.spares.get(environment)?.id}`,
  ]);
  expect(fake.spares.get(environment)?.repos).toContain("acme/app");
});

it("removes a stale spare once a Repo is removed", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await fake.runBackground();
  fake.calls.length = 0;
  await call(fake, (registry) => registry.removeRepo({ environment, repo: "app" }));
  await fake.runBackground();

  expect(fake.calls).toContain(`upkeepSpares:${environment}`);
  expect(Arr.filter(lifecycle(fake), (name) => name.startsWith("forgetSpare:"))).toHaveLength(1);
});

it("leaves a stale spare a Session took meanwhile to the Session, wiping nothing", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();

  const stale = fake.spares.get(environment)?.id;

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  // The Repos changed back, and a Session took the spare, before the upkeep forgets it.
  fake.beforeForgetSpare(() => {
    fake.spares.delete(environment);
  });
  fake.calls.length = 0;
  await fake.runBackground();

  expect(fake.calls).toContain(`forgetSpare:${stale}`);
  expect(fake.calls).not.toContain(`destroyWorkspace:ws:${stale}`);
});

it("answers a Repo change whose stale spare could not be wiped, and looks again behind the Session list", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  // A run behind the Session list that finds nothing to do settles the isolate.
  for (let round = 0; round < 2; round++) {
    await call(fake, (registry) => registry.listSessions());
    await fake.runBackground();
  }

  const stale = fake.spares.get(environment)?.id;

  fake.failWorkspace("unreachable");
  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await fake.runBackground();

  expect(fake.calls).toContain(`destroyWorkspace:ws:${stale}`);

  fake.failWorkspace(undefined);
  fake.calls.length = 0;
  await call(fake, (registry) => registry.listSessions());
  await fake.runBackground();

  expect(fake.calls).toContain("upkeepSpares:*");
});

it("keeps every Environment's spare behind the Session list, until a run finds nothing to do in the isolate", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.listSessions());
  await fake.runBackground();

  expect(fake.calls).toContain("upkeepSpares:*");
  expect(lifecycle(fake)).toEqual([`prepareSpare:ws:${fake.spares.get(DEFAULT_ENVIRONMENT)?.id}`]);

  // The next run finds every spare there, and the runs after it ask nothing.
  for (let round = 0; round < 2; round++) {
    await call(fake, (registry) => registry.listSessions());
    await fake.runBackground();
  }

  expect(Arr.filter(fake.calls, (name) => name === "upkeepSpares:*")).toHaveLength(2);
});

it("deletes an Environment's spare Workspace with it: its record, then its object, then the Environment's", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();

  const spare = fake.spares.get(id)?.id;

  fake.calls.length = 0;
  await call(fake, (registry) => registry.deleteEnvironment({ environment: id }));

  expect(lifecycle(fake)).toEqual([
    `forgetSpare:${spare}`,
    `destroyWorkspace:ws:${spare}`,
    `destroyWorkspace:build:${id}`,
    `deleteEnvironment:${id}`,
    `destroyWorkspace:build:${id}`,
  ]);
});

it("keeps an Environment whose spare Workspace could not be wiped", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();
  fake.failWorkspace("unreachable");

  const error = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: id })),
  );

  expect(error.message).toContain("Could not delete the spare workspace");
  expect(fake.calls).not.toContain(`deleteEnvironment:${id}`);
});

it("wipes a spare again when its record was forgotten while it was asked to prepare, as when its Environment is deleted", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  // The Environment is deleted (its spare forgotten and wiped) just as the request reaches the spare's object.
  fake.duringPrepare(() => {
    fake.spares.delete(environment);
  });
  await fake.runBackground();

  const asked = Arr.findFirst(fake.calls, (name) => name.startsWith("prepareSpare:"));
  const spare = Option.getOrThrow(asked).slice("prepareSpare:".length);

  expect(Arr.filter(lifecycle(fake), (name) => name.endsWith(spare))).toEqual([
    `prepareSpare:${spare}`,
    `destroyWorkspace:${spare}`,
  ]);
});

it("leaves a spare a Session took while it was asked to prepare", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  fake.duringPrepare(() => {
    const spare = fake.spares.get(environment);

    fake.spares.delete(environment);
    fake.workspaces.unshift({
      id: spare?.id ?? "",
      environment,
      branch: `cloudpid/${spare?.id}`,
      base: null,
      repos: [],
      directory: workspaceDirectory([]),
      createdAt: 2,
    });
  });
  await fake.runBackground();

  expect(Arr.filter(lifecycle(fake), (name) => name.startsWith("destroyWorkspace:ws:"))).toEqual(
    [],
  );
});

it("says what is kept, as a sentence of its own, when what an Environment being deleted holds cannot be wiped", async () => {
  const fake = fakeRegistries();
  const id = await makeEnvironment(fake, "Cloudpid");
  const first = await call(fake, (registry) => registry.createSession({ environment: id }));

  // Its object cannot be wiped with its last Session either, so its Workspace is left with none.
  fake.failWorkspace("unreachable");
  await call(fake, (registry) => registry.deleteSession({ id: first.id }));

  const files = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: id })),
  );

  expect(files.message).toBe(
    "Could not delete the workspace's files: unreachable. The environment and its remaining workspaces are kept.",
  );

  fake.failWorkspace(undefined);

  const session = await call(fake, (registry) => registry.createSession({ environment: id }));

  fake.breakSession(session.id, "storage error");

  const workspace = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironment({ environment: id })),
  );

  expect(workspace.message).toBe(
    "Could not delete the session: storage error. The workspace and its remaining sessions are kept. The environment and its remaining workspaces are kept.",
  );
});

/** The calls that reached an Environment's Build object or recorded its answer, in order. */
const buildCalls = (fake: ReturnType<typeof fakeRegistries>) =>
  Arr.filter(fake.calls, (name) => /^(buildState|startBuild|recordBuild):/.test(name));

/** The key of the Build of `environment`'s Repos and saved settings, on the fake's image. */
const keyOf = (fake: ReturnType<typeof fakeRegistries>, environment: string) => {
  const found = Arr.findFirst(fake.environments, (item) => item.id === environment);

  return buildKey({
    repos: Option.getOrThrow(found).repos,
    // SAFETY: the tests only save overrides of the settings' own shape.
    settings: { ...DEFAULT_CONTAINER_SETTINGS, ...(fake.overridesOf.get(environment) as object) },
    image: "img-1",
  });
};

const DAY = BUILD_LOOK_INTERVAL_MS;

it("asks an Environment's Build object for a Build once it has a Repo, after the answer, and records what it answers", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await fake.runBackground();
  // No Repo, no Setup Script: nothing to build.
  expect(fake.calls).not.toContain(`startBuild:build:${environment}`);

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  fake.calls.length = 0;
  await fake.runBackground();

  expect(buildCalls(fake)).toEqual([
    `buildState:build:${environment}`,
    `startBuild:build:${environment}`,
    `recordBuild:${environment}`,
  ]);
  expect(fake.buildRequests.get(`build:${environment}`)).toEqual({
    key: await keyOf(fake, environment),
    repos: [{ name: "app", url: "https://github.com/acme/app.git" }],
    settings: {},
    check: false,
  });

  const builds = await call(fake, (registry) => registry.listBuilds());

  expect(Arr.findFirst(builds, (item) => item.environment === environment)).toEqual(
    Option.some({ environment, build: { status: "building", since: 50, lastGoodAt: null } }),
  );
});

it("asks for a Build of an Environment with Toolchains only, and Rebuilds it", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Tools");

  await fake.runBackground();
  await call(fake, (registry) =>
    registry.updateEnvironmentSettings({
      environment,
      overrides: { toolchains: '[tools]\nnode = "22"\n' },
    }),
  );
  fake.calls.length = 0;
  await fake.runBackground();

  expect(fake.calls).toContain(`startBuild:build:${environment}`);

  await call(fake, (registry) => registry.rebuildEnvironment({ environment }));
});

it("asks for a Build again when the settings a Build uses change, and not for a new idle time", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  const good = {
    key: "",
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: {},
    finishedAt: 10,
  };

  await fake.runBackground();
  fake.overridesOf.set(environment, { setupScript: "docker pull postgres" });
  good.key = await keyOf(fake, environment);
  fake.buildObjects.set(`build:${environment}`, {
    image: "img-1",
    last: good,
    progress: null,
    attemptedAt: Date.now(),
  });
  fake.buildRecords.set(environment, { build: good, status: null });

  await call(fake, (registry) =>
    registry.updateEnvironmentSettings({
      environment,
      overrides: { setupScript: "docker pull postgres", idleMinutes: 30 },
    }),
  );
  fake.calls.length = 0;
  await fake.runBackground();

  expect(buildCalls(fake)).toEqual([`buildState:build:${environment}`]);

  await call(fake, (registry) =>
    registry.updateEnvironmentSettings({
      environment,
      overrides: { setupScript: "docker pull redis", idleMinutes: 30 },
    }),
  );
  fake.calls.length = 0;
  await fake.runBackground();

  expect(buildCalls(fake)).toEqual([
    `buildState:build:${environment}`,
    `startBuild:build:${environment}`,
    `recordBuild:${environment}`,
  ]);
  // The last good one is still what Workspaces start from meanwhile.
  expect(fake.buildRecords.get(environment)?.build).toEqual(good);
});

it("asks for a Build when a deploy changed the image", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));

  const good = {
    key: await keyOf(fake, environment),
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: { app: "abc" },
    finishedAt: 10,
  };

  fake.buildObjects.set(`build:${environment}`, {
    image: "img-2",
    last: good,
    progress: null,
    attemptedAt: Date.now(),
  });
  fake.buildRecords.set(environment, { build: good, status: null });
  fake.calls.length = 0;
  await call(fake, (registry) => registry.listSessions());
  await fake.runBackground();

  expect(fake.calls).toContain(`startBuild:build:${environment}`);
});

it("records a Build that finished, and asks for nothing more while it is current", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await fake.runBackground();

  const request = fake.buildRequests.get(`build:${environment}`);

  const good = {
    key: request?.key ?? "",
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: { app: "abc" },
    finishedAt: Date.now(),
  };

  fake.buildObjects.set(`build:${environment}`, {
    image: "img-1",
    last: good,
    progress: null,
    attemptedAt: Date.now(),
  });
  fake.calls.length = 0;
  await call(fake, (registry) => registry.listBuilds());
  await fake.runBackground();

  expect(Arr.filter(buildCalls(fake), (name) => name.endsWith(environment))).toEqual([
    `buildState:build:${environment}`,
    `recordBuild:${environment}`,
  ]);
  expect(fake.buildRecords.get(environment)).toEqual({ build: good, status: null });

  // A Workspace made now starts from it.
  const created = await call(fake, (registry) => registry.createSession({ environment }));

  const setup = await Effect.runPromise(fake.registry.getWorkspaceSetup({ id: created.workspace }));

  expect(setup?.build).toEqual(good);
});

it("leaves a Build of the wanted key that is under way, and tries a failed one again only a day later", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));

  const key = await keyOf(fake, environment);
  const name = `build:${environment}`;

  fake.buildObjects.set(name, {
    image: "img-1",
    last: null,
    progress: { status: "building", key, startedAt: 1 },
    attemptedAt: null,
  });
  fake.calls.length = 0;
  await fake.runBackground();
  expect(fake.calls).not.toContain(`startBuild:${name}`);

  fake.buildObjects.set(name, {
    image: "img-1",
    last: null,
    progress: { status: "failed", key, reason: "exit 1", at: 1 },
    attemptedAt: Date.now() - DAY / 2,
  });

  // A new idle time asks the upkeep to look again.
  const look = () =>
    call(fake, (registry) =>
      registry.updateEnvironmentSettings({ environment, overrides: { idleMinutes: 30 } }),
    ).then(() => fake.runBackground());

  await look();
  expect(fake.calls).not.toContain(`startBuild:${name}`);

  fake.buildObjects.set(name, {
    image: "img-1",
    last: null,
    progress: { status: "failed", key, reason: "exit 1", at: 1 },
    attemptedAt: Date.now() - DAY - 1,
  });
  await look();
  expect(fake.calls).toContain(`startBuild:${name}`);
});

it("asks for the daily look at the default branches once a day", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));

  const name = `build:${environment}`;

  const good = {
    key: await keyOf(fake, environment),
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: { app: "abc" },
    finishedAt: 10,
  };

  fake.buildObjects.set(name, {
    image: "img-1",
    last: good,
    progress: null,
    attemptedAt: Date.now() - DAY - 1,
  });
  fake.calls.length = 0;
  await fake.runBackground();

  expect(fake.calls).toContain(`startBuild:${name}:check`);
  // The look shows the last good Build still: it is not a Build until a branch moved.
  expect(buildView(fake.buildRecords.get(environment) ?? { build: null, status: null })).toEqual({
    status: "ready",
    at: 10,
  });
});

it("keeps the Builds behind the Session list until a run finds nothing to do or under way in the isolate", async () => {
  const fake = fakeRegistries();

  await call(fake, (registry) => registry.listSessions());
  await fake.runBackground();
  // The default Environment has nothing to build.
  expect(Arr.filter(fake.calls, (name) => name === "buildWork:*")).toHaveLength(1);

  for (let round = 0; round < 2; round++) {
    await call(fake, (registry) => registry.listSessions());
    await fake.runBackground();
  }

  expect(Arr.filter(fake.calls, (name) => name === "buildWork:*")).toHaveLength(1);
});

it("makes an Environment's Build again when the owner asks, though it is current", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));

  const name = `build:${environment}`;

  const good = {
    key: await keyOf(fake, environment),
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: { app: "abc" },
    finishedAt: 10,
  };

  fake.buildObjects.set(name, {
    image: "img-1",
    last: good,
    progress: null,
    attemptedAt: Date.now(),
  });
  fake.calls.length = 0;
  await call(fake, (registry) => registry.rebuildEnvironment({ environment }));

  expect(buildCalls(fake)).toEqual([
    `buildState:${name}`,
    `startBuild:${name}`,
    `recordBuild:${environment}`,
  ]);
  expect(buildView(fake.buildRecords.get(environment) ?? { build: null, status: null })).toEqual({
    status: "building",
    since: 50,
    lastGoodAt: 10,
  });
});

it("refuses a Rebuild of an Environment that does not exist, or has nothing to build, or whose Build object cannot be reached", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.rebuildEnvironment({ environment: "0000beef" })),
  );

  expect(missing.message).toBe('Environment "0000beef" does not exist');

  const empty = await call(fake, (registry) =>
    Effect.flip(registry.rebuildEnvironment({ environment })),
  );

  expect(empty.message).toContain("nothing to build");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  fake.failWorkspace("unreachable");

  const unreachable = await call(fake, (registry) =>
    Effect.flip(registry.rebuildEnvironment({ environment })),
  );

  expect(unreachable).toBeInstanceOf(EnvironmentError);
  expect(unreachable.message).toContain("unreachable");
});

it("hands a spare's object its Environment's Secrets with the set-up", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) =>
    registry.setEnvironmentSecret({ environment, name: "API_KEY", value: "sk-live-0123456789" }),
  );
  await fake.runBackground();

  const spare = `ws:${fake.spares.get(environment)?.id}`;

  expect(fake.spareSecrets.get(spare)).toEqual([
    { name: "API_KEY", value: "sk-live-0123456789", scope: "environment", build: false },
  ]);
});

it("keeps Secrets for an Environment and for every Environment, and never answers a value", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");
  const value = "sk-live-0123456789abcdef";

  const saved = await call(fake, (registry) =>
    registry.setEnvironmentSecret({ environment, name: "API_KEY", value }),
  );

  const shared = await call(fake, (registry) =>
    registry.setEnvironmentSecret({
      environment: null,
      name: "NPM_TOKEN",
      value: "npm_0123456789",
      build: true,
    }),
  );

  const listed = await call(fake, (registry) => registry.listEnvironmentSecrets());

  expect(saved).toEqual({ environment, name: "API_KEY", build: false, updatedAt: 9 });
  expect(shared).toMatchObject({ environment: null, name: "NPM_TOKEN", build: true });
  expect(listed).toEqual([saved, shared]);
  expect(JSON.stringify([saved, shared, listed])).not.toContain(value);
  expect(JSON.stringify(listed)).not.toContain("npm_0123456789");
});

it("refuses a malformed Secret, one of an Environment that does not exist, and one past the bound, saying why", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  const refused = (payload: { environment: string | null; name: string; value: string }) =>
    call(fake, (registry) => Effect.flip(registry.setEnvironmentSecret(payload)));

  expect((await refused({ environment, name: "API_KEY", value: "" })).message).toBe(
    "A Secret needs a value",
  );
  expect((await refused({ environment: "0000beef", name: "API_KEY", value: "x" })).message).toBe(
    'Environment "0000beef" does not exist',
  );

  for (let index = 0; index < MAX_ENVIRONMENT_SECRETS; index++) {
    fake.keptSecrets.push({
      environment,
      name: `S${index}`,
      build: false,
      updatedAt: 1,
      value: "v",
    });
  }

  expect((await refused({ environment, name: "ONE_MORE", value: "x" })).message).toContain(
    `At most ${MAX_ENVIRONMENT_SECRETS} Secrets`,
  );

  // A name the shared schema refuses never reaches the Registry.
  const { calls } = await callRaw("setEnvironmentSecret", {
    environment,
    name: "api_key",
    value: "x",
  });

  expect(calls).toEqual([]);
});

it("sets a Secret's build flag and deletes it, and says when there is no such Secret", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) =>
    registry.setEnvironmentSecret({ environment, name: "API_KEY", value: "sk-live-0123456789" }),
  );

  expect(
    await call(fake, (registry) =>
      registry.setEnvironmentSecretBuild({ environment, name: "API_KEY", build: true }),
    ),
  ).toMatchObject({ name: "API_KEY", build: true });

  // Replacing the value keeps the flag.
  expect(
    await call(fake, (registry) =>
      registry.setEnvironmentSecret({ environment, name: "API_KEY", value: "sk-live-rotated" }),
    ),
  ).toMatchObject({ build: true });

  await call(fake, (registry) =>
    registry.deleteEnvironmentSecret({ environment, name: "API_KEY" }),
  );

  expect(await call(fake, (registry) => registry.listEnvironmentSecrets())).toEqual([]);

  const missing = await call(fake, (registry) =>
    Effect.flip(registry.deleteEnvironmentSecret({ environment: null, name: "API_KEY" })),
  );

  expect(missing.message).toBe("No Secret API_KEY is kept for every environment");
});

it("hands a Build the Environment's Secrets, and builds again when a Secret for the Build changes", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await call(fake, (registry) =>
    registry.setEnvironmentSecret({ environment, name: "API_KEY", value: "sk-live-0123456789" }),
  );
  await fake.runBackground();

  const name = `build:${environment}`;
  const first = fake.buildRequests.get(name)?.key;

  // Every Secret reaches the Build object, for its scan; the build flag says which its scripts get.
  expect(fake.buildSecrets.get(name)).toEqual([
    { name: "API_KEY", value: "sk-live-0123456789", scope: "environment", build: false },
  ]);
  // Its key holds no value.
  expect(JSON.stringify(fake.buildRequests.get(name))).not.toContain("sk-live-0123456789");

  // The Build object answers that the Build of that key is done.
  const done = (key: string | undefined) => {
    const good = {
      key: key ?? "",
      snapshot: { id: "snap-1", size: 1 },
      image: "img-1",
      ignore: null,
      commits: {},
      finishedAt: Date.now(),
    };

    fake.buildObjects.set(name, {
      image: "img-1",
      last: good,
      progress: null,
      attemptedAt: Date.now(),
    });
  };

  done(first);
  fake.calls.length = 0;
  await call(fake, (registry) =>
    registry.setEnvironmentSecretBuild({ environment, name: "API_KEY", build: true }),
  );
  await fake.runBackground();

  expect(fake.calls).toContain(`startBuild:${name}`);

  const second = fake.buildRequests.get(name)?.key;

  expect(second).not.toBe(first);

  done(second);
  fake.calls.length = 0;
  await call(fake, (registry) =>
    registry.setEnvironmentSecret({ environment, name: "API_KEY", value: "sk-live-rotated-999" }),
  );
  await fake.runBackground();

  expect(fake.calls).toContain(`startBuild:${name}`);
  expect(fake.buildRequests.get(name)?.key).not.toBe(second);
});

it("wipes the Build object again when its Environment was deleted while a Build was asked for", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  fake.duringStartBuild(() => {
    fake.environments.splice(
      fake.environments.findIndex((item) => item.id === environment),
      1,
    );
  });
  fake.calls.length = 0;
  await fake.runBackground();

  expect(buildCalls(fake)).toEqual([
    `buildState:build:${environment}`,
    `startBuild:build:${environment}`,
  ]);
  expect(Arr.filter(lifecycle(fake), (name) => name.endsWith(`build:${environment}`))).toEqual([
    `startBuild:build:${environment}`,
    `destroyWorkspace:build:${environment}`,
  ]);
});

it("makes the spare again from the Environment's new Build once it is recorded", async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "acme/app" }));
  await fake.runBackground();

  const stale = fake.spares.get(environment)?.id;

  const good = {
    key: fake.buildRequests.get(`build:${environment}`)?.key ?? "",
    snapshot: { id: "snap-1", size: 1 },
    image: "img-1",
    ignore: null,
    commits: { app: "abc" },
    finishedAt: Date.now(),
  };

  fake.buildObjects.set(`build:${environment}`, {
    image: "img-1",
    last: good,
    progress: null,
    attemptedAt: Date.now(),
  });
  fake.calls.length = 0;
  await call(fake, (registry) => registry.listBuilds());
  await fake.runBackground();

  const next = fake.spares.get(environment)?.id;

  expect(
    Arr.filter(lifecycle(fake), (name) =>
      /^(forgetSpare|destroyWorkspace:ws|prepareSpare)/.test(name),
    ),
  ).toEqual([`forgetSpare:${stale}`, `destroyWorkspace:ws:${stale}`, `prepareSpare:ws:${next}`]);
  expect(fake.spareBuilds.get(`ws:${next}`)).toEqual(good);

  // A spare made from the Build it has is current.
  fake.calls.length = 0;
  await call(fake, (registry) => registry.listBuilds());
  await fake.runBackground();

  expect(Arr.filter(fake.calls, (name) => name.startsWith("forgetSpare:"))).toEqual([]);
});

/** A fake with Session `session-1`, titled, in a new Workspace of an Environment of one Repo. */
const withSource = async () => {
  const fake = fakeRegistries();
  const environment = await makeEnvironment(fake, "Cloudpid");

  await call(fake, (registry) => registry.addRepo({ environment, source: "ian-pascoe/cloudpid" }));

  const source = await call(fake, (registry) =>
    registry.createSession({ environment, title: "Fix the build" }),
  );

  fake.calls.length = 0;

  return { fake, environment, source };
};

it("forks a Session before an owner's message into its Workspace, copying its branch up to there", async () => {
  const { fake, source } = await withSource();

  const forked = await call(fake, (registry) =>
    registry.forkSession({ source: source.id, point: { entryId: 3, position: "before" } }),
  );

  expect(forked.text).toBe("message 3");
  expect(forked.session).toMatchObject({
    title: "Fix the build (fork)",
    workspace: source.workspace,
    origin: { session: source.id, kind: "fork" },
  });
  expect(fake.imported.get(forked.session.id)).toEqual([1, 2]);
  expect(fake.finished.get(forked.session.id)).toMatchObject({ through: 2 });
  // It shares its source's Workspace: no file is carried.
  expect(Arr.some(fake.calls, (name) => name.startsWith("carry:"))).toBe(false);
});

it("clones a Session as it is, and refuses while its Run is in progress, registering nothing", async () => {
  const { fake, source } = await withSource();

  const cloned = await call(fake, (registry) => registry.forkSession({ source: source.id }));

  expect(cloned).toMatchObject({
    text: null,
    session: { title: "Fix the build (clone)", origin: { session: source.id, kind: "clone" } },
  });
  expect(fake.imported.get(cloned.session.id)).toEqual([1, 2, 3]);

  fake.runningSessions.add(source.id);

  const refused = await call(fake, (registry) =>
    Effect.flip(registry.forkSession({ source: source.id })),
  );

  expect(refused).toBeInstanceOf(SessionActionError);
  expect(refused.message).toContain("Run is in progress");
  expect(fake.sessions).toHaveLength(2);

  // A Fork in the same Workspace is made all the same.
  await call(fake, (registry) =>
    registry.forkSession({ source: source.id, point: { entryId: 1, position: "at" } }),
  );

  expect(fake.sessions).toHaveLength(3);
});

it("forks a Session in a new Workspace on the branch named, carrying the source's files there", async () => {
  const { fake, environment, source } = await withSource();

  const forked = await call(fake, (registry) =>
    registry.forkSession({
      source: source.id,
      point: { entryId: 2, position: "at" },
      workspace: "new",
      branch: "feature/fork",
    }),
  );

  expect(forked.session.workspace).not.toBe(source.workspace);
  expect(fake.workspaces[0]).toMatchObject({
    id: forked.session.workspace,
    environment,
    branch: "feature/fork",
  });
  expect(fake.calls).toContain(`carry:ws:${source.workspace}:feature/fork:cloudpid`);
  // The files go once the Session is filled, with the source at rest until they are carried.
  expect(fake.calls).toContain(`forkSource(session):${source.id}`);
  expect(fake.calls.indexOf(`importFinish:${forked.session.id}`)).toBeLessThan(
    fake.calls.indexOf(`carry:ws:${source.workspace}:feature/fork:cloudpid`),
  );
  expect(fake.calls.indexOf(`carry:ws:${source.workspace}:feature/fork:cloudpid`)).toBeLessThan(
    fake.calls.indexOf(`releaseFork:${source.id}`),
  );
});

it("asks only the active branch to rest for a Clone, and nothing for a Fork in the Workspace", async () => {
  const { fake, source } = await withSource();

  await call(fake, (registry) => registry.forkSession({ source: source.id }));
  await call(fake, (registry) =>
    registry.forkSession({ source: source.id, point: { entryId: 1, position: "at" } }),
  );

  expect(Arr.filter(fake.calls, (name) => name.startsWith("forkSource"))).toEqual([
    `forkSource(branch):${source.id}`,
    `forkSource(none):${source.id}`,
  ]);
  expect(fake.calls).not.toContain(`releaseFork:${source.id}`);
});

it("names a Fork of an untitled Session after the untitled name, and cuts a long title to fit", () => {
  expect(forkTitle(null, "fork")).toBe("Untitled session (fork)");
  expect(forkTitle("x".repeat(MAX_TITLE_LENGTH), "clone")).toHaveLength(MAX_TITLE_LENGTH);
  expect(forkTitle("x".repeat(MAX_TITLE_LENGTH), "clone").endsWith(" (clone)")).toBe(true);
});

it("leaves nothing of a Fork whose files could not be carried", async () => {
  const { fake, source } = await withSource();

  fake.failCarry("the remote has branch cloudpid/00000002 already");

  const refused = await call(fake, (registry) =>
    Effect.flip(registry.forkSession({ source: source.id, workspace: "new" })),
  );

  expect(refused).toBeInstanceOf(EnvironmentError);
  expect(refused.message).toContain("the remote has branch cloudpid/00000002 already");
  expect(fake.sessions).toEqual([source]);
  // The source takes messages again.
  expect(fake.calls).toContain(`releaseFork:${source.id}`);
  expect(Arr.map(fake.workspaces, (workspace) => workspace.id)).toEqual([source.workspace]);
});

it("refuses a branch for a Fork in its source's Workspace, and an unknown source", async () => {
  const { fake, source } = await withSource();

  const branch = await call(fake, (registry) =>
    Effect.flip(registry.forkSession({ source: source.id, branch: "feature/fork" })),
  );

  const unknown = await call(fake, (registry) =>
    Effect.flip(registry.forkSession({ source: "nope" })),
  );

  expect(branch).toBeInstanceOf(EnvironmentError);
  expect(unknown).toBeInstanceOf(SessionNotFound);
  expect(fake.sessions).toEqual([source]);
});
