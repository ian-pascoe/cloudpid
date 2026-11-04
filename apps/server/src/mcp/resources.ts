// `McpHost.request` for a server's resources (`docs/architecture/mcp-in-a-session.md` → Resource tools;
// `docs/architecture/mcp-connections.md` → RPC, The list cache): `resources/list` and `resources/templates/list`, one page
// from a cursor, and `resources/read`.
//
// - **Reads and pages go through the engine** with the checks of a call (a server of the set, not switched off or
//   `hidden`, a Workspace to run in if it is stdio, a sign-in to call with) and the caps of any request, but never as a
//   call that may have run: a cut is a read that is sent once more (the core) and no `mayHaveRun`. A read's bound is the
//   page timeout, or the entry's `timeout` when that is lower (30 s). A read passes `ctx.answers` and the caller's
//   `onInput` on to the engine, so a Legacy server's question is the agent's as a tool call's is
//   (`mcp-server-requests.md` → Questions); they are never MCP tasks.
// - **A page of a Modern server is kept** for the `ttlMs` it came with, in the list cache (`./list-cache.ts`), under the
//   server instance, an auth context (a SHA-256 over the URL, the access token and the headers, or for a stdio server the
//   command, its arguments, `env` and `cwd`), the method and the cursor. A Legacy server's page is not kept, whatever it
//   sent; nor is one the engine marked uncacheable, one with no `ttlMs`, or one that came as a stream (over 1 MiB, passed
//   on unread). A read is never kept.
// - **A read answers its SHA-256** (`sha256` of `Completed`): the baseline of a Resource watch (`watches.ts`). With
//   `watch: true` the read subscribes first (the server's listen names its URI) and answers `watch` with whether the
//   watch started; with `watch: false` it ends the conversation's watch first.
// @effect-diagnostics missingPipeableSignature:off missedPipeableOpportunity:off -- steps of the host's methods, not combinators.
import {
  EraRowV1,
  type McpEngineRequest,
  type McpEngineTarget,
  type McpEngineRequestResult,
  McpHostCompleted,
  McpHostPagesRequired,
  McpHostResourceRequest,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
  NotAllowed,
  ProtocolViolation,
} from "@cloudpid/mcp/types";
import { sha256Hex } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpDiscoveryServices } from "./discovery.ts";
import {
  callContextOf,
  callFailed,
  type Reached,
  reachServer,
  resolve,
  type Resolved,
  sendToEngine,
} from "./engine-round.ts";
import { McpListCache } from "./list-cache.ts";
import { McpHostStore } from "./store.ts";
import { SECOND_MS } from "./time.ts";
import type { WatchKey } from "./watch-store.ts";
import { beginWatch, endSessionWatches, settleRead, type WatchBegun } from "./watches.ts";

/** What a resource read or page waits for at most: the core's page timeout, or the entry's `timeout` when it is lower. */
export const RESOURCE_TIMEOUT_MS = 30 * SECOND_MS;

const decodeResourceRequest = Schema.decodeUnknownOption(McpHostResourceRequest);

const decodeEra = Schema.decodeUnknownOption(EraRowV1);

/** `fields` of an object, sorted by key, so the same object always hashes alike. */
const sortedEntries = (fields: Readonly<Record<string, string>> | undefined) =>
  Arr.sort(
    Record.toEntries(fields ?? {}),
    Order.mapInput(Order.String, ([name]: readonly [string, string]) => name),
  );

/**
 * The auth context a page was read under: a SHA-256 over the URL, the access token and the headers (every header
 * resolved from a Secret or Variable, and the entry's own), so a page read with one principal's token is never given to
 * another, and a change of a Secret or a Variable is a new context. A stdio server has no token: its context is what it
 * is run with.
 */
export const authContextOf = (target: McpEngineTarget, token: string | undefined): string =>
  sha256Hex(
    JSON.stringify(
      target.kind === "http"
        ? ["http", target.url, token ?? null, sortedEntries(target.headers)]
        : [
            "stdio",
            target.command,
            target.args ?? [],
            sortedEntries(target.env),
            target.cwd ?? null,
          ],
    ),
  );

/** The era a server's row says it speaks, and the epoch a cached page is good in: its protocol version and probe time. */
const eraOf = (row: Schema.Json | undefined) =>
  Option.getOrUndefined(
    Option.map(decodeEra(row), (era) => ({
      era: era.era,
      epoch: `${era.version}@${era.probedAt}`,
    })),
  );

/** What a list op asks of the engine. */
const pageRequest = (
  op: "resources/list" | "resources/templates/list",
  cursor: string | undefined,
  ctx: McpEngineRequest["ctx"],
): McpEngineRequest => {
  const page = cursor === undefined ? {} : { cursor };

  return op === "resources/list"
    ? { op: "resources/list_page", ...page, ctx }
    : { op: "resources/templates/list_page", ...page, ctx };
};

/** The completed answer of `result` for `op`, or a protocol violation: the engine misread the request. */
const completedOf = (
  op: string,
  result: Exclude<McpEngineRequestResult, { readonly kind: "failed" }>,
): McpHostRequestResult => {
  if (result.kind !== "complete") {
    return callFailed(
      ProtocolViolation.make({ message: `The engine answered ${op} with ${result.kind}` }),
    );
  }

  return result.sha256 === undefined
    ? McpHostCompleted.make({ result: result.result })
    : McpHostCompleted.make({ result: result.result, sha256: result.sha256 });
};

/** The context of the engine's request: where it comes from, and for a read, what the caller can answer. */
const engineContextOf = (ctx: McpHostRequestContext, isRead: boolean): McpEngineRequest["ctx"] => {
  const callCtx: Mutable<McpEngineRequest["ctx"]> = { ...callContextOf(ctx) };

  if (isRead && ctx.answers !== undefined) callCtx.answers = ctx.answers;

  return callCtx;
};

/** One request to the engine for `resolved`'s server, with a resource's timeout. */
const send = (
  resolved: Resolved,
  reached: Reached,
  request: McpEngineRequest,
  hooks: McpHostRequestHooks,
) =>
  sendToEngine({
    resolved,
    reached,
    request,
    hooks,
    mayHaveRun: false,
    timeoutMs: Math.min(reached.target.timeoutMs ?? RESOURCE_TIMEOUT_MS, RESOURCE_TIMEOUT_MS),
    what: "The request",
  });

/**
 * A page of the server's list `op`, from the cache when a Modern server's answer for the same server instance, auth
 * context, method and cursor is still within its `ttlMs`, else from the engine (and kept, when it may be).
 */
const listPage = (
  op: "resources/list" | "resources/templates/list",
  cursor: string | undefined,
  resolved: Resolved,
  reached: Reached,
  ctx: McpHostRequestContext,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const cache = yield* McpListCache;
    const { view, views, workspace } = resolved;
    const { conn } = view.server;
    const server = { conn, workspace };

    // A definition that changed or left the set drops its pages here, as every list passes by.
    cache.retain(new Set(Arr.map(views, (each) => each.server.conn)));

    // The token the engine would send first: the hook may renew one that has expired, as the engine's call would.
    const token = reached.access.auth === undefined ? undefined : yield* reached.access.auth(false);

    const auth = authContextOf(reached.target, token);
    const key = Arr.join([conn, workspace ?? "", auth, op, cursor ?? ""], "\0");
    const before = eraOf(store.prior(conn, workspace).era);
    const now = yield* Clock.currentTimeMillis;

    const hit = before?.era === "modern" ? cache.get(key, before.epoch, now) : undefined;

    if (hit !== undefined) return McpHostCompleted.make({ result: { kind: "inline", value: hit } });

    const sent = yield* send(
      resolved,
      reached,
      pageRequest(op, cursor, engineContextOf(ctx, false)),
      hooks,
    );

    if (Result.isFailure(sent)) return sent.failure;

    const { result } = sent.success;
    const answer = completedOf(op, result);

    if (result.kind !== "complete" || result.result.kind !== "inline") return answer;

    // The engine's call has stored its era row by now: what the server speaks, and what a page is good in.
    const after = eraOf(store.prior(conn, workspace).era);

    if (
      result.cacheable &&
      result.ttlMs !== undefined &&
      after !== undefined &&
      after.era === "modern"
    ) {
      cache.put(
        key,
        server,
        after.epoch,
        result.result.value,
        result.ttlMs,
        yield* Clock.currentTimeMillis,
      );
    }

    return answer;
  });

/**
 * `request` for a resource op: one page of a list, or a read. A server that is not in the set, is switched off or
 * `hidden`, or waits for a sign-in is refused as a call to it would be; the rest is `listPage` and the engine's answer.
 */
export const resourceRequest = (
  environment: string | undefined,
  op: "resources/list" | "resources/templates/list" | "resources/read",
  input: typeof McpHostRequestInput.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const asked = decodeResourceRequest(input);

    if (Option.isNone(asked)) return NotAllowed.make({ message: `The ${op} is malformed` });

    const call = asked.value;
    const { server: name, ctx } = call;
    const resolved = yield* resolve(environment, name, ctx);

    if (Result.isFailure(resolved)) return resolved.failure;

    const reached = yield* reachServer(resolved.success);

    if (Result.isFailure(reached)) return reached.failure;

    if (call.op !== "resources/read") {
      return yield* listPage(
        call.op,
        call.params.cursor,
        resolved.success,
        reached.success,
        ctx,
        hooks,
      );
    }

    const { uri, watch } = call.params;
    const { view, workspace } = resolved.success;
    const { session, conversation } = ctx;

    // The Resource watch this read is for: the conversation's own, on this server and URI.
    const key: WatchKey | undefined =
      session === undefined || conversation === undefined
        ? undefined
        : { session, conversation, server: view.server.name, uri };

    // `watch: false` ends the conversation's watch, with no notice (the agent asked), and still reads.
    if (watch === false && key !== undefined) yield* endSessionWatches(key, "ended", true);

    const begun: WatchBegun | undefined =
      watch !== true
        ? undefined
        : key === undefined
          ? { kind: "refused", reason: "not watched: the read has no conversation to watch for" }
          : yield* beginWatch(resolved.success.environment, key, {
              conn: view.server.conn,
              workspace,
            });

    const sent = yield* send(
      resolved.success,
      reached.success,
      { op: "resources/read", uri, ctx: engineContextOf(ctx, true) },
      hooks,
    );

    // A read that did not complete (a failure, or pages the caller must have first) drops the pending watch it began.
    if (Result.isFailure(sent) || sent.success.result.kind === "pages_required") {
      if (key !== undefined && begun?.kind === "held") {
        yield* settleRead(key, { sha256: undefined, spawn: undefined });
      }

      if (Result.isFailure(sent)) return sent.failure;
    }

    const { result } = sent.success;

    // A Legacy server's `-32042` on a read, kept only for a caller that asked to (`ctx.answers.pages`): its pages, and
    // the read is sent again by the caller as it was.
    if (result.kind === "pages_required") {
      const { server } = resolved.success.view;

      return ctx.answers?.pages === true
        ? McpHostPagesRequired.make({
            requests: result.requests,
            message: result.message,
            conn: server.conn,
            identity: server.identity,
          })
        : callFailed(
            ProtocolViolation.make({ message: `The engine answered ${op} with ${result.kind}` }),
          );
    }

    const answer = completedOf(op, result);

    if (key === undefined || watch === false || result.kind !== "complete") return answer;

    // The contents are the watch's baseline when there is one (a new watch becomes active, an older one's mark clears,
    // since the agent has read what changed).
    const held = yield* settleRead(key, { sha256: result.sha256, spawn: result.spawn });

    if (begun === undefined || !Predicate.isTagged(answer, "Completed")) return answer;

    const reason =
      begun.kind === "refused"
        ? begun.reason
        : result.sha256 === undefined
          ? "not watched: the read did not complete"
          : "not watched: the host could not store the watch";

    return McpHostCompleted.make({
      ...answer,
      watch: begun.kind === "held" && held ? { started: true } : { started: false, reason },
    });
  });
