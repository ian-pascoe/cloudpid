// The `request_id` of a change made over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Retries: `request_id`,
// #685 D9, L8, L17, L18), kept in `change_requests` (migration 37) for 24 h. The first write of a call **claims** its id
// in the transaction that records the change, so "claimed" always means "applied"; the final answer is **settled** after,
// checked against the claim's attempt, and a repeat's **lookup** answers the row with the changes it recorded, from which
// a call cut before its settle is answered. Synchronous over the Registry DO's SQLite, as the Agent changes are.
// @effect-diagnostics missingPipeableSignature:off
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentChange } from "@cloudpid/protocol";
import type { AgentChanges } from "./agent-changes.ts";
import { scopeNameOf } from "./scope-names.ts";
import type { RegistryStorage, RegistryStore } from "./store.ts";

/** How long a `request_id` is remembered. */
export const CHANGE_REQUEST_MEMORY_MS = 24 * 60 * 60 * 1000;

/** The most an answer kept for a repeat may take, as JSON in UTF-8: a larger one is not kept (the repeat is answered from the changes). */
export const MAX_CHANGE_ANSWER_BYTES = 64 * 1024;

/**
 * What a write claims a `request_id` with: the tool, a digest of its arguments (a repeat with other arguments is not the
 * same call), and the attempt that holds the claim. Only the attempt that claimed an id may write under it or settle it.
 */
export type ChangeClaim = {
  readonly id: string;
  readonly tool: string;
  readonly digest: string;
  readonly attempt: string;
};

/** The final answer of a call, as it is kept and replayed: its text and its structured output. */
export const ChangeAnswer = Schema.Struct({
  text: Schema.String,
  structured: Schema.Json,
});

export type ChangeAnswer = typeof ChangeAnswer.Type;

/** What a repeat of a `request_id` finds. */
export type ChangeRequest = {
  readonly tool: string;
  readonly digest: string;
  readonly attempt: string;
  readonly at: number;
  /** The answer settled for it; null while the call has not settled, and when its answer was over the cap. */
  readonly answer: ChangeAnswer | null;
  /** The Agent changes its write recorded (the ones the Registry still keeps), oldest first, with their Scopes' names. */
  readonly changes: ReadonlyArray<{
    readonly id: number;
    readonly scope: string;
    readonly scopeName: string;
    readonly field: string;
    readonly before: Schema.Json | null;
    readonly after: Schema.Json | null;
  }>;
};

/** A claim's attempt is not the one that holds the id: another call has it. The write that met it is rolled back. */
export class ChangeRequestConflict extends Schema.TaggedError<
  ChangeRequestConflict,
  { readonly brand: unique symbol }
>()("ChangeRequestConflict", { id: Schema.String, message: Schema.String }) {}

type Sql = RegistryStorage["sql"];

type ChangeRequestRow = {
  tool: string;
  digest: string;
  attempt: string;
  at: number;
  answer: string | null;
  changes: string;
};

const encoder = new TextEncoder();

/** Drop the claims past the memory, as the lookup and the next claim find them. */
const prune = (sql: Sql, now: number): void => {
  sql.exec("DELETE FROM change_requests WHERE at <= ?", now - CHANGE_REQUEST_MEMORY_MS);
};

/**
 * Claim `claim.id` for the write that records Agent change `changeId` at `at`, or add the change to the claim the same
 * attempt holds. Throws `ChangeRequestConflict` when another attempt (or other arguments) hold the id, which rolls the
 * transaction it is called in back whole.
 */
export const claimChangeRequest = (
  sql: Sql,
  claim: ChangeClaim,
  changeId: number,
  at: number,
): void => {
  prune(sql, at);

  const [row] = sql
    .exec<{ id: string }>(
      `INSERT INTO change_requests (id, tool, digest, attempt, at, answer, changes)
       VALUES (?, ?, ?, ?, ?, NULL, json_array(?))
       ON CONFLICT (id) DO UPDATE SET changes = json_insert(change_requests.changes, '$[#]', ?)
       WHERE change_requests.attempt = excluded.attempt AND change_requests.digest = excluded.digest
       RETURNING id`,
      claim.id,
      claim.tool,
      claim.digest,
      claim.attempt,
      at,
      changeId,
      changeId,
    )
    .toArray();

  if (row === undefined) {
    throw ChangeRequestConflict.make({
      id: claim.id,
      message: `The request_id ${JSON.stringify(claim.id)} is held by another call`,
    });
  }
};

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(ChangeAnswer));

const decodeIds = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Finite)));

/** The `request_id` claims the Registry keeps, over its storage once it is migrated. */
export type ChangeRequests = {
  /**
   * The claim of `id`, or null when there is none or it is past the memory (which drops the expired ones). Its changes
   * are those the Registry still keeps: a change pruned from a full scope is not listed.
   */
  readonly lookup: (id: string, now: number) => ChangeRequest | null;
  /**
   * Keep `answer` as the final answer of the call that claimed `id` as `attempt`, once: the first settle stays. Says
   * whether the claim is that attempt's still (it is not when it expired or another attempt holds the id). An answer over
   * `MAX_CHANGE_ANSWER_BYTES` is not kept, and the claim stays as it was, for a repeat to be answered from its changes.
   */
  readonly settle: (input: {
    readonly id: string;
    readonly attempt: string;
    readonly answer: ChangeAnswer;
  }) => boolean;
};

export const openChangeRequests = (
  { sql }: Pick<RegistryStorage, "sql">,
  store: Pick<RegistryStore, "getEnvironment">,
  changes: Pick<AgentChanges, "byIds">,
): ChangeRequests => ({
  lookup: (id, now) => {
    prune(sql, now);

    const [row] = sql
      .exec<ChangeRequestRow>(
        "SELECT tool, digest, attempt, at, answer, changes FROM change_requests WHERE id = ?",
        id,
      )
      .toArray();

    if (row === undefined) return null;

    const recorded: ReadonlyArray<AgentChange> = changes.byIds(
      Option.getOrElse(decodeIds(row.changes), () => []),
    );

    const scopeName = scopeNameOf(store);

    return {
      tool: row.tool,
      digest: row.digest,
      attempt: row.attempt,
      at: row.at,
      answer: row.answer === null ? null : Option.getOrNull(decodeAnswer(row.answer)),
      changes: Arr.map(recorded, ({ id: changeId, scope, field, before, after }) => ({
        id: changeId,
        scope,
        scopeName: scopeName(scope),
        field,
        before,
        after,
      })),
    };
  },
  settle: ({ id, attempt, answer }) => {
    const [row] = sql
      .exec<{ attempt: string; answer: string | null }>(
        "SELECT attempt, answer FROM change_requests WHERE id = ?",
        id,
      )
      .toArray();

    if (row === undefined || row.attempt !== attempt) return false;

    if (row.answer !== null) return true;

    const text = JSON.stringify(answer);

    if (encoder.encode(text).length <= MAX_CHANGE_ANSWER_BYTES) {
      sql.exec(
        "UPDATE change_requests SET answer = ? WHERE id = ? AND attempt = ? AND answer IS NULL",
        text,
        id,
        attempt,
      );
    }

    return true;
  },
});
