// Agent changes to the Secrets kept for an Environment, or for every Environment (`docs/spec.md` → Agent changes,
// ADR-0019): the Build mark the agent sets with `environment_secret_build`, applied as the owner's switch on the
// Environments page applies it and recorded with the mark before and after, and the revert of such a change. A Secret
// the owner keeps through `secret_ask`'s form is recorded by `keepSecretAs` (`environment-secrets.ts`) and has no revert.
// A name and a mark are all these records hold, never a value. The history of the Secrets kept for every Environment is
// the scope `*` (`EVERY_ENVIRONMENT_SCOPE`), which no Environment id can be.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  type AgentChange,
  fieldSecret,
  KEPT_SECRET,
  keptSecretField,
  secretBuildField,
} from "@cloudpid/protocol";
import * as Predicate from "effect/Predicate";
import {
  type AgentChangeAuthor,
  type AgentChangeRevert,
  type AgentChanges,
  approvedMark,
} from "./agent-changes.ts";
import {
  EVERY_ENVIRONMENT_SCOPE,
  type RegistryStorage,
  type RegistryStore,
  type EnvironmentRecord,
} from "./store.ts";

/** What the history of the Secrets kept for every Environment is called in a change's Environment. */
export const EVERY_ENVIRONMENT_NAME = "every Environment";

/** An Environment, or every Environment, as a change names it. */
export type SecretScope = { readonly id: string; readonly name: string };

/** How the agent's change of a kept Secret's Build mark went. */
export type SecretBuildMark =
  | { readonly status: "changed"; readonly environment: SecretScope; readonly change: AgentChange }
  /** The Secret already had the mark: nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly environment: SecretScope; readonly build: boolean }
  /** No Secret of the name is kept in that scope. */
  | { readonly status: "absent"; readonly environment: SecretScope }
  | { readonly status: "missing" };

/** How the agent's delete of a kept Secret went, once the owner approved it. */
export type SecretDeletion =
  | { readonly status: "deleted"; readonly environment: SecretScope; readonly change: AgentChange }
  /** No Secret of the name is kept in that scope: nothing was deleted or recorded. */
  | { readonly status: "absent"; readonly environment: SecretScope }
  | { readonly status: "missing" };

/** The part of the store these changes use. */
export type SecretMarkStore = Pick<
  RegistryStore,
  "getEnvironment" | "listEnvironmentSecrets" | "setEnvironmentSecretBuild"
>;

/** The part of the store a delete uses. */
export type SecretDeleteStore = SecretMarkStore & Pick<RegistryStore, "deleteEnvironmentSecret">;

const scopeOf = (scope: string, store: SecretMarkStore): SecretScope | null => {
  if (scope === EVERY_ENVIRONMENT_SCOPE) {
    return { id: EVERY_ENVIRONMENT_SCOPE, name: EVERY_ENVIRONMENT_NAME };
  }

  const record: EnvironmentRecord | null = store.getEnvironment(scope);

  return record === null ? null : { id: record.id, name: record.name };
};

/** The Build mark of the Secret `name` kept in `scope`, or null when none is kept there. */
const markOf = (store: SecretMarkStore, scope: string, name: string): boolean | null => {
  const found = store
    .listEnvironmentSecrets()
    .find(
      (record) => (record.environment ?? EVERY_ENVIRONMENT_SCOPE) === scope && record.name === name,
    );

  return found === undefined ? null : found.build;
};

/**
 * Mark the Secret `name` kept in `scope` (an Environment's id, or `*` for every Environment) for the Build, or take the
 * mark off, as the owner's switch does, and record the change by `author`. A Secret that has the mark records nothing.
 */
export const markSecretBuildAs = (
  storage: Pick<RegistryStorage, "transactionSync">,
  store: SecretMarkStore,
  changes: AgentChanges,
  {
    environment,
    name,
    build,
    author,
  }: {
    readonly environment: string;
    readonly name: string;
    readonly build: boolean;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): SecretBuildMark =>
  storage.transactionSync((): SecretBuildMark => {
    const where = scopeOf(environment, store);

    if (where === null) return { status: "missing" };

    const before = markOf(store, environment, name);

    if (before === null) return { status: "absent", environment: where };

    if (before === build) return { status: "unchanged", environment: where, build };

    store.setEnvironmentSecretBuild(
      environment === EVERY_ENVIRONMENT_SCOPE ? null : environment,
      name,
      build,
      now,
    );

    const change = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: secretBuildField(name),
      before,
      after: build,
      reverts: null,
    });

    return { status: "changed", environment: where, change };
  });

/**
 * Delete the Secret `name` kept in `scope` (an Environment's id, or `*` for every Environment), as the owner's delete on
 * the Environments page does, and record it by `author`, the agent the owner approved: `secrets.<NAME>`, `kept` before
 * and none after. It has no revert: the history holds no value to bring back.
 */
export const deleteSecretAs = (
  storage: Pick<RegistryStorage, "transactionSync">,
  store: SecretDeleteStore,
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
): SecretDeletion =>
  storage.transactionSync((): SecretDeletion => {
    const where = scopeOf(environment, store);

    if (where === null) return { status: "missing" };

    if (
      !store.deleteEnvironmentSecret(
        environment === EVERY_ENVIRONMENT_SCOPE ? null : environment,
        name,
      )
    ) {
      return { status: "absent", environment: where };
    }

    const change = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: keptSecretField(name),
      before: KEPT_SECRET,
      after: null,
      reverts: null,
      ...approvedMark(author),
    });

    return { status: "deleted", environment: where, change };
  });

/**
 * The owner's revert of `change`, a Build mark in `scope`: the mark before written back and recorded as the owner's
 * change. Refused, saying what the mark is now, when the Secret no longer has the mark the change gave it (or is no
 * longer kept).
 */
export const revertSecretBuild = (
  store: SecretMarkStore,
  changes: AgentChanges,
  scope: string,
  change: AgentChange,
  now: number,
): AgentChangeRevert => {
  const secret = fieldSecret(change.field);

  if (secret === null || secret.kind !== "build") return { status: "missing" };

  const current = markOf(store, scope, secret.name);

  if (current !== change.after) {
    return { status: "changed-since", field: change.field, current };
  }

  if (!Predicate.isBoolean(change.before)) {
    return { status: "refused", message: "The change holds no mark to put back" };
  }

  store.setEnvironmentSecretBuild(
    scope === EVERY_ENVIRONMENT_SCOPE ? null : scope,
    secret.name,
    change.before,
    now,
  );

  const recorded = changes.record({
    scope,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: `Reverted change ${change.id}${change.tool === null ? "" : ` (${change.tool})`}`,
    field: change.field,
    before: current,
    after: change.before,
    reverts: change.id,
  });

  return { status: "reverted", change: recorded };
};
