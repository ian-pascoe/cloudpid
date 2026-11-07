// Triggers in the Registry (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _what_ a
// Trigger is, its definition at a revision number every change raises, and _whether_ it may fire, `admitFire`, the one
// place a Fire is let through. Synchronous over the Registry DO's SQLite, as the store is, so a check and the Session it
// registers are one step no other request lands in the middle of. The table is migration 34's (`store.ts`); deleting
// an Environment deletes its Triggers. The Registry never calls out: the caller wakes the Trigger's object.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over SQLite.
import { ThinkingLevel } from "@cloudpid/config";
import {
  fireTitle,
  scheduleOf,
  type ScheduleSource,
  scheduleProblem,
  TriggerDefinition,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerWhenBusy,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type {
  EnvironmentDeletion,
  RegistryStorage,
  RegistryStore,
  SessionRefusal,
} from "./store.ts";

/** A new Environment trigger, as the owner's form or `trigger_create` gives it. */
export type EnvironmentTriggerInput = {
  readonly kind: "environment";
  readonly environment: string;
  readonly name: string;
  readonly message: string;
  readonly source: ScheduleSource;
  /** `skip` when absent, a Schedule's default (`triggers.md` → Overlap). */
  readonly whenBusy?: TriggerWhenBusy | undefined;
  readonly base?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: ThinkingLevel | undefined;
  readonly paused?: boolean | undefined;
};

/**
 * A change of a Trigger's fields: each absent field is kept, and an option set to null goes back to its default. A
 * Trigger's kind and Environment are fixed at creation, so no change names them.
 */
export type TriggerPatch = {
  readonly name?: string | undefined;
  readonly message?: string | undefined;
  readonly source?: ScheduleSource | undefined;
  readonly whenBusy?: TriggerWhenBusy | undefined;
  readonly base?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly thinking?: ThinkingLevel | null | undefined;
};

/** What a write of a Trigger answers: the definition as kept, or why nothing was kept. */
export type TriggerWrite =
  | { readonly status: "ok"; readonly definition: TriggerDefinition }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly problem: string };

/** A Fire the Trigger object asks to let through (`admitFire`); its `requestId` is the Fire's key. */
export type FireAdmission = {
  readonly trigger: string;
  /** The revision of the definition the object acted on. */
  readonly revision: number;
  readonly requestId: string;
  /** The Schedule's time the Fire is for; absent for the owner's Fire now. */
  readonly scheduledAt?: number | undefined;
};

/**
 * What `admitFire` answers: the Session to send the Fire to (`started`; `repeated` for a Fire admitted before, whose
 * Session is answered again), `stale` with the current definition for the object to check again, or why the Fire does
 * not go: `removed`, `paused`, `skipped` (`overlap`) or `failed`. A reader treats a status it does not know as `failed`.
 */
export type FireAdmitted =
  | {
      readonly status: "started";
      readonly session: string;
      readonly environment: string;
      readonly repeated?: true | undefined;
    }
  | { readonly status: "stale"; readonly definition: TriggerDefinition }
  | { readonly status: "removed" }
  | { readonly status: "paused" }
  | { readonly status: "skipped"; readonly reason: "overlap" }
  | { readonly status: "failed"; readonly reason: string };

type TriggerRow = {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly environment: string;
  readonly name: string;
  readonly message: string;
  readonly source: string;
  readonly when_busy: string;
  readonly base: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly paused: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly removed_at: number | null;
  readonly last_session: string | null;
};

// @effect-diagnostics-next-line schemaSync:off -- read inside a transaction; each member a later build adds has a fallback.
const decodeDefinition = Schema.decodeUnknownSync(TriggerDefinition);

const isThinkingLevel = Schema.is(ThinkingLevel);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A row's fields but its options, read as `TriggerDefinition` reads them. */
const toFields = (row: TriggerRow): TriggerDefinition =>
  decodeDefinition({
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    environment: row.environment,
    name: row.name,
    message: row.message,
    // A source that doesn't read is one this version doesn't know.
    source: Option.getOrElse(decodeJson(row.source), () => ({ type: "unknown" })),
    whenBusy: row.when_busy,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toDefinition = (row: TriggerRow): TriggerDefinition => {
  const definition: Types.Mutable<TriggerDefinition> = toFields(row);

  if (row.base !== null) definition.base = row.base;

  if (row.model !== null) definition.model = row.model;

  // A level this version doesn't know is the Environment's.
  if (row.thinking !== null && isThinkingLevel(row.thinking)) definition.thinking = row.thinking;

  return definition;
};

/** Why `fields` can't be a Trigger's, or undefined when they can. */
const fieldsProblem = (fields: {
  readonly name: string;
  readonly message: string;
  readonly source: ScheduleSource;
  readonly base: string | null;
}): string | undefined =>
  triggerNameProblem(fields.name) ??
  triggerMessageProblem(fields.message) ??
  scheduleProblem(fields.source) ??
  (fields.base !== null && fields.base.trim() === "" ? "A base branch can't be empty" : undefined);

/** Why `refusal` kept a Fire's Session from being registered, as the fire log says it. */
const refusalReason = (refusal: SessionRefusal): string => {
  switch (refusal.refused) {
    case "no-environment":
      return "its Environment is gone";
    case "branch-taken":
      return "the Workspace's branch is taken";
    default:
      return `the Session was refused (${refusal.refused})`;
  }
};

/** The Registry's Triggers, over its storage and store. */
export const openTriggers = (
  storage: RegistryStorage,
  store: Pick<
    RegistryStore,
    "getEnvironment" | "getSession" | "createSession" | "requestedSession" | "deleteEnvironment"
  >,
) => {
  const { sql } = storage;

  const row = (id: string): TriggerRow | undefined =>
    sql
      .exec<TriggerRow>("SELECT * FROM triggers WHERE id = ? AND removed_at IS NULL", id)
      .toArray()[0];

  const definition = (id: string): TriggerDefinition | null => {
    const found = row(id);

    return found === undefined ? null : toDefinition(found);
  };

  /** Write `next`'s fields over its row; `next` holds the new revision. */
  const write = (next: TriggerRow): TriggerDefinition => {
    sql.exec(
      `UPDATE triggers SET revision = ?, name = ?, message = ?, source = ?, when_busy = ?, base = ?, model = ?,
         thinking = ?, paused = ?, updated_at = ? WHERE id = ?`,
      next.revision,
      next.name,
      next.message,
      next.source,
      next.when_busy,
      next.base,
      next.model,
      next.thinking,
      next.paused,
      next.updated_at,
      next.id,
    );

    return toDefinition(next);
  };

  /**
   * Whether the last Fire's Session `session` is still at work: anything but idle (a status this build doesn't know may
   * be one that runs), or made less than `startingMs` ago with its first Run not reported yet. Archived and deleted
   * Sessions are stopped.
   */
  const busy = (session: string | null, now: number, startingMs: number): boolean => {
    if (session === null) return false;

    const known = store.getSession(session);

    if (known === null || known.archivedAt !== null) return false;

    if (known.status !== "idle") return true;

    return known.updatedAt === known.createdAt && known.createdAt > now - startingMs;
  };

  return {
    create: (id: string, input: EnvironmentTriggerInput, now: number): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        if (store.getEnvironment(input.environment) === null) {
          return { status: "invalid", problem: `There is no Environment ${input.environment}` };
        }

        const base = input.base ?? null;
        const problem = fieldsProblem({ ...input, base });

        if (problem !== undefined) return { status: "invalid", problem };

        sql.exec(
          `INSERT INTO triggers (id, revision, kind, environment, name, message, source, when_busy, base, model, thinking,
             paused, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.kind,
          input.environment,
          input.name.trim(),
          input.message,
          JSON.stringify(input.source),
          input.whenBusy ?? "skip",
          base?.trim() ?? null,
          input.model ?? null,
          input.thinking ?? null,
          input.paused === true ? 1 : 0,
          now,
          now,
        );

        const made = definition(id);

        return made === null ? { status: "missing" } : { status: "ok", definition: made };
      }),

    get: definition,

    /** Every Trigger, or `environment`'s, newest first. */
    list: (environment?: string): Array<TriggerDefinition> =>
      Arr.map(
        environment === undefined
          ? sql
              .exec<TriggerRow>(
                "SELECT * FROM triggers WHERE removed_at IS NULL ORDER BY created_at DESC, id",
              )
              .toArray()
          : sql
              .exec<TriggerRow>(
                "SELECT * FROM triggers WHERE environment = ? AND removed_at IS NULL ORDER BY created_at DESC, id",
                environment,
              )
              .toArray(),
        toDefinition,
      ),

    update: (id: string, patch: TriggerPatch, now: number): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        const known = row(id);

        if (known === undefined) return { status: "missing" };

        const source = patch.source ?? scheduleOf(toDefinition(known));

        if (source === undefined) {
          return { status: "invalid", problem: "This version can't change the Trigger's source" };
        }

        /** An option's new value: kept when absent, back to its default (none) when null. */
        const option = <A>(value: A | null | undefined, kept: A | null): A | null =>
          value === undefined ? kept : value;

        const next: Types.Mutable<TriggerRow> = {
          ...known,
          revision: known.revision + 1,
          name: patch.name?.trim() ?? known.name,
          message: patch.message ?? known.message,
          source: JSON.stringify(source),
          when_busy: patch.whenBusy ?? known.when_busy,
          base: option(patch.base === null ? null : patch.base?.trim(), known.base),
          model: option(patch.model, known.model),
          thinking: option(patch.thinking, known.thinking),
          updated_at: now,
        };

        const problem = fieldsProblem({ ...next, source });

        if (problem !== undefined) return { status: "invalid", problem };

        return { status: "ok", definition: write(next) };
      }),

    setPaused: (id: string, paused: boolean, now: number): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        const known = row(id);

        if (known === undefined) return { status: "missing" };

        return {
          status: "ok",
          definition: write({
            ...known,
            revision: known.revision + 1,
            paused: paused ? 1 : 0,
            updated_at: now,
          }),
        };
      }),

    /** Forget a Trigger; says whether it was there. */
    remove: (id: string): boolean =>
      storage.transactionSync(() => {
        const removed = row(id) !== undefined;

        sql.exec("DELETE FROM triggers WHERE id = ?", id);

        return removed;
      }),

    /**
     * Let a Fire through, or say why not (`docs/architecture/triggers.md` → `admitFire`), in one transaction. A Fire let
     * through before (its `requestId`) is answered its Session again, whatever came since (a pause, a removal, a change,
     * the overlap), so a retried Fire completes the Session it registered. Otherwise the Trigger is there and active,
     * the caller's revision is current (else `stale` with the definition), and the overlap; then its Session is
     * registered in a new Workspace of the Environment (the spare when current), titled by cloudpid and marked with the
     * Trigger, under `ids.session` (and `ids.workspace`, unless the spare is taken). It counts nothing and caps nothing.
     */
    admit: (
      fire: FireAdmission,
      ids: { readonly session: string; readonly workspace: string },
      now: number,
      startingMs: number,
    ): FireAdmitted =>
      storage.transactionSync((): FireAdmitted => {
        // A Fire let through before (a retried alarm) is answered its Session again, whatever came since: its Session
        // is registered, and an empty one would be left if it were abandoned now.
        const earlier = store.requestedSession(fire.requestId, now);

        if (earlier !== null) {
          return {
            status: "started",
            session: earlier.id,
            environment: earlier.environment,
            repeated: true,
          };
        }

        const known = row(fire.trigger);

        if (known === undefined) return { status: "removed" };

        if (known.paused === 1) return { status: "paused" };

        const current = toDefinition(known);

        if (known.revision !== fire.revision) return { status: "stale", definition: current };

        if (current.whenBusy === "skip" && busy(known.last_session, now, startingMs)) {
          return { status: "skipped", reason: "overlap" };
        }

        if (current.source.type !== "schedule") {
          return { status: "failed", reason: "this version can't fire its source" };
        }

        const created = store.createSession(
          {
            id: ids.session,
            title: fireTitle(current.name, fire.scheduledAt ?? now, current.source.zone),
            workspace: {
              kind: "new",
              id: ids.workspace,
              environment: current.environment,
              branch: null,
              base: current.base ?? null,
            },
            marks: {
              kind: "trigger",
              auth: "trigger",
              trigger: { id: current.id, name: current.name },
            },
            requestId: fire.requestId,
          },
          now,
        );

        if ("refused" in created) return { status: "failed", reason: refusalReason(created) };

        sql.exec("UPDATE triggers SET last_session = ? WHERE id = ?", created.id, current.id);

        return { status: "started", session: created.id, environment: created.environment };
      }),

    /**
     * Delete Environment `id` (`store.deleteEnvironment`, which deletes its Triggers in the same transaction) and answer
     * the ids of the Triggers that went with it (`docs/architecture/triggers.md` → Cascades).
     */
    deleteEnvironment: (id: string): EnvironmentRemoval =>
      storage.transactionSync((): EnvironmentRemoval => {
        const held = Arr.map(
          sql.exec<{ id: string }>("SELECT id FROM triggers WHERE environment = ?", id).toArray(),
          (found) => found.id,
        );

        const deletion = store.deleteEnvironment(id);

        return { deletion, triggers: deletion === "deleted" ? held : [] };
      }),
  };
};

/** The Registry's Triggers. */
export type Triggers = ReturnType<typeof openTriggers>;

/** An Environment's deletion, with the ids of the Triggers that went with it, whose objects the caller wipes. */
export type EnvironmentRemoval = {
  readonly deletion: EnvironmentDeletion;
  readonly triggers: ReadonlyArray<string>;
};
