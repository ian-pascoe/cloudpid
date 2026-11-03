// `McpHost.request` (`docs/architecture/mcp-connections.md` → RPC, The engine → Load caps): a Session's call to one of
// the Environment's MCP servers, sent through `McpEngine` with the caller's hooks. As built (#452, #460), `op: "tools/call"`
// to a server that has an inventory, an HTTP server or a stdio server run in the caller's Workspace (`ctx.workspace`; the
// call may start its Container); any other `op` is `HostUnsupported`.
//
// The call runs inside the caller's invocation, so the caller's `untilAborted` and `onProgress` stubs live as long as
// it does (#409 answer 2), and they go on to the engine as they came. It takes a request slot on its server (8) and on
// the host (32), then a slot of the engine queue as a call, served before background work (`limits.ts`). The wait for
// a slot counts toward the call's timeout: a call still waiting when its timeout passes is answered `Cut` that did not
// run, never sent, and one sent gives the engine what is left of it. The caller's abort ends a wait at once; once sent,
// the engine cuts the server request itself. Its target is a discovery's (`targetOf`): the `${NAME}` values resolved, and
// the Secret ones listed for the engine to scrub (`redact`). A server with a sign-in gets its token through the engine's
// `auth(stale)` hook, and what it answered is reported to the Registry as a discovery's is (`requestAccess`, in
// `discovery-auth.ts`); with no token to call with, the call is not sent. The logs the server sent come back in the
// result, and are kept as a discovery's are (`recordLogs`).
// @effect-diagnostics missingPipeableSignature:off -- the host's method, not a combinator.
import { signsInOnItsOwn } from "@cloudpid/config";
import {
  Cut,
  HostFailed,
  HostUnsupported,
  McpHostCallFailed,
  McpHostCompleted,
  type McpEngineHooks,
  type McpEngineRequest,
  type McpEngineRequestResult,
  McpHostRequest,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  McpToolDefinition,
  NotAllowed,
  ProtocolViolation,
  ServerChanged,
  SignInRequired,
  Unreachable,
  UnknownServer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { type RequestAccess, requestAccess } from "./discovery-auth.ts";
import { halt, isWorkspaceGone, targetOf, type McpDiscoveryServices } from "./discovery.ts";
import { McpEngineClient } from "./engine.ts";
import { McpLoadCaps } from "./limits.ts";
import { recordLogs } from "./logs.ts";
import { viewServers } from "./server-state.ts";
import { processEnded } from "./stdio.ts";
import { McpHostStore } from "./store.ts";

const OpOnly = Schema.Struct({ op: Schema.String });

const decodeOp = Schema.decodeUnknownOption(OpOnly);

const decodeRequest = Schema.decodeUnknownOption(McpHostRequest);

const decodeDefinition = Schema.decodeUnknownOption(McpToolDefinition);

/** The engine's `tools/call` request. */
type McpEngineToolCall = Extract<McpEngineRequest, { readonly op: "tools/call" }>;

/** What a `tasks/*` request is allowed to take: 30 s each (`mcp-connections.md` → Requests and Legacy sessions). */
const TASK_TIMEOUT_MS = 30_000;

/** The origins whose `tools/call` may be offered an MCP task: an agent's and an App View's, never the owner's or the host's. */
const mayWaitForTask = (ctx: McpHostRequestContext) =>
  ctx.allowTask === true && (ctx.origin === "agent" || ctx.origin === "app");

/** 8 hex digits of SHA-256 of `taskId`: what a span says of a task, never its id. */
const taskHash = (taskId: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(taskId))).pipe(
    Effect.map((digest) =>
      Arr.join(
        Arr.map(Arr.take(Arr.fromIterable(new Uint8Array(digest)), 4), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ),
        "",
      ),
    ),
  );

const callFailed = (error: McpHostCallFailed["error"]) => McpHostCallFailed.make({ error });

/** A server's `timeout` when its entry has none (`targetOf` always sets one). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Pending until the caller aborts; never, for a caller with no `untilAborted`. A caller that died rejects it, which
 * ends the wait as an abort does.
 */
const abortOf = (hooks: McpHostRequestHooks) =>
  hooks.untilAborted === undefined
    ? Effect.never
    : Effect.tryPromise(() => hooks.untilAborted?.() ?? Promise.resolve()).pipe(Effect.ignore);

/** What a request is, once decoded: the server it names, who it is for and how it reaches the engine. */
type Decoded = McpHostRequest;

/**
 * `request`: the call `input` asks for, to the server it names, with the caller's `hooks`. Never fails: a server not in
 * the set is `UnknownServer`, one that may not be called (switched off or `hidden`, not discovered, a tool its inventory
 * does not list) is `NotAllowed`, and what the engine or the server failed with is `CallFailed`. Without an
 * Environment the host has no Registry to resolve `${NAME}` values with, and refuses.
 *
 * `tools/call` may be offered an MCP task (`ctx.allowTask`, an agent's or an App View's call to an HTTP server), and
 * `tasks/get`, `tasks/update` and `tasks/cancel` follow one: they carry the task's server and tool and the `conn` it was
 * started on, and answer `ServerChanged` when the name's `conn` is another. The host keeps nothing of a task. A task on a
 * stdio server is `HostUnsupported` until [#494](https://github.com/ian-pascoe/cloudpid/issues/494)
 * (`docs/architecture/mcp-server-requests.md` → MCP tasks).
 */
export const request = (
  environment: string | undefined,
  input: typeof McpHostRequest.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> => {
  const op = Option.getOrUndefined(decodeOp(input))?.op ?? "";

  return run(environment, op, input, hooks).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The MCP host could not read its storage" })),
    ),
    Effect.withSpan("mcp.request", { attributes: { op } }),
  );
};

const isTaskOp = (call: Decoded) => call.op !== "tools/call";

const run = (
  environment: string | undefined,
  op: string,
  input: typeof McpHostRequest.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    if (
      op !== "tools/call" &&
      op !== "tasks/get" &&
      op !== "tasks/update" &&
      op !== "tasks/cancel"
    ) {
      return HostUnsupported.make({ message: `This host does not know the request ${op}`, op });
    }

    const decoded = decodeRequest(input);

    if (Option.isNone(decoded)) return NotAllowed.make({ message: `The ${op} is malformed` });

    const call = decoded.value;
    const { server: name, ctx } = call;

    if (environment === undefined) {
      return NotAllowed.make({ message: "The MCP host's name is unknown" });
    }

    const view = Arr.findFirst(yield* viewServers, (each) => each.server.name === name);

    if (Option.isNone(view)) {
      return UnknownServer.make({ message: `No MCP server ${name} in this Environment` });
    }

    const { server, reach, inventory, state } = view.value;

    // A task is the server's under the `conn` it was started on: another one is another server.
    if (call.op !== "tools/call" && call.params.conn !== server.conn) {
      return ServerChanged.make({
        message: `MCP server ${name} changed since the task was started`,
        conn: server.conn,
        identity: server.identity,
      });
    }

    // A cancel is allowed for a server switched off since: the task it started should not outlive the switch.
    if (reach === "off" && call.op !== "tasks/cancel") {
      return NotAllowed.make({ message: `MCP server ${name} is switched off or hidden` });
    }

    // MCP tasks do not run on stdio servers yet (#494); a stdio call is made as it always was.
    if (reach === "stdio" && isTaskOp(call)) {
      return HostUnsupported.make({
        message: `MCP server ${name} runs in a Workspace; MCP tasks on stdio servers are not supported yet`,
        op,
      });
    }

    // A stdio server runs in the Workspace of the caller: with none named, there is no Container to call it in.
    const workspace = reach === "stdio" ? (ctx.workspace ?? "") : undefined;

    if (workspace === "") {
      return NotAllowed.make({
        message: `MCP server ${name} runs in a Workspace, and the call named none`,
      });
    }

    // A server that wants a sign-in is not sent the call: the owner signs in first.
    // (A server that signs in on its own has no such state to wait in: the Registry is asked below.)
    if ((state === "sign_in" || state === "rejected") && !signsInOnItsOwn(server.server)) {
      return callFailed(
        SignInRequired.make({
          message: `MCP server ${name} needs you signed in`,
          rejected: state === "rejected",
        }),
      );
    }

    const heldTool = (toolName: string) =>
      Option.flatMap(inventory, (held) =>
        Option.flatMap(
          Arr.findFirst(held.tools, (each) => each["name"] === toolName),
          decodeDefinition,
        ),
      );

    // A call names a tool the inventory lists; a task's tool, which only checks a completed result, may have gone.
    const tool = heldTool(call.op === "tools/call" ? call.params.name : call.params.tool);

    if (call.op === "tools/call" && Option.isNone(tool)) {
      return NotAllowed.make({ message: `MCP server ${name} lists no tool ${call.params.name}` });
    }

    const store = yield* McpHostStore;
    const engine = yield* McpEngineClient;
    const caps = yield* McpLoadCaps;
    const target = yield* targetOf(environment, server, workspace);

    if (Result.isFailure(target)) {
      return callFailed(Unreachable.make({ message: target.failure.message }));
    }

    // A stdio server has no sign-in: its call is made as it is.
    const access: RequestAccess =
      target.success.kind === "stdio"
        ? { kind: "open", answered: () => Effect.void }
        : yield* requestAccess(environment, view.value, target.success);

    // No token to call with: not sent, as a discovery would not connect.
    if (access.kind === "blocked") {
      return callFailed(
        access.state === "sign_in" || access.state === "rejected"
          ? SignInRequired.make({
              message: `MCP server ${name} needs you signed in: ${access.message}`,
              rejected: access.state === "rejected",
            })
          : Unreachable.make({ message: access.message }),
      );
    }

    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const { auth } = access;

    const engineHooks: McpEngineHooks =
      auth === undefined ? hooks : { ...hooks, auth: (stale) => run(auth(stale)) };

    /** Whether the engine was given the call: an abort before it was cannot have run anything. */
    let sent = false;

    const timeoutMs = isTaskOp(call)
      ? TASK_TIMEOUT_MS
      : (target.success.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const what = isTaskOp(call) ? "The request" : "The call";
    const queuedAt = yield* Clock.currentTimeMillis;

    const callCtx: Mutable<McpEngineToolCall["ctx"]> = { origin: ctx.origin };

    if (ctx.conversation !== undefined) callCtx.conversation = ctx.conversation;

    if (ctx.workspace !== undefined) callCtx.workspace = ctx.workspace;

    // A call is offered a task only when the caller can wait for one, for an HTTP server; a `tasks/*` request is a task's.
    const offeredTask = call.op === "tools/call" && reach === "http" && mayWaitForTask(ctx);

    if (offeredTask || isTaskOp(call)) callCtx.allowTask = true;

    const sending: McpEngineRequest = engineRequestOf(call, tool, callCtx);

    const engineCall = Effect.gen(function* () {
      const waited = (yield* Clock.currentTimeMillis) - queuedAt;

      sent = true;

      return yield* engine.request(
        { ...target.success, timeoutMs: Math.max(1, timeoutMs - waited) },
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
      .inFlight(server.conn, caps.engineCall("call", engineCall), workspace)
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

      return callFailed(
        Cut.make({
          message: "The host's connection to the MCP engine was lost",
          mayHaveRun: true,
          lost: "engine",
        }),
      );
    }

    if (answer.success === "timedOut") {
      return callFailed(
        Cut.make({
          message: `${what} waited for a free slot past its ${timeoutMs / 1000} s timeout, and was not sent`,
          mayHaveRun: false,
        }),
      );
    }

    if (answer.success === "aborted") {
      return callFailed(
        Cut.make({
          message: sent
            ? `${what} was cancelled; it may or may not have run`
            : `${what} was cancelled before it was sent`,
          mayHaveRun: sent,
        }),
      );
    }

    const { result } = answer.success;
    const now = yield* Clock.currentTimeMillis;

    // The rows the call changed are kept as a discovery's are; a write the storage refuses never fails the result.
    const ended = yield* Effect.sync(() =>
      store.applyEngineState(
        server.conn,
        result.state,
        now,
        workspace === undefined ? undefined : { workspace, spawn: result.spawn },
      ),
    ).pipe(Effect.catchCause(() => Effect.as(halt, undefined)));

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
    // storage refuses loses the logs, never the result.
    yield* recordLogs(server.conn, result.logs).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The call's MCP server logs were not kept", cause),
      ),
    );

    if (call.op !== "tools/call") {
      yield* Effect.annotateCurrentSpan("mcp.task", yield* taskHash(call.params.taskId));
    }

    if (result.kind === "failed") {
      // A client grant's refused token is not a sign-in the agent could ask for: the call is unreachable with why.
      const refusal = access.refusal?.(result);

      return callFailed(
        refusal === undefined ? result.error : Unreachable.make({ message: refusal }),
      );
    }

    return answered(result, {
      conn: server.conn,
      identity: server.identity,
      signIn: access.signIn?.(),
      mayStartTask: offeredTask,
    });
  });

/** The engine's request for `call`: the tool call, or the `tasks/*` request, with `ctx`. */
const engineRequestOf = (
  call: Decoded,
  tool: Option.Option<McpToolDefinition>,
  ctx: McpEngineToolCall["ctx"],
): McpEngineRequest => {
  switch (call.op) {
    case "tools/call": {
      const sending: Mutable<McpEngineToolCall> = {
        op: "tools/call",
        // The caller named a tool the inventory lists, which `run` checked.
        tool: Option.getOrThrow(tool),
        ctx,
      };

      if (call.params.arguments !== undefined) sending.arguments = call.params.arguments;

      return sending;
    }

    case "tasks/get": {
      const sending: Mutable<Extract<McpEngineRequest, { readonly op: "tasks/get" }>> = {
        op: "tasks/get",
        taskId: call.params.taskId,
        ctx,
      };

      if (Option.isSome(tool)) sending.tool = tool.value;

      return sending;
    }

    case "tasks/update":
      return {
        op: "tasks/update",
        taskId: call.params.taskId,
        inputResponses: call.params.inputResponses,
        ctx,
      };

    case "tasks/cancel":
      return { op: "tasks/cancel", taskId: call.params.taskId, ctx };
  }
};

/** What the host knows of the call the engine answered, for the answer's task fields. */
interface Answered {
  readonly conn: string;
  readonly identity: string;
  /** The MCP sign-in id of the token the call was made with, when it had one. */
  readonly signIn: string | undefined;
  /** Whether the call could be offered a task: one that could not has no task to be answered with. */
  readonly mayStartTask: boolean;
}

/** The host's answer to an engine result that is not a failure. */
const answered = (
  result: Exclude<McpEngineRequestResult, { readonly kind: "failed" }>,
  about: Answered,
): McpHostRequestResult => {
  const origin: Mutable<{ signIn?: string; spawn?: string }> = {};

  if (about.signIn !== undefined) origin.signIn = about.signIn;

  if (result.spawn !== undefined) origin.spawn = result.spawn;

  switch (result.kind) {
    case "complete":
      return result.structuredOutput === undefined
        ? McpHostCompleted.make({ result: result.result })
        : McpHostCompleted.make({
            result: result.result,
            structuredOutput: result.structuredOutput,
          });

    case "task":
      // Never to a call that could not be offered one: an engine that answers so has misread the request.
      return about.mayStartTask
        ? McpHostTaskStarted.make({
            task: result.task,
            conn: about.conn,
            identity: about.identity,
            ...origin,
          })
        : callFailed(
            ProtocolViolation.make({
              message: "The server started an MCP task that was not asked for",
            }),
          );

    case "task_state": {
      const state: Mutable<Parameters<typeof McpHostTaskState.make>[0]> = {
        task: result.task,
        ...origin,
      };

      if (result.result !== undefined) state.result = result.result;

      if (result.structuredOutput !== undefined) state.structuredOutput = result.structuredOutput;

      return McpHostTaskState.make(state);
    }

    case "task_ack":
      return McpHostTaskAck.make(origin);
  }
};
