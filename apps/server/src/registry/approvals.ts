// The Approvals asked over the MCP endpoint, which the Registry keeps (`docs/architecture/mcp-endpoint.md` → Approvals
// with no Session; ADR-0050; #685 D5, L5, L18). A tool that waits for the owner's Approval answers `pending` on the
// endpoint: its request is a row here, which the owner answers on the Settings page and the caller follows with
// `approval_wait`. The rules are this module's:
//
// - **Asking** writes one row, or answers the one there is: the caller's earlier ask under the same `request_id`, or a
//   request for the same change (the same tool, Scope and arguments, the reason and `request_id` left out: `digest`) that
//   still waits with the same `expected` (dedupe). One that waits with another `expected` is withdrawn (`superseded`) by
//   the new one. At most `MAX_PENDING_APPROVALS` per identity (`auth`) wait or are approved and not finished.
// - **Expiry** is lazy: every read and write first marks the requests past their 7 days `expired`, and forgets the ones
//   settled more than 24 h ago.
// - **Answering**: Approve marks the request `approved` (the main Worker then applies it), Decline `declined`. A request
//   no longer waiting is answered as it is.
// - **Applying** is the main Worker's (`../harness/approval-runner.ts`), under a lease here: a run claims the request for
//   60 s, so two runs never apply it at once, and `finish` settles it with the run's outcome, only while its lease holds.
//   The lease rule is `awaitsApply`'s, which `claim` and `stale` say again in SQL.
// - **Withdrawal**: by the caller while it waits, and with its Environment (`withdrawEnvironmentApprovals`, which the
//   store's `deleteEnvironment` runs in its transaction).
//
// Synchronous over the Registry DO's SQLite, as the Agent changes are.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import {
  type AgentChangeVia,
  APPROVAL_LIFETIME_MS,
  APPROVAL_RETENTION_MS,
  ApprovalCardContent,
  ApprovalStatus,
  ApprovalWithdrawal,
  MAX_PENDING_APPROVALS,
  McpAuth,
  type RegistryApproval,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { type ChangeClaim, ChangeAnswer, claimChangeRequestAlone } from "./change-requests.ts";
import type { RegistryStorage } from "./store.ts";

/** How long a run that applies an approved request holds it: a run cut meanwhile lets go when this passes. */
export const APPROVAL_LEASE_MS = 60_000;

/** The most `approval_wait`s one caller (`auth`) holds at once (`too_many_waits`): each keeps the Registry busy re-reading. */
export const MAX_APPROVAL_WAITS = 8;

/** How often a wait re-reads its request. */
export const APPROVAL_WAIT_POLL_MS = 500;

/** A request as the Registry keeps it. */
export type StoredApproval = {
  readonly id: string;
  readonly tool: string;
  /** An Environment's id, or `*` for Global. */
  readonly scope: string;
  /** The Settings page section its card shows in. */
  readonly section: string;
  /** The tool's arguments, as its endpoint schema decoded them. */
  readonly args: Schema.Json;
  readonly card: ApprovalCardContent;
  /** What the target was when the owner was asked (`prepare`'s `expected`): the change is made only while it still is. */
  readonly expected: Schema.Json | null;
  /** The dedupe digest: the tool, its Scope and arguments, the reason and `request_id` left out. */
  readonly digest: string;
  /** Whether its apply is long (an Environment's delete): `approval_wait` never runs one. None is, before S3b. */
  readonly long: boolean;
  readonly via: AgentChangeVia;
  readonly requestId: string | null;
  readonly status: ApprovalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly answeredAt: number | null;
  readonly settledAt: number | null;
  readonly leaseUntil: number | null;
  readonly leaseToken: string | null;
  /** Why it ended as it did: the owner's reason for a Decline, what the target is now, or the Registry's refusal. */
  readonly reason: string | null;
  readonly withdrawal: ApprovalWithdrawal | null;
  /** The applied change's answer, for `finished`. */
  readonly result: ChangeAnswer | null;
};

/**
 * The lease rule: an approved request awaits its apply at `now` when no run holds it (none started, or the lease of the
 * one that did lapsed); otherwise a run is applying it. `claim` takes, `stale` lists and the Settings page shows by it.
 */
export const awaitsApply = (approval: StoredApproval, now: number): boolean =>
  approval.status === "approved" && (approval.leaseUntil === null || approval.leaseUntil <= now);

/** What a tool asks to be approved. */
export type ApprovalAsk = {
  readonly tool: string;
  readonly scope: string;
  readonly section: string;
  readonly args: Schema.Json;
  readonly card: ApprovalCardContent;
  readonly expected: Schema.Json | null;
  readonly digest: string;
  readonly long?: boolean | undefined;
  readonly via: AgentChangeVia;
  /** The caller's `request_id`, and its claim in `change_requests`, written in the same transaction. */
  readonly request?: ChangeClaim | undefined;
};

/** How an ask went. */
export type ApprovalAsked =
  /** A request waits: a new one (`fresh`: tell the owner), or one there was already. */
  | { readonly status: "asked"; readonly approval: StoredApproval; readonly fresh: boolean }
  /** The caller has as many requests waiting or applying as it may. */
  | { readonly status: "too_many"; readonly limit: number }
  /** The ask was refused: an argument holds a kept Secret, or the Secrets changed while it was checked. */
  | { readonly status: "refused"; readonly message: string };

/** How a run's claim of a request went: whether it holds the lease now. */
export type ApprovalClaim = { readonly approval: StoredApproval; readonly leased: boolean };

/** The statuses a run settles an approved request with. */
export type ApprovalEnd = "finished" | "changed_since" | "refused";

type ApprovalRow = {
  id: string;
  tool: string;
  scope: string;
  section: string;
  args: string;
  card: string;
  expected: string;
  digest: string;
  long: number;
  via_auth: string;
  via_client_name: string | null;
  via_client_version: string | null;
  via_client_id: string | null;
  request_id: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  answered_at: number | null;
  settled_at: number | null;
  lease_until: number | null;
  lease_token: string | null;
  reason: string | null;
  withdrawal: string | null;
  result: string | null;
};

type Sql = RegistryStorage["sql"];

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(ApprovalCardContent));

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(ChangeAnswer));

// @effect-diagnostics-next-line schemaSync:off -- the store is synchronous; both take any text.
const decodeAuth = Schema.decodeUnknownSync(McpAuth);

// @effect-diagnostics-next-line schemaSync:off -- as above.
const decodeWithdrawal = Schema.decodeUnknownSync(ApprovalWithdrawal);

// @effect-diagnostics-next-line schemaSync:off -- as above: a status a later build wrote that this one does not know reads as `unknown`.
const statusOf = Schema.decodeUnknownSync(ApprovalStatus);

const toApproval = (row: ApprovalRow): StoredApproval => {
  const via: Types.Mutable<AgentChangeVia> = { auth: decodeAuth(row.via_auth) };

  if (row.via_client_name !== null) {
    via.client =
      row.via_client_version === null
        ? { name: row.via_client_name }
        : { name: row.via_client_name, version: row.via_client_version };
  }

  if (row.via_client_id !== null) via.clientId = row.via_client_id;

  return {
    id: row.id,
    tool: row.tool,
    scope: row.scope,
    section: row.section,
    args: Option.getOrElse(decodeJson(row.args), () => ({})),
    card: Option.getOrElse(decodeCard(row.card), () => ({
      tool: row.tool,
      target: row.scope,
      change: row.tool,
      before: "",
      after: "",
      reason: "",
    })),
    expected: Option.getOrNull(decodeJson(row.expected)),
    digest: row.digest,
    long: row.long === 1,
    via,
    requestId: row.request_id,
    status: statusOf(row.status),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
    settledAt: row.settled_at,
    leaseUntil: row.lease_until,
    leaseToken: row.lease_token,
    reason: row.reason,
    withdrawal: row.withdrawal === null ? null : decodeWithdrawal(row.withdrawal),
    result: row.result === null ? null : Option.getOrNull(decodeResult(row.result)),
  };
};

/** A request as the Settings page shows it at `now`: never the client's id. */
export const shownApproval = (approval: StoredApproval, now: number): RegistryApproval => {
  const shown: Types.Mutable<RegistryApproval> = {
    id: approval.id,
    scope: approval.scope,
    section: approval.section,
    card: approval.card,
    via:
      approval.via.client === undefined
        ? { auth: approval.via.auth }
        : { auth: approval.via.auth, client: approval.via.client },
    status: approval.status,
    applying: approval.status === "approved" && !awaitsApply(approval, now),
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };

  if (approval.reason !== null) shown.reason = approval.reason;

  if (approval.withdrawal !== null) shown.withdrawal = approval.withdrawal;

  if (approval.result !== null) shown.text = approval.result.text;

  return shown;
};

/**
 * Withdraw Environment `environment`'s requests still waiting (`environment_deleted`), in the transaction that deletes it:
 * no Approve can apply them now. An approved one being applied finds its Environment gone and is refused. With no
 * `now` (a caller with no clock of its own), SQLite's.
 */
export const withdrawEnvironmentApprovals = (
  sql: Sql,
  environment: string,
  now: number | undefined,
): void => {
  sql.exec(
    `UPDATE approval_requests SET status = 'withdrawn', withdrawal = 'environment_deleted',
       settled_at = COALESCE(?, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
     WHERE scope = ? AND status = 'pending'`,
    now ?? null,
    environment,
  );
};

/** The Approvals the Registry keeps, over its storage once it is migrated. */
export const openApprovals = (storage: Pick<RegistryStorage, "sql" | "transactionSync">) => {
  const { sql } = storage;

  /** Expire the requests past their days, and forget the ones settled more than a day before `now`. */
  const sweep = (now: number): void => {
    sql.exec(
      `UPDATE approval_requests SET status = 'expired', settled_at = expires_at
       WHERE status = 'pending' AND expires_at <= ?`,
      now,
    );
    sql.exec("DELETE FROM approval_requests WHERE settled_at <= ?", now - APPROVAL_RETENTION_MS);
  };

  const row = (id: string): StoredApproval | null => {
    const [found] = sql
      .exec<ApprovalRow>("SELECT * FROM approval_requests WHERE id = ?", id)
      .toArray();

    return found === undefined ? null : toApproval(found);
  };

  const get = (id: string, now: number): StoredApproval | null => {
    sweep(now);

    return row(id);
  };

  /** How many requests the caller `auth` has waiting or approved and not finished, but those `except` leaves out. */
  const held = (auth: string, except: ReadonlyArray<string>): number =>
    Arr.filter(
      sql
        .exec<{
          id: string;
        }>(
          "SELECT id FROM approval_requests WHERE via_auth = ? AND status IN ('pending', 'approved')",
          auth,
        )
        .toArray(),
      ({ id }) => !except.includes(id),
    ).length;

  return {
    get,

    /** Every request kept, oldest first; only Scope `scope`'s when one is named. */
    list: (now: number, scope?: string): ReadonlyArray<StoredApproval> => {
      sweep(now);

      const rows =
        scope === undefined
          ? sql.exec<ApprovalRow>("SELECT * FROM approval_requests ORDER BY created_at, id")
          : sql.exec<ApprovalRow>(
              "SELECT * FROM approval_requests WHERE scope = ? ORDER BY created_at, id",
              scope,
            );

      return Arr.map(rows.toArray(), toApproval);
    },

    /**
     * Ask for `ask` under the new id `id` (see the module's rules): the caller's earlier ask of the same `request_id` and
     * arguments, or the same change waiting with the same `expected`, answers that request; another `expected`
     * supersedes it. The `request_id` is claimed in the same transaction, so a repeat finds it.
     */
    ask: (ask: ApprovalAsk, id: string, now: number): ApprovalAsked =>
      storage.transactionSync((): ApprovalAsked => {
        sweep(now);

        if (ask.request !== undefined) {
          const [earlier] = sql
            .exec<ApprovalRow>(
              "SELECT * FROM approval_requests WHERE request_id = ? AND digest = ? ORDER BY created_at DESC LIMIT 1",
              ask.request.id,
              ask.digest,
            )
            .toArray();

          if (earlier !== undefined) {
            return { status: "asked", approval: toApproval(earlier), fresh: false };
          }
        }

        const expected = JSON.stringify(ask.expected);

        const waiting = sql
          .exec<ApprovalRow>(
            "SELECT * FROM approval_requests WHERE digest = ? AND status = 'pending' ORDER BY created_at",
            ask.digest,
          )
          .toArray();

        const same = Arr.findFirst(waiting, (each) => each.expected === expected);

        if (Option.isSome(same)) {
          return { status: "asked", approval: toApproval(same.value), fresh: false };
        }

        const superseded = Arr.map(waiting, (each) => each.id);

        if (held(ask.via.auth, superseded) >= MAX_PENDING_APPROVALS) {
          return { status: "too_many", limit: MAX_PENDING_APPROVALS };
        }

        for (const each of superseded) {
          sql.exec(
            `UPDATE approval_requests SET status = 'withdrawn', withdrawal = 'superseded', settled_at = ?
             WHERE id = ?`,
            now,
            each,
          );
        }

        sql.exec(
          `INSERT INTO approval_requests (id, tool, scope, section, args, card, expected, digest, long, via_auth,
             via_client_name, via_client_version, via_client_id, request_id, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          id,
          ask.tool,
          ask.scope,
          ask.section,
          JSON.stringify(ask.args),
          JSON.stringify(ask.card),
          expected,
          ask.digest,
          ask.long === true ? 1 : 0,
          ask.via.auth,
          ask.via.client?.name ?? null,
          ask.via.client?.version ?? null,
          ask.via.clientId ?? null,
          ask.request?.id ?? null,
          now,
          now + APPROVAL_LIFETIME_MS,
        );

        if (ask.request !== undefined) claimChangeRequestAlone(sql, ask.request, now);

        const asked = row(id);

        if (asked === null) throw new Error(`Approval request ${id} was not kept`);

        return { status: "asked", approval: asked, fresh: true };
      }),

    /**
     * The owner's answer to request `id`: a waiting one becomes `approved` or `declined` (with `reason`); any other is left
     * as it is. Null for a request not kept.
     */
    answer: (
      {
        id,
        approved,
        reason,
      }: { readonly id: string; readonly approved: boolean; readonly reason?: string | undefined },
      now: number,
    ): StoredApproval | null => {
      sweep(now);

      if (approved) {
        sql.exec(
          "UPDATE approval_requests SET status = 'approved', answered_at = ? WHERE id = ? AND status = 'pending'",
          now,
          id,
        );
      } else {
        sql.exec(
          `UPDATE approval_requests SET status = 'declined', answered_at = ?, settled_at = ?, reason = ?
           WHERE id = ? AND status = 'pending'`,
          now,
          now,
          reason ?? null,
          id,
        );
      }

      return row(id);
    },

    /** The caller's withdrawal of request `id`: a waiting one is `withdrawn`; any other is left as it is. Null for none. */
    withdraw: (id: string, now: number): StoredApproval | null => {
      sweep(now);
      sql.exec(
        `UPDATE approval_requests SET status = 'withdrawn', withdrawal = 'withdrawn', settled_at = ?
         WHERE id = ? AND status = 'pending'`,
        now,
        id,
      );

      return row(id);
    },

    /**
     * Claim approved request `id` for the run `token` until `now + APPROVAL_LEASE_MS`: it is the run's when nobody holds
     * it, its lease lapsed, or the run holds it already (a renewal). Null for a request not kept.
     */
    claim: (id: string, token: string, now: number): ApprovalClaim | null => {
      sweep(now);

      const [leased] = sql
        .exec<{ id: string }>(
          `UPDATE approval_requests SET lease_until = ?, lease_token = ?
           WHERE id = ? AND status = 'approved'
             AND (lease_until IS NULL OR lease_until <= ? OR lease_token = ?)
           RETURNING id`,
          now + APPROVAL_LEASE_MS,
          token,
          id,
          now,
          token,
        )
        .toArray();

      const approval = row(id);

      return approval === null ? null : { approval, leased: leased !== undefined };
    },

    /**
     * Settle approved request `id` as `status`, with the applied change's answer or why nothing was changed, for the run
     * that holds its lease: a run whose lease lapsed (another took it) leaves it as it is. Answers the request as it stands.
     */
    finish: (
      {
        id,
        token,
        status,
        reason,
        result,
      }: {
        readonly id: string;
        readonly token: string;
        readonly status: ApprovalEnd;
        readonly reason?: string | undefined;
        readonly result?: ChangeAnswer | undefined;
      },
      now: number,
    ): StoredApproval | null => {
      sql.exec(
        `UPDATE approval_requests SET status = ?, settled_at = ?, reason = ?, result = ?, lease_until = NULL,
           lease_token = NULL
         WHERE id = ? AND status = 'approved' AND lease_token = ?`,
        status,
        now,
        reason ?? null,
        result === undefined ? null : JSON.stringify(result),
        id,
        token,
      );

      return get(id, now);
    },

    /** The approved requests whose apply is not under way (none started, or its lease lapsed): what a resume picks up. */
    stale: (now: number): ReadonlyArray<StoredApproval> => {
      sweep(now);

      return Arr.map(
        sql
          .exec<ApprovalRow>(
            `SELECT * FROM approval_requests WHERE status = 'approved' AND (lease_until IS NULL OR lease_until <= ?)
             ORDER BY answered_at, id`,
            now,
          )
          .toArray(),
        toApproval,
      );
    },
  };
};

export type Approvals = ReturnType<typeof openApprovals>;
