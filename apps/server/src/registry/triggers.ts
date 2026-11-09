// Triggers in the Registry (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _what_ a
// Trigger is, its definition at a revision number every change raises, and _whether_ it may fire, `admitFire`, the one
// place a Fire is let through. Synchronous over the Registry DO's SQLite, as the store is, so a check and the Session it
// registers are one step no other request lands in the middle of. The table is migration 34's (`store.ts`); deleting
// an Environment deletes its Triggers. The Registry never calls out: the caller wakes the Trigger's object.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over SQLite.
import { ThinkingLevel } from "@cloudpid/config";
import {
  defaultWhenBusy,
  fireTitle,
  ownOptionsProblem,
  senderText,
  type TriggerSource,
  webhookFireTitle,
  sourceProblem,
  TriggerDefinition,
  type TriggerInput,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerChangeValue,
  type TriggerKind,
  type TriggerPatch,
  type TriggerSourceInput,
  type WorkspaceRef,
  whenBusyProblem,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  type Deletion,
  type EnvironmentDeletion,
  type RegistryStorage,
  type RegistryStore,
  REQUEST_MEMORY_MS,
  type SessionRecord,
  type SessionRefusal,
} from "./store.ts";
import { noWorkspace, subagentWorkspaceHoldsNoTrigger, triggerIdTaken } from "./messages.ts";

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
  /**
   * Whether the caller knows Session triggers, which are answered `send`. A caller that doesn't say so is never
   * answered a status it can't read: a Session trigger's Fire fails for it, to be tried again once it is replaced.
   */
  readonly sessionTriggers?: true | undefined;
};

/**
 * What `admitFire` answers: the Session to send the Fire to (`started`, a new one; `repeated` for a Fire admitted
 * before, whose Session is answered again), a Session trigger's own Session to send it to (`send`, only to a caller
 * that said it knows Session triggers: no Session or Workspace is made, so no upkeep follows), `stale` with the current
 * definition for the object to check again, or why the Fire does not go: `busy` (a Workspace trigger's `wait`: tried
 * again later), `removed`, `paused`, `skipped` (`overlap`) or `failed`. A reader treats a status it does not know as
 * `failed`.
 */
export type FireAdmitted =
  | {
      readonly status: "started";
      readonly session: string;
      readonly environment: string;
      readonly repeated?: true | undefined;
    }
  | {
      readonly status: "send";
      readonly session: string;
      readonly environment: string;
      readonly repeated?: true | undefined;
    }
  | { readonly status: "stale"; readonly definition: TriggerDefinition }
  /** A Workspace trigger's `wait`: some Session in its Workspace isn't idle, so the Fire stays pending to try again. */
  | { readonly status: "busy" }
  | { readonly status: "removed" }
  | { readonly status: "paused" }
  | { readonly status: "skipped"; readonly reason: "overlap" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * What `admit` answers a caller that does not know Session triggers for one: not a `FireAdmitted` status, which that
 * caller could not read, but a refusal `admitFire` turns into a failed call, so its Fire is tried again once it runs
 * newer code.
 */
export type FireUnsupported = { readonly status: "unsupported" };

type TriggerRow = {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly environment: string;
  /** The Workspace a Workspace trigger keeps; null for the other kinds. */
  readonly workspace: string | null;
  readonly name: string;
  readonly message: string;
  readonly source: string;
  readonly when_busy: string;
  readonly base: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly session: string | null;
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

const toDefinition = (row: TriggerRow, workspace?: WorkspaceRef): TriggerDefinition => {
  const definition: Types.Mutable<TriggerDefinition> = toFields(row);

  if (workspace !== undefined) definition.workspace = workspace;

  if (row.session !== null) definition.session = row.session;

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

  const { type, format, match, repo, events } = source;

  // A GitHub-managed hook's repo and events (`triggers.md` → GitHub-managed hooks): its events sorted, as GitHub keeps them.
  const hook =
    repo === undefined || events === undefined
      ? {}
      : { repo, events: Arr.sort(events, Order.String) };

  if (match === undefined) return JSON.stringify({ type, format, ...hook });

  return JSON.stringify({
    type,
    format,
    ...hook,
    match: Record.fromEntries(
      Arr.map(
        Arr.sort(Record.keys(match), Order.String),
        (path) => [path, match[path] ?? []] as const,
      ),
    ),
  });
};

/** The source `holder` (a definition, or a change's value) fires on, as one a change may keep; undefined for one this version doesn't know. */
const sourceOf = (holder: { readonly source: TriggerSource }): TriggerSourceInput | undefined =>
  holder.source.type === "unknown" ? undefined : holder.source;

/**
 * The source a patch's `requested` source leaves a Trigger that has `kept`: a Trigger's source type and format are fixed
 * at creation (a Schedule never becomes a webhook, which has secrets only its creation makes, nor the reverse), so a
 * request that names another is refused. A Schedule is replaced by the request; a webhook is changed only through
 * `patch.match`, so a request for one leaves it as it is, its stored `match` with it.
 */
const changedSource = (
  kept: TriggerSourceInput,
  requested: TriggerSourceInput | undefined,
): { readonly source: TriggerSourceInput } | { readonly problem: string } => {
  if (
    requested !== undefined &&
    (requested.type !== kept.type ||
      (requested.type === "webhook" && kept.type === "webhook" && requested.format !== kept.format))
  ) {
    return {
      problem:
        "A Trigger's source type and format are fixed when it is made: remove it and make another to change them",
    };
  }

  return { source: requested !== undefined && kept.type === "schedule" ? requested : kept };
};

/** Why `fields` can't be those of a Trigger of `kind`, or undefined when they can. */
const fieldsProblem = (
  kind: TriggerKind,
  fields: {
    readonly name: string;
    readonly message: string;
    readonly source: TriggerSourceInput;
    readonly when_busy: string;
    readonly base: string | null;
    readonly model: string | null;
    readonly thinking: string | null;
  },
): string | undefined =>
  triggerNameProblem(fields.name) ??
  triggerMessageProblem(fields.message) ??
  // The input is not decoded over RPC, so a Session trigger's Schedule-only source is held here too.
  (kind === "session" && fields.source.type !== "schedule"
    ? "A Session trigger fires on a Schedule only"
    : undefined) ??
  sourceProblem(fields.source) ??
  whenBusyProblem(kind, fields.when_busy) ??
  (fields.base !== null && fields.base.trim() === ""
    ? "A base branch can't be empty"
    : undefined) ??
  ownOptionsProblem(kind, {
    base: fields.base ?? undefined,
    model: fields.model ?? undefined,
    thinking: fields.thinking ?? undefined,
  });

/** Why `refusal` kept a Fire's Session from being registered, as the fire log says it. */
const refusalReason = (refusal: SessionRefusal): string => {
  switch (refusal.refused) {
    case "no-environment":
      return "its Environment is gone";
    case "branch-taken":
      return "the Workspace's branch is taken";
    case "no-workspace":
      return "its Workspace is gone";
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
    | "getEnvironment"
    | "getSession"
    | "getWorkspace"
    | "createSession"
    | "requestedSession"
    | "deleteEnvironment"
    | "deleteWorkspace"
    | "deleteWorkspaceWithTriggers"
    | "deleteSession"
  >,
) => {
  const { sql } = storage;

  /** The ids of the active Triggers kept for Workspace `id`. */
  const activeWorkspaceTriggers = (id: string): ReadonlyArray<string> =>
    Arr.map(
      sql
        .exec<{ id: string }>(
          "SELECT id FROM triggers WHERE workspace = ? AND removed_at IS NULL",
          id,
        )
        .toArray(),
      (found) => found.id,
    );

  /** `row` as a definition, its Workspace named by id and branch. */
  const toDef = (found: TriggerRow): TriggerDefinition => {
    if (found.workspace === null) return toDefinition(found);

    const [kept] = sql
      .exec<{ branch: string }>("SELECT branch FROM workspaces WHERE id = ?", found.workspace)
      .toArray();

    return toDefinition(found, { id: found.workspace, branch: kept?.branch ?? "" });
  };

  const row = (id: string): TriggerRow | undefined =>
    sql
      .exec<TriggerRow>("SELECT * FROM triggers WHERE id = ? AND removed_at IS NULL", id)
      .toArray()[0];

  /**
   * The Session a Fire was let through to as a Session trigger's, less than `REQUEST_MEMORY_MS` ago, if it is still
   * listed. Rows past the memory are dropped as they are found.
   */
  const sentSession = (requestId: string, now: number): SessionRecord | null => {
    sql.exec("DELETE FROM trigger_sends WHERE at <= ?", now - REQUEST_MEMORY_MS);

    const sent = sql
      .exec<{ session: string }>(
        "SELECT session FROM trigger_sends WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];

    return sent === undefined ? null : store.getSession(sent.session);
  };

  const definition = (id: string): TriggerDefinition | null => {
    const found = row(id);

    return found === undefined ? null : toDef(found);
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

    return toDef(next);
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

  /** Whether any Session in Workspace `workspace` is at work (`busy`), the owner's own included. */
  const workspaceBusy = (workspace: string, now: number, startingMs: number): boolean =>
    Arr.some(
      sql.exec<{ id: string }>("SELECT id FROM sessions WHERE workspace = ?", workspace).toArray(),
      (session) => busy(session.id, now, startingMs),
    );

  /**
   * Delete Session `id`'s Session triggers, and the memory of the Fires let through to it (`trigger_sends`), which
   * would keep answering `send` while the Session is listed; answer the ids of the active ones.
   */
  const deleteOfSession = (id: string): ReadonlyArray<string> =>
    storage.transactionSync((): ReadonlyArray<string> => {
      // Only the active ones answered: a Trigger the agent removed has its object wiped already, or wipes itself at its next alarm.
      const held = Arr.map(
        sql
          .exec<{ id: string }>(
            "SELECT id FROM triggers WHERE session = ? AND removed_at IS NULL",
            id,
          )
          .toArray(),
        (found) => found.id,
      );

      sql.exec("DELETE FROM triggers WHERE session = ?", id);
      sql.exec("DELETE FROM trigger_sends WHERE session = ?", id);

      return held;
    });

  return {
    /**
     * Keep Trigger `id` made of `input`, at revision 1. Made again under the same id (a retry) with the same input, it
     * is `unchanged`; with other input it is refused, and so is the id of a Trigger the agent removed, whose row is kept
     * for a revert. The owner's removal deletes the row, so its id could be used again.
     */
    create: (id: string, input: TriggerInput, now: number): TriggerWrite =>
      storage.transactionSync((): TriggerWrite => {
        let environment: string | undefined;
        let workspace: string | null = null;
        let base: string | null = null;

        if (input.kind === "workspace") {
          // A Workspace trigger keeps a Workspace a Session works in: a spare is bound to nothing, and a Subagent
          // Workspace lasts as long as its subagent, which has no trigger tools.
          const kept = store.getWorkspace(input.workspace);

          if (kept === null) {
            return { status: "invalid", problem: noWorkspace(input.workspace) };
          }

          if (kept.subagent !== undefined) {
            return { status: "invalid", problem: subagentWorkspaceHoldsNoTrigger };
          }

          environment = kept.environment;
          workspace = kept.id;
        } else if (input.kind === "session") {
          // A Session trigger belongs to its Session's Environment.
          environment = store.getSession(input.session)?.environment;

          if (environment === undefined) {
            return { status: "invalid", problem: `There is no Session ${input.session}` };
          }
        } else {
          environment = input.environment;
          base = input.base ?? null;
        }

        if (store.getEnvironment(environment) === null) {
          return { status: "invalid", problem: `There is no Environment ${environment}` };
        }

        const whenBusy = input.whenBusy ?? defaultWhenBusy(input.kind, input.source);
        // A Session trigger's input has no options of its own, and an Environment trigger's alone has a base.
        const model = "model" in input ? (input.model ?? null) : null;
        const thinking = "thinking" in input ? (input.thinking ?? null) : null;

        const problem = fieldsProblem(input.kind, {
          ...input,
          when_busy: whenBusy,
          base,
          model,
          thinking,
        });

        if (problem !== undefined) return { status: "invalid", problem };

        const made: TriggerRow = {
          id,
          revision: 1,
          kind: input.kind,
          environment,
          workspace,
          name: input.name.trim(),
          message: input.message,
          source: sourceText(input.source),
          when_busy: whenBusy,
          base: base?.trim() ?? null,
          model,
          thinking,
          session: input.kind === "session" ? input.session : null,
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
            known.workspace === made.workspace &&
            known.session === made.session &&
            sameFields(known, made)
            ? { status: "unchanged", definition: toDef(known) }
            : { status: "invalid", problem: triggerIdTaken };
        }

        sql.exec(
          `INSERT INTO triggers (id, revision, kind, environment, workspace, name, message, source, when_busy, base, model,
             thinking, session, paused, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          made.kind,
          made.environment,
          made.workspace,
          made.name,
          made.message,
          made.source,
          made.when_busy,
          made.base,
          made.model,
          made.thinking,
          made.session,
          made.paused,
          now,
          now,
        );

        return { status: "ok", definition: toDef(made) };
      }),

    get: definition,

    /**
     * Which of `ids` name a Trigger the Registry holds, active or paused: one the agent removed (kept only for a revert)
     * is not one, so the orphan sweep deletes its hook (`triggers.md` → GitHub-managed hooks).
     */
    known: (ids: ReadonlyArray<string>): Array<string> =>
      Arr.filter(
        Arr.dedupe(ids),
        (id) =>
          sql
            .exec<{ found: number }>(
              "SELECT EXISTS (SELECT 1 FROM triggers WHERE id = ? AND removed_at IS NULL) AS found",
              id,
            )
            .one().found === 1,
      ),

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
        toDef,
      ),

    /** The Session triggers of Session `session`, newest first. */
    listOfSession: (session: string): Array<TriggerDefinition> =>
      Arr.map(
        sql
          .exec<TriggerRow>(
            "SELECT * FROM triggers WHERE removed_at IS NULL AND session = ? ORDER BY created_at DESC, id",
            session,
          )
          .toArray(),
        toDef,
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

        const kept = sourceOf(toDef(known));

        if (kept === undefined) {
          return { status: "invalid", problem: "This version can't change the Trigger's source" };
        }

        const changed = changedSource(kept, patch.source);

        if ("problem" in changed) return { status: "invalid", problem: changed.problem };

        // A `match` alone changes a webhook's filter and nothing else of its source.
        const matched = withMatch(changed.source, patch.match);

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

        const problem = fieldsProblem(toFields(known).kind, { ...next, source });

        if (problem !== undefined) return { status: "invalid", problem };

        const current = toDef(known);

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

        const current = toDef(known);

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

      return found === undefined ? null : { definition: toDef(found), removedAt: found.removed_at };
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

      const source = sourceOf(value);

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
    ): FireAdmitted | FireUnsupported =>
      storage.transactionSync((): FireAdmitted | FireUnsupported => {
        // A Fire let through before (a retried alarm) is answered its Session again, whatever came since: its Session
        // is registered, and an empty one would be left if it were abandoned now.
        const earlier = store.requestedSession(fire.requestId, now);

        // Likewise a Fire let through to a Session trigger's Session, whether its Trigger is paused or gone by now: the
        // Session still lists it, and the Fire goes on to it.
        const sent = fire.sessionTriggers === true ? sentSession(fire.requestId, now) : null;

        if (sent !== null) {
          return {
            status: "send",
            session: sent.id,
            environment: sent.environment,
            repeated: true,
          };
        }

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

        const current = toDef(known);

        if (known.revision !== fire.revision) return { status: "stale", definition: current };

        // A Session trigger sends to its own Session, which no Fire makes: the Session decides the overlap, since only
        // it knows whether its Run is going on (`session/fire.ts`).
        if (current.kind === "session") {
          // Not for a caller that can't read `send`: nothing is kept, and `admitFire` fails its call (`Registry.ts`).
          if (fire.sessionTriggers !== true) return { status: "unsupported" };

          const own = current.session === undefined ? null : store.getSession(current.session);

          if (own === null || current.source.type !== "schedule") {
            return {
              status: "failed",
              reason: own === null ? "its Session is gone" : "this version can't fire its source",
            };
          }

          sql.exec(
            "INSERT OR REPLACE INTO trigger_sends (request_id, session, at) VALUES (?, ?, ?)",
            fire.requestId,
            own.id,
            now,
          );

          return { status: "send", session: own.id, environment: own.environment };
        }

        // A Workspace trigger is busy while any Session in its Workspace is at work; the rest, while their last Fire's
        // Session is.
        const overlapping =
          current.workspace === undefined
            ? busy(known.last_session, now, startingMs)
            : workspaceBusy(current.workspace.id, now, startingMs);

        if (overlapping) {
          if (current.whenBusy === "wait") return { status: "busy" };

          if (current.whenBusy === "skip") return { status: "skipped", reason: "overlap" };
        }

        if (current.source.type === "unknown") {
          return { status: "failed", reason: "this version can't fire its source" };
        }

        // A Schedule's Fire is titled by its scheduled time in its zone, a webhook's by the event and the time in UTC.
        const title =
          current.source.type === "schedule"
            ? fireTitle(current.name, fire.scheduledAt ?? now, current.source.zone)
            : webhookFireTitle(current.name, now, senderText(fire.event ?? "webhook"));

        const created = store.createSession(
          {
            id: ids.session,
            title,
            workspace:
              current.workspace === undefined
                ? {
                    kind: "new",
                    id: ids.workspace,
                    environment: current.environment,
                    branch: null,
                    base: current.base ?? null,
                  }
                : { kind: "existing", id: current.workspace.id },
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
     * Delete Workspace `id`'s Triggers alone, whatever Sessions are bound to it, and answer the ids of the active ones,
     * whose objects the caller wipes: the owner's Remove does it first, so no waiting Fire starts a Session in a
     * Workspace that is being torn down (`docs/architecture/triggers.md` → Cascades).
     */
    deleteWorkspaceTriggers: (id: string): ReadonlyArray<string> =>
      storage.transactionSync(() => {
        const held = activeWorkspaceTriggers(id);

        sql.exec("DELETE FROM triggers WHERE workspace = ?", id);

        return held;
      }),

    /**
     * Delete Workspace `id` as the owner's Remove does (`store.deleteWorkspaceWithTriggers`, which deletes the Triggers
     * kept for it in the same transaction) and answer the ids of the active Triggers that went with it, whose objects
     * the caller wipes (`docs/architecture/triggers.md` → Cascades).
     */
    deleteWorkspaceWithTriggers: (id: string): WorkspaceRemoval =>
      storage.transactionSync((): WorkspaceRemoval => {
        const held = activeWorkspaceTriggers(id);
        const deletion = store.deleteWorkspaceWithTriggers(id);

        return { deletion, triggers: deletion === "deleted" ? held : [] };
      }),

    /**
     * Delete Session `id` (`store.deleteSession`) with its Session triggers, in the same transaction, and answer their
     * ids, whose objects the caller wipes (`docs/architecture/triggers.md` → Cascades), as an Environment's deletion
     * does.
     */
    deleteSession: (id: string): SessionRemoval =>
      storage.transactionSync((): SessionRemoval => {
        const held = deleteOfSession(id);

        return { deleted: store.deleteSession(id), triggers: held };
      }),

    /**
     * Delete the Session triggers of Session `id`, which stays, and answer their ids, whose objects the caller wipes:
     * the first step of a Session's deletion, so no Fire reaches a Session whose object is about to be wiped.
     */
    deleteOfSession,

    /**
     * Delete Environment `id` (`store.deleteEnvironment`, which deletes its Triggers in the same transaction) and answer
     * the ids of the Triggers that went with it (`docs/architecture/triggers.md` → Cascades).
     */
    deleteEnvironment: (id: string, now?: number): EnvironmentRemoval =>
      storage.transactionSync((): EnvironmentRemoval => {
        const held = Arr.map(
          sql.exec<{ id: string }>("SELECT id FROM triggers WHERE environment = ?", id).toArray(),
          (found) => found.id,
        );

        const deletion = store.deleteEnvironment(id, now);

        return { deletion, triggers: deletion === "deleted" ? held : [] };
      }),
  };
};

/** The Registry's Triggers. */
export type Triggers = ReturnType<typeof openTriggers>;

/** A Workspace's deletion by the owner's Remove, with the ids of the Triggers that went with it, whose objects the caller wipes. */
export type WorkspaceRemoval = {
  readonly deletion: Deletion;
  readonly triggers: ReadonlyArray<string>;
};

/** A Session's deletion, with the ids of the Session triggers that went with it, whose objects the caller wipes. */
export type SessionRemoval = {
  readonly deleted: boolean;
  readonly triggers: ReadonlyArray<string>;
};

/** An Environment's deletion, with the ids of the Triggers that went with it, whose objects the caller wipes. */
export type EnvironmentRemoval = {
  readonly deletion: EnvironmentDeletion;
  readonly triggers: ReadonlyArray<string>;
};
