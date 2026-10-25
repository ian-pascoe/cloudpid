// Agent changes to an Environment's own record (`docs/spec.md` → Agent changes, ADR-0019): the agent makes, renames,
// adds a Repo to and takes a Repo out of an Environment, and asks for its Build. Each is applied as the owner's RPC
// applies it (the same rules and messages) and recorded as an Agent change in the same transaction, so a change and its
// record are one step. The changes to an Environment's Container settings are in `agent-changes.ts`; the revert of
// these is here too (`revertLifecycleChange`), which the owner's revert calls for their fields.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  BUILD_ASKED,
  BUILD_FIELD,
  CREATED_FIELD,
  type EnvironmentRepo,
  environmentNameProblem,
  fieldRepo,
  isRepoName,
  NAME_FIELD,
  repoField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nameTaken, noEnvironment, noRepo, repoTaken } from "./messages.ts";
import type { AgentChangeAuthor, AgentChanges } from "./agent-changes.ts";
import type { EnvironmentRecord, RegistryStorage, RegistryStore } from "./store.ts";

/** An Agent change made to an Environment's record, as recorded. */
export type LifecycleChanged = {
  readonly status: "changed";
  readonly environment: EnvironmentRecord;
  readonly change: AgentChange;
};

/** The record already was as asked (the name it has, the Repo it holds): nothing was saved or recorded. */
export type LifecycleUnchanged = {
  readonly status: "unchanged";
  readonly environment: EnvironmentRecord;
};

/** How an Agent change to an Environment's record went: `A` where it was allowed, else why not. */
export type LifecycleOutcome<A> =
  | A
  /** Not allowed, said as the owner's RPC says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** How a rename or an add of a Repo went. */
export type LifecycleChange = LifecycleOutcome<LifecycleChanged | LifecycleUnchanged>;

/** How the agent's making an Environment went. */
export type EnvironmentCreation =
  | {
      readonly status: "created";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
    }
  | { readonly status: "rejected"; readonly message: string };

const sameText = Schema.toEquivalence(Schema.String);

/** Record `author`'s change of `field` in `scope`. */
const recorded = (
  changes: AgentChanges,
  scope: string,
  now: number,
  author: AgentChangeAuthor,
  field: string,
  before: Schema.Json | null,
  after: Schema.Json | null,
): AgentChange =>
  changes.record({
    scope,
    at: now,
    actor: "agent",
    session: author.session,
    conversation: author.conversation,
    tool: author.tool,
    reason: author.reason,
    field,
    before,
    after,
    reverts: null,
  });

/**
 * Make Environment `id` named `name` with `repos`, and record that it was made. The name is trimmed and checked as the
 * owner's is, and free whatever the case; the Repos' directories must differ. The default Container settings apply.
 */
export const createEnvironmentAs = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    id,
    name: given,
    repos,
    author,
  }: {
    readonly id: string;
    readonly name: string;
    readonly repos: ReadonlyArray<EnvironmentRepo>;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): EnvironmentCreation =>
  storage.transactionSync((): EnvironmentCreation => {
    const name = given.trim();
    const problem = environmentNameProblem(name);

    if (problem !== undefined) return { status: "rejected", message: problem };

    const directories = new Set<string>();

    for (const repo of repos) {
      if (!isRepoName(repo.name)) {
        return { status: "rejected", message: `"${repo.name}" is not a usable directory name` };
      }

      if (directories.has(repo.name)) {
        return {
          status: "rejected",
          message: `Two repos would be cloned into ${repo.name}: make the Environment with one, then add the other with environment_repo_add and a directory name`,
        };
      }

      directories.add(repo.name);
    }

    const naming = store.createEnvironment(id, name, now);

    if (naming.status !== "named") return { status: "rejected", message: nameTaken(name) };

    for (const repo of repos) store.addRepo(id, repo);

    const environment = store.getEnvironment(id) ?? naming.environment;

    const change = recorded(changes, id, now, author, CREATED_FIELD, null, {
      name,
      repos: Arr.map(repos, ({ name: directory, url }) => ({ name: directory, url })),
    });

    return { status: "created", environment, change };
  });

/** Give `environment` the name `given`, and record it. A name another Environment has is refused, whatever the case. */
export const renameEnvironmentAs = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    environment,
    name: given,
    author,
  }: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): LifecycleChange =>
  storage.transactionSync((): LifecycleChange => {
    const known = store.getEnvironment(environment);

    if (known === null) return { status: "missing" };

    const name = given.trim();
    const problem = environmentNameProblem(name);

    if (problem !== undefined) return { status: "rejected", message: problem };

    if (sameText(known.name, name)) return { status: "unchanged", environment: known };

    const naming = store.renameEnvironment(environment, name);

    if (naming.status === "missing") return { status: "missing" };

    if (naming.status === "taken") return { status: "rejected", message: nameTaken(name) };

    return {
      status: "changed",
      environment: naming.environment,
      change: recorded(changes, environment, now, author, NAME_FIELD, known.name, name),
    };
  });

/**
 * Add `repo` to `environment` and record it. A directory the Environment has already is refused, unless it holds this
 * very address, which changes nothing.
 */
export const addRepoAs = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    environment,
    repo,
    author,
  }: {
    readonly environment: string;
    readonly repo: EnvironmentRepo;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): LifecycleChange =>
  storage.transactionSync((): LifecycleChange => {
    const known = store.getEnvironment(environment);

    if (known === null) return { status: "missing" };

    if (!isRepoName(repo.name)) {
      return { status: "rejected", message: `"${repo.name}" is not a usable directory name` };
    }

    const held = Arr.findFirst(known.repos, (each) => each.name === repo.name);

    if (Option.isSome(held)) {
      return held.value.url === repo.url
        ? { status: "unchanged", environment: known }
        : { status: "rejected", message: repoTaken(repo.name) };
    }

    store.addRepo(environment, repo);

    return {
      status: "changed",
      environment: store.getEnvironment(environment) ?? known,
      change: recorded(changes, environment, now, author, repoField(repo.name), null, repo.url),
    };
  });

/** Take the Repo in directory `name` out of `environment` and record it. */
export const removeRepoAs = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    environment,
    name,
    author,
  }: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): LifecycleOutcome<LifecycleChanged> =>
  storage.transactionSync((): LifecycleOutcome<LifecycleChanged> => {
    const known = store.getEnvironment(environment);

    if (known === null) return { status: "missing" };

    const held = Arr.findFirst(known.repos, (each) => each.name === name);

    if (Option.isNone(held)) {
      return { status: "rejected", message: noRepo(name) };
    }

    store.removeRepo(environment, name);

    return {
      status: "changed",
      environment: store.getEnvironment(environment) ?? known,
      change: recorded(changes, environment, now, author, repoField(name), held.value.url, null),
    };
  });

/** Record that `author` asked for a new Build of `environment`; the main Worker's Builds already have it under way. */
export const recordRebuildAs = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  { environment, author }: { readonly environment: string; readonly author: AgentChangeAuthor },
  now: number,
): LifecycleOutcome<LifecycleChanged> =>
  storage.transactionSync((): LifecycleOutcome<LifecycleChanged> => {
    const known = store.getEnvironment(environment);

    if (known === null) return { status: "missing" };

    return {
      status: "changed",
      environment: known,
      change: recorded(changes, environment, now, author, BUILD_FIELD, null, BUILD_ASKED),
    };
  });

/** The value of a lifecycle `field` in `environment`: its name, or a Repo's address (null for none). */
const lifecycleValue = (environment: EnvironmentRecord, field: string): Schema.Json | null => {
  if (field === NAME_FIELD) return environment.name;

  const repo = fieldRepo(field);

  if (repo === null) return null;

  const held = Arr.findFirst(environment.repos, (each) => each.name === repo);

  return Option.isSome(held) ? held.value.url : null;
};

/** Whether `field` is one of an Environment's record: its name or one of its Repos. */
export const isLifecycleField = (field: string): boolean =>
  field === NAME_FIELD || fieldRepo(field) !== null;

/** How the revert of a change to an Environment's record went. */
export type LifecycleRevert =
  | {
      readonly status: "reverted";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
    }
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    }
  | { readonly status: "refused"; readonly message: string };

/**
 * Revert `change` (the agent's, not reverted yet, of a lifecycle field: the caller checked) of `environment`: its name
 * or the Repo it added or removed put back, recorded as the owner's change. Refused when the field no longer has the
 * value the change gave it (`changed-since`), and when putting the old value back is not allowed now: another
 * Environment took the name, or the directory.
 */
export const revertLifecycleChange = (
  store: RegistryStore,
  changes: AgentChanges,
  environment: EnvironmentRecord,
  change: AgentChange,
  now: number,
): LifecycleRevert => {
  const value = lifecycleValue(environment, change.field);

  if (!Schema.toEquivalence(Schema.NullOr(Schema.Json))(value, change.after)) {
    return { status: "changed-since", field: change.field, current: value };
  }

  const before = change.before;
  const repo = fieldRepo(change.field);
  let reverted: EnvironmentRecord = environment;

  if (repo === null) {
    // A rename: the name before, unless another Environment has it now.
    if (!Predicate.isString(before)) {
      return { status: "refused", message: `Change ${change.id} has no name to put back` };
    }

    const naming = store.renameEnvironment(environment.id, before);

    if (naming.status === "taken") return { status: "refused", message: nameTaken(before) };

    if (naming.status === "missing") {
      return { status: "refused", message: noEnvironment(environment.id) };
    }

    reverted = naming.environment;
  } else if (Predicate.isString(before)) {
    // A Repo removed: back it goes, to the end of the list.
    store.addRepo(environment.id, { name: repo, url: before });
    reverted = store.getEnvironment(environment.id) ?? environment;
  } else {
    // A Repo added: out it goes.
    store.removeRepo(environment.id, repo);
    reverted = store.getEnvironment(environment.id) ?? environment;
  }

  const record = changes.record({
    scope: environment.id,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`,
    field: change.field,
    before: value,
    after: lifecycleValue(reverted, change.field),
    reverts: change.id,
  });

  return { status: "reverted", environment: reverted, change: record };
};
