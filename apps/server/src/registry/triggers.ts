// Triggers in the Registry (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _what_ a
// Trigger is, its definition at a revision number every change raises, and _whether_ it may fire, `admitFire`, the one
// place a Fire is let through. Synchronous over the Registry DO's SQLite, as the store is, so a check and the Session it
// registers are one step no other request lands in the middle of. The table is migration 34's (`store.ts`); deleting
// an Environment deletes its Triggers. The Registry never calls out: the caller wakes the Trigger's object.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over SQLite.
import { ThinkingLevel } from "@cloudpid/config";
import {
  defaultWhenBusy,
  type EnvironmentTriggerInput,
  fireTitle,
  sourceProblem,
  TriggerDefinition,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerChangeValue,
  type TriggerPatch,
  type TriggerSourceInput,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type {
  EnvironmentDeletion,
  RegistryStorage,
  RegistryStore,
  SessionRefusal,
} from "./store.ts";
import { triggerIdTaken } from "./messages.ts";

/** What a write of a Trigger answers: the definition as kept, or why nothing was kept. */
export type TriggerWrite =
  | { readonly status: "ok"; readonly definition: TriggerDefinition }
  /** The Trigger already was as asked: nothing was written, and its revision stays. */
  | { readonly status: "unchanged"; readonly definition: TriggerDefinition }
  /** The Trigger is no longer as the caller's `holds` wants it: nothing was written. */
  | { readonly status: "changed-since"; readonly definition: TriggerDefinition }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly problem: string };

/** A Fire the Trigger object asks to let through (`admitFire`); its `requestId` is the Fire's key. */
export type FireAdmission = {
  readonly trigger: string;
  /** The revision of the definition the object acted on. */
  readonly revision: number;
  readonly requestId: string;
  /** The Schedule's time the Fire is for; absent for the owner's Fire now and a delivery's Fire. */
  readonly scheduledAt?: number | undefined;
  /** The event of the delivery the Fire is for (a webhook's), which its Session's title carries. */
  readonly event?: string | undefined;
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

/**
 * A source as its column keeps it, its keys always in one order (a `match`'s paths sorted, its values as given, which
 * are an order the owner may have meant), so the same source is the same text.
 */
const sourceText = (source: TriggerSourceInput): string => {
  if (source.type === "schedule") {
    return JSON.stringify({ type: source.type, cron: source.cron, zone: source.zone });
  }

  const { type, format, match } = source;

  if (match === undefined) return JSON.stringify({ type, format });

  return JSON.stringify({
    type,
    format,
    match: Record.fromEntries(
      Arr.map(
        Arr.sort(Record.keys(match), Order.String),
        (path) => [path, match[path] ?? []] as const,
      ),
    ),
  });
};

/** The source `definition` fires on, as one a change may keep; undefined for one this version doesn't know. */
const sourceOf = (definition: TriggerDefinition): TriggerSourceInput | undefined =>
  definition.source.type === "unknown" ? undefined : definition.source;

/** Why `fields` can't be a Trigger's, or undefined when they can. */
const fieldsProblem = (fields: {
  readonly name: string;
  readonly message: string;
  readonly source: TriggerSourceInput;
  readonly base: string | null;
}): string | undefined =>
  triggerNameProblem(fields.name) ??
  triggerMessageProblem(fields.message) ??
  sourceProblem(fields.source) ??
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

/**
 * `source` with `match` (null: none) as its filter, or why it can't have one: only a webhook source has a `match`, so a
 * Trigger that fires on a Schedule refuses it. Absent: the source as it is.
 */
const withMatch = (
  source: TriggerSourceInput,
  match: TriggerPatch["match"],
): { readonly source: TriggerSourceInput } | { readonly problem: string } => {
  if (match === undefined) return { source };

  if (source.type !== "webhook") return { problem: "Only a webhook Trigger has a match" };

  const { match: _kept, ...rest } = source;

  return { source: match === null ? rest : { ...rest, match } };
};

/** The fields of a Trigger a change can give it. */
const CHANGEABLE = [
  "name",
  "message",
  "source",
  "when_busy",
  "base",
  "model",
  "thinking",
  "paused",
] as const satisfies ReadonlyArray<keyof TriggerRow>;

/** Whether `next` gives a Trigger the fields it has (`known`): a change of none of them is no change. */
const sameFields = (known: TriggerRow, next: TriggerRow): boolean =>
  Arr.every(CHANGEABLE, (field) => known[field] === next[field]);

/**
 * Forget the Triggers the agent removed that no Agent change in the history refers to any more: one is kept while a
 * revert could bring it back (`docs/architecture/triggers.md` → Agent tools and Approval).
 */
export const dropRemovedTriggers = (sql: RegistryStorage["sql"]): void => {
  sql.exec(
    `DELETE FROM triggers WHERE removed_at IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM agent_changes WHERE agent_changes.scope = triggers.environment
         AND agent_changes.field = 'triggers.' || triggers.id
     )`,
  );
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
    /**
     * Keep Trigger `id` made of `input`, at revision 1. Made again under the same id (a retry) with the same input, it
     * is `unchanged`; with other input it is refused, and so is the id of a Trigger the agent removed, whose row is kept
     * for a revert. The owner's removal deletes the row, so its id could be used again.
     */
    create: (id: string, input: EnvironmentTriggerInput, now: number): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        if (store.getEnvironment(input.environment) === null) {
          return { status: "invalid", problem: `There is no Environment ${input.environment}` };
        }

        const base = input.base ?? null;
        const problem = fieldsProblem({ ...input, base });

        if (problem !== undefined) return { status: "invalid", problem };

        const made: TriggerRow = {
          id,
          revision: 1,
          kind: input.kind,
          environment: input.environment,
          name: input.name.trim(),
          message: input.message,
          source: sourceText(input.source),
          when_busy: input.whenBusy ?? defaultWhenBusy(input.source),
          base: base?.trim() ?? null,
          model: input.model ?? null,
          thinking: input.thinking ?? null,
          paused: input.paused === true ? 1 : 0,
          created_at: now,
          updated_at: now,
          removed_at: null,
          last_session: null,
        };

        const [known] = sql.exec<TriggerRow>("SELECT * FROM triggers WHERE id = ?", id).toArray();

        if (known !== undefined) {
          return known.removed_at === null &&
            known.kind === made.kind &&
            known.environment === made.environment &&
            sameFields(known, made)
            ? { status: "unchanged", definition: toDefinition(known) }
            : { status: "invalid", problem: triggerIdTaken };
        }

        sql.exec(
          `INSERT INTO triggers (id, revision, kind, environment, name, message, source, when_busy, base, model, thinking,
             paused, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          made.kind,
          made.environment,
          made.name,
          made.message,
          made.source,
          made.when_busy,
          made.base,
          made.model,
          made.thinking,
          made.paused,
          now,
          now,
        );

        return { status: "ok", definition: toDefinition(made) };
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

    /**
     * Change Trigger `id`'s fields at its next revision. A change of none of them writes nothing (`unchanged`); with
     * `holds`, nothing is written either unless the Trigger is as `holds` wants it (`changed-since`).
     */
    update: (
      id: string,
      patch: TriggerPatch,
      now: number,
      holds?: (current: TriggerDefinition) => boolean,
    ): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        const known = row(id);

        if (known === undefined) return { status: "missing" };

        const kept = sourceOf(toDefinition(known));
        const changed = patch.source ?? kept;

        if (changed === undefined) {
          return { status: "invalid", problem: "This version can't change the Trigger's source" };
        }

        // A `match` alone changes a webhook's filter and nothing else of its source.
        const matched = withMatch(changed, patch.match);

        if ("problem" in matched) return { status: "invalid", problem: matched.problem };

        const { source } = matched;

        /** An option's new value: kept when absent, back to its default (none) when null. */
        const option = <A>(value: A | null | undefined, kept: A | null): A | null =>
          value === undefined ? kept : value;

        const next: Types.Mutable<TriggerRow> = {
          ...known,
          revision: known.revision + 1,
          name: patch.name?.trim() ?? known.name,
          message: patch.message ?? known.message,
          source: sourceText(source),
          when_busy: patch.whenBusy ?? known.when_busy,
          base: option(patch.base === null ? null : patch.base?.trim(), known.base),
          model: option(patch.model, known.model),
          thinking: option(patch.thinking, known.thinking),
          updated_at: now,
        };

        const problem = fieldsProblem({ ...next, source });

        if (problem !== undefined) return { status: "invalid", problem };

        const current = toDefinition(known);

        if (sameFields(known, next)) return { status: "unchanged", definition: current };

        if (holds !== undefined && !holds(current)) {
          return { status: "changed-since", definition: current };
        }

        return { status: "ok", definition: write(next) };
      }),

    /** Pause or resume Trigger `id` at its next revision; as `update` for one already so, and for `holds`. */
    setPaused: (
      id: string,
      paused: boolean,
      now: number,
      holds?: (current: TriggerDefinition) => boolean,
    ): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        const known = row(id);

        if (known === undefined) return { status: "missing" };

        const current = toDefinition(known);

        if (current.paused === paused) return { status: "unchanged", definition: current };

        if (holds !== undefined && !holds(current)) {
          return { status: "changed-since", definition: current };
        }

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

    /**
     * Trigger `id`'s definition, and when the agent removed it (null: it is active), or null once it is gone for good:
     * what a revert of one of its Agent changes reads.
     */
    stored: (
      id: string,
    ): { readonly definition: TriggerDefinition; readonly removedAt: number | null } | null => {
      const [found] = sql.exec<TriggerRow>("SELECT * FROM triggers WHERE id = ?", id).toArray();

      return found === undefined
        ? null
        : { definition: toDefinition(found), removedAt: found.removed_at };
    },

    /**
     * Take an active Trigger out of every read and every Fire, keeping its row while an Agent change refers to it, so a
     * revert can bring it back (`dropRemovedTriggers`); says whether it was active.
     */
    retire: (id: string, now: number): boolean =>
      sql
        .exec<{ id: string }>(
          "UPDATE triggers SET removed_at = ? WHERE id = ? AND removed_at IS NULL RETURNING id",
          now,
          id,
        )
        .toArray().length > 0,

    /**
     * Give Trigger `id` (active, or removed by the agent) the fields of `value`, active again, at its next revision: a
     * revert. Its kind and Environment stay; the caller checked `value`.
     */
    restore: (id: string, value: TriggerChangeValue, now: number): TriggerDefinition | null => {
      const [known] = sql.exec<TriggerRow>("SELECT * FROM triggers WHERE id = ?", id).toArray();

      if (known === undefined) return null;

      const source = value.source.type === "unknown" ? undefined : value.source;

      sql.exec("UPDATE triggers SET removed_at = NULL WHERE id = ?", id);

      return write({
        ...known,
        revision: known.revision + 1,
        name: value.name,
        message: value.message,
        source: source === undefined ? known.source : sourceText(source),
        when_busy: value.whenBusy,
        base: value.base ?? null,
        model: value.model ?? null,
        thinking: value.thinking ?? null,
        paused: value.paused ? 1 : 0,
        updated_at: now,
      });
    },

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

        if (current.source.type === "unknown") {
          return { status: "failed", reason: "this version can't fire its source" };
        }

        // A Schedule's Fire is titled by its scheduled time in its zone, a webhook's by the event and the time in UTC.
        const title =
          current.source.type === "schedule"
            ? fireTitle(current.name, fire.scheduledAt ?? now, current.source.zone)
            : fireTitle(current.name, now, "UTC", fire.event ?? "webhook");

        const created = store.createSession(
          {
            id: ids.session,
            title,
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
