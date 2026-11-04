// The steps every request to one of the Environment's MCP servers shares (`docs/architecture/mcp-connections.md` → RPC,
// The engine → Load caps): which server a request is for and whether it may be sent, where it goes and with what access,
// and one request through the engine with what the host does with its answer. `request.ts` makes a `tools/call` and a
// `ui/html` of them, and `app-reads.ts` the read of an App's HTML.
//
// A request takes a request slot on its server (8) and on the host (32), then a slot of the engine queue as a call (the
// read of an App's HTML a call starts, as background work), served before background work (`limits.ts`). The wait for a slot counts toward the request's timeout: one still
// waiting when its timeout passes is answered `Cut` that did not run, never sent, and one sent gives the engine what is
// left of it. The caller's abort ends a wait at once; once sent, the engine cuts the server request itself. Its target is
// a discovery's (`targetOf`): the `${NAME}` values resolved, and the Secret ones listed for the engine to scrub
// (`redact`). A server with a sign-in gets its token through the engine's `auth(stale)` hook, and what it answered is
// reported to the Registry as a discovery's is (`requestAccess`, in `discovery-auth.ts`); with no token to call with, the
// request is not sent. The logs the server sent come back in the result, and are kept as a discovery's are (`recordLogs`).
// @effect-diagnostics missingPipeableSignature:off missedPipeableOpportunity:off -- steps of the host's methods, not combinators.
import { normalizeMcpName, signsInOnItsOwn } from "@cloudpid/config";
import {
  Cut,
  McpHostCallFailed,
  type McpEngineHooks,
  type McpEngineRequest,
  type McpEngineRequestResult,
  type McpHostRequest,
  type McpEngineTarget,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  isMcpHostTaskRequest,
  NotAllowed,
  ServerChanged,
  SignInRequired,
  StepUpRequired,
  Unreachable,
  UnknownServer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";
import { type RequestAccess, requestAccess } from "./discovery-auth.ts";
import {
  attemptOrHalt,
  halt,
  isWorkspaceGone,
  targetOf,
  type McpDiscoveryServices,
} from "./discovery.ts";
import { deprecationHook } from "./deprecation-notes.ts";
import { McpEngineClient } from "./engine.ts";
import { type EngineCallKind, McpLoadCaps } from "./limits.ts";
import { recordLogs } from "./logs.ts";
import { type ServerView, viewServers } from "./server-state.ts";
import { processEnded } from "./stdio.ts";
import { McpHostStore, type StoredServer } from "./store.ts";
import { viewHash, viewSourceOf } from "../view-hash.ts";

/** The engine's `tools/call` request. */
type McpEngineToolCall = Extract<McpEngineRequest, { readonly op: "tools/call" }>;

export const callFailed = (error: McpHostCallFailed["error"]) => McpHostCallFailed.make({ error });

/** A server's `timeout` when its entry has none (`targetOf` always sets one). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Pending until the caller aborts; never, for a caller with no `untilAborted`. A caller that died rejects it, which
 * ends the wait as an abort does.
 */
export const abortOf = (hooks: McpHostRequestHooks) =>
  hooks.untilAborted === undefined
    ? Effect.never
    : Effect.tryPromise(() => hooks.untilAborted?.() ?? Promise.resolve()).pipe(Effect.ignore);

/**
 * The hash of `server`'s App sandbox origin (`viewHash`), when the host knows its Environment and the server's source:
 * what an App record pins, and what an `app` request names (`ctx.viewHash`).
 */
export const viewHashOf = (
  environment: string | undefined,
  server: StoredServer,
): string | undefined => {
  const source = viewSourceOf(server.source);

  return environment === undefined || source === undefined
    ? undefined
    : viewHash({ environment, source, normalizedName: normalizeMcpName(server.name) });
};

/** What a request to a server of the set is sent through: the Environment, the server's view, the Workspace it runs in, if any, and all views. */
export type Resolved = {
  readonly environment: string;
  readonly view: ServerView;
  readonly views: ReadonlyArray<ServerView>;
  readonly workspace: string | undefined;
};

/** What a failed step answers: the request's own answer, so the caller returns it as it is. */
export type Refused = McpHostRequestResult;

/** The server `name` of the held set, with all the views. */
export const serverOf = (
  name: string,
): Effect.Effect<
  Option.Option<{ readonly view: ServerView; readonly views: ReadonlyArray<ServerView> }>,
  never,
  McpHostStore
> =>
  Effect.map(viewServers, (views) =>
    Option.map(
      Arr.findFirst(views, (each) => each.server.name === name),
      (view) => ({ view, views }),
    ),
  );

/**
 * The server `name` of the held set, if it may be called: not unknown, not switched off or `hidden`, with a Workspace
 * to run in if it is stdio, and not waiting for a sign-in.
 */
export const resolve = (
  environment: string | undefined,
  name: string,
  ctx: McpHostRequestContext,
  call?: McpHostRequest,
): Effect.Effect<Result.Result<Resolved, Refused>, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    if (environment === undefined) {
      return Result.fail(NotAllowed.make({ message: "The MCP host's name is unknown" }));
    }

    const named = yield* serverOf(name);

    if (Option.isNone(named)) {
      return Result.fail(
        UnknownServer.make({ message: `No MCP server ${name} in this Environment` }),
      );
    }

    const { view, views } = named.value;
    const { server, reach, state } = view;
    const task = call !== undefined && isMcpHostTaskRequest(call) ? call : undefined;

    // A task is the server's under the `conn` it was started on, and a question the server's under the one it was asked
    // on: another one is another server, and nothing is sent (`mcp-server-requests.md` → How a wait ends).
    const asked =
      task !== undefined
        ? { conn: task.params.conn, since: "the task was started" }
        : call?.op === "resume" || call?.op === "resend"
          ? { conn: call.params.conn, since: "it asked" }
          : undefined;

    if (asked !== undefined && asked.conn !== server.conn) {
      return Result.fail(
        ServerChanged.make({
          message: `MCP server ${name} changed since ${asked.since}`,
          conn: server.conn,
          identity: server.identity,
        }),
      );
    }

    // An App View's request names the origin hash of the server it was made on (its record's): a server of that name
    // whose own is another has shadowed it since, and the View is not its to call (`mcp-apps.md` → An App View's calls).
    if (ctx.origin === "app" && ctx.viewHash !== undefined) {
      const current = viewHashOf(environment, server);

      if (current !== undefined && current !== ctx.viewHash) {
        return Result.fail(
          ServerChanged.make({
            message: `MCP server ${name} is not the one this App was made for`,
            conn: server.conn,
            identity: server.identity,
          }),
        );
      }
    }

    // A cancel is allowed for a server switched off since: the task it started should not outlive the switch.
    if (reach === "off" && call?.op !== "tasks/cancel") {
      return Result.fail(
        NotAllowed.make({ message: `MCP server ${name} is switched off or hidden` }),
      );
    }

    // A stdio server runs in the Workspace of the caller: with none named, there is no Container to call it in.
    const workspace = reach === "stdio" ? (ctx.workspace ?? "") : undefined;

    if (workspace === "") {
      return Result.fail(
        NotAllowed.make({
          message: `MCP server ${name} runs in a Workspace, and the call named none`,
        }),
      );
    }

    // A server that wants a sign-in is not sent the call: the owner signs in first.
    // (A server that signs in on its own has no such state to wait in: the Registry is asked below.)
    if ((state === "sign_in" || state === "rejected") && !signsInOnItsOwn(server.server)) {
      return Result.fail(
        callFailed(
          SignInRequired.make({
            message: `MCP server ${name} needs you signed in`,
            rejected: state === "rejected",
          }),
        ),
      );
    }

    return Result.succeed({ environment, view, views, workspace });
  });

/** Where a request goes and with what access: the server's target, and the token hook and reports of its sign-in. */
export type Reached = {
  readonly target: McpEngineTarget;
  readonly access: Extract<RequestAccess, { readonly kind: "open" }>;
};

/**
 * The error of a call that is not sent for want of a token. Only a sign-in the owner could give is worded as one: a
 * `step_up` (with the scope the Registry names), a sign-in at `sign_in` or `rejected`, and one that cannot be used for now
 * (`signIn`). A server that signs in on its own sets none of them, so its error carries no `sign_in` hint.
 */
const blockedError = (
  server: string,
  access: Extract<RequestAccess, { readonly kind: "blocked" }>,
): McpHostCallFailed["error"] => {
  if (access.stepUp !== undefined) {
    const stepUp: Mutable<ConstructorParameters<typeof StepUpRequired>[0]> = {
      message: `MCP server ${server} needs you signed in: ${access.message}`,
    };

    if (access.stepUp.scope !== undefined) stepUp.scope = access.stepUp.scope;

    return StepUpRequired.make(stepUp);
  }

  if (access.state === "sign_in" || access.state === "rejected") {
    return SignInRequired.make({
      message: `MCP server ${server} needs you signed in: ${access.message}`,
      rejected: access.state === "rejected",
    });
  }

  // A sign-in that cannot be used for now: a Session says "try again shortly", not "ask the owner".
  return access.userSignIn === true
    ? Unreachable.make({ message: access.message, signIn: true })
    : Unreachable.make({ message: access.message });
};

/** `resolved`'s server's target and access, or why a request is not sent to it. */
export const reachServer = (
  resolved: Resolved,
  options: { readonly start?: boolean } = {},
): Effect.Effect<Result.Result<Reached, Refused>, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const { environment, view, workspace } = resolved;
    const { server } = view;
    const target = yield* targetOf(environment, server, workspace, options.start ?? true);

    if (Result.isFailure(target)) {
      return Result.fail(callFailed(Unreachable.make({ message: target.failure.message })));
    }

    // A stdio server has no sign-in: its call is made as it is.
    const access: RequestAccess =
      target.success.kind === "stdio"
        ? { kind: "open", answered: () => Effect.void }
        : yield* requestAccess(environment, view, target.success);

    // No token to call with: not sent, as a discovery would not connect.
    if (access.kind === "blocked") {
      return Result.fail(callFailed(blockedError(server.name, access)));
    }

    return Result.succeed({ target: target.success, access });
  });

/** The request's context as the engine takes it. */
export const callContextOf = (ctx: McpHostRequestContext): McpEngineToolCall["ctx"] => {
  const callCtx: Mutable<McpEngineToolCall["ctx"]> = { origin: ctx.origin };

  if (ctx.conversation !== undefined) callCtx.conversation = ctx.conversation;

  if (ctx.workspace !== undefined) callCtx.workspace = ctx.workspace;

  return callCtx;
};

/** One request to the engine: where it goes, what it is, the caller's hooks, and whether the server may run it. */
export type EngineSend = {
  readonly resolved: Resolved;
  readonly reached: Reached;
  readonly request: McpEngineRequest;
  readonly hooks: McpHostRequestHooks;
  /** Whether the server may have run what was sent once it was: a `tools/call`, not a read. */
  readonly mayHaveRun: boolean;
  /** Which engine queue serves it (`limits.ts`): a `call`, the default, or `background` work that waits for calls. */
  readonly priority?: EngineCallKind;
  /** The request's timeout in place of the server's (`MCP_TASK_TIMEOUT_MS` for a task's). */
  readonly timeoutMs?: number | undefined;
  /** What a message calls the request: "The call" when absent. */
  readonly what?: string | undefined;
};

/** What the engine answered that is no failure, and the MCP sign-in id of the token it was made with, if it had one. */
export type EngineAnswered = {
  readonly result: Exclude<McpEngineRequestResult, { readonly kind: "failed" }>;
  readonly signIn: string | undefined;
};

/**
 * One request to the engine, from the caller's `hooks`, through the server's cap, the host's and the engine queue, and
 * what the host does with its answer: its rows kept, the end of a stdio child told, the server's sign-in answer and logs
 * recorded. `mayHaveRun` is whether the server may have run what was sent once it was (a `tools/call`, not a read). The
 * request's completed answer, or the failure it answers as.
 */
export const sendToEngine = (
  send: EngineSend,
): Effect.Effect<Result.Result<EngineAnswered, McpHostCallFailed>, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const {
      resolved,
      reached,
      request: sending,
      hooks,
      mayHaveRun,
      priority = "call",
      what = "The call",
    } = send;

    const { view, workspace } = resolved;
    const { server } = view;
    const { target, access } = reached;

    const store = yield* McpHostStore;
    const engine = yield* McpEngineClient;
    const caps = yield* McpLoadCaps;

    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const { auth } = access;

    // The server's first Sampling request, on whatever path it comes (a call's stream, the standalone one, one refused for
    // want of a conversation), is noted on its status and logged, once per server per host lifetime (SEP-2577 deprecates
    // sampling: `mcp-server-requests.md` → Sampling requests, Deprecation). An engine from before never calls the hook.
    const noting: Pick<McpEngineHooks, "onDeprecated"> = {
      onDeprecated: deprecationHook(store, server, run),
    };

    const engineHooks: McpEngineHooks =
      auth === undefined
        ? { ...hooks, ...noting }
        : { ...hooks, ...noting, auth: (stale) => run(auth(stale)) };

    /** Whether the engine was given the call: an abort before it was cannot have run anything. */
    let sent = false;

    const timeoutMs = send.timeoutMs ?? target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const queuedAt = yield* Clock.currentTimeMillis;

    const engineCall = Effect.gen(function* () {
      const waited = (yield* Clock.currentTimeMillis) - queuedAt;

      sent = true;

      return yield* engine.request(
        { ...target, timeoutMs: Math.max(1, timeoutMs - waited) },
        store.prior(server.conn, workspace),
        sending,
        engineHooks,
      );
    });

    /** The call's timeout passing while it still waits for a slot; once it is sent, the engine keeps the timeout. */
    const queuedPast = Effect.sleep(timeoutMs).pipe(
      Effect.andThen(
        Effect.suspend(() => (sent ? Effect.never : Effect.succeed("timedOut" as const))),
      ),
    );

    const answer = yield* caps
      .inFlight(server.conn, caps.engineCall(priority, engineCall), workspace)
      .pipe(
        Effect.map((result) => ({ result })),
        Effect.raceFirst(Effect.as(abortOf(hooks), "aborted" as const)),
        Effect.raceFirst(queuedPast),
        Effect.result,
      );

    if (Result.isFailure(answer)) {
      // The engine is out of reach, or its RPC broke mid-call: the server may have run it. The cause is logged, never
      // told the model.
      yield* Effect.logWarning("The MCP engine's end of a call was lost", answer.failure);

      return Result.fail(
        callFailed(
          Cut.make({
            message: "The host's connection to the MCP engine was lost",
            mayHaveRun,
            lost: "engine",
          }),
        ),
      );
    }

    if (answer.success === "timedOut") {
      return Result.fail(
        callFailed(
          Cut.make({
            message: `${what} waited for a free slot past its ${timeoutMs / 1000} s timeout, and was not sent`,
            mayHaveRun: false,
          }),
        ),
      );
    }

    if (answer.success === "aborted") {
      return Result.fail(
        callFailed(
          Cut.make({
            message: sent
              ? `${what} was cancelled; it may or may not have run`
              : `${what} was cancelled before it was sent`,
            mayHaveRun: mayHaveRun && sent,
          }),
        ),
      );
    }

    const { result } = answer.success;
    const now = yield* Clock.currentTimeMillis;

    // The rows the call changed are kept as a discovery's are; a write the storage refuses never fails the result.
    const ended = yield* attemptOrHalt(() =>
      store.applyEngineState(
        server.conn,
        result.state,
        now,
        workspace === undefined ? undefined : { workspace, spawn: result.spawn },
      ),
    );

    // A stdio server spawned again: the child the row named has ended.
    if (workspace !== undefined && ended !== undefined) {
      yield* processEnded(server.conn, workspace, ended);
    }

    // Its Workspace no longer exists (the bridge's `no_workspace`): whatever ran there is gone with it.
    if (workspace !== undefined && isWorkspaceGone(result)) {
      yield* processEnded(server.conn, workspace, undefined);
    }

    // What the server answered of its sign-in, told the Registry on a change; a report never fails the call.
    yield* access.answered(result);

    // What the server said during the call: kept in its ring, `warning` and above also a span event. A write the
    // storage refuses loses the logs, never the result, and stops background work.
    yield* recordLogs(server.conn, result.logs).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The call's MCP server logs were not kept", cause).pipe(
          Effect.andThen(halt),
        ),
      ),
    );

    if (result.kind === "failed") {
      // A client grant's refused token is not a sign-in the agent could ask for: the call is unreachable with why.
      const refusal = access.refusal?.(result);

      return Result.fail(
        callFailed(refusal === undefined ? result.error : Unreachable.make({ message: refusal })),
      );
    }

    return Result.succeed({ result, signIn: access.signIn?.() });
  });
