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
  type McpHostRequest,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  McpHostToolCall,
  McpToolDefinition,
  NotAllowed,
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

const decodeCall = Schema.decodeUnknownOption(McpHostToolCall);

const decodeDefinition = Schema.decodeUnknownOption(McpToolDefinition);

/** The engine's `tools/call` request. */
type McpEngineToolCall = Extract<McpEngineRequest, { readonly op: "tools/call" }>;

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

/**
 * `request`: the call `input` asks for, to the server it names, with the caller's `hooks`. Never fails: a server not in
 * the set is `UnknownServer`, one that may not be called (switched off or `hidden`, not discovered, a tool its inventory
 * does not list) is `NotAllowed`, and what the engine or the server failed with is `CallFailed`. Without an
 * Environment the host has no Registry to resolve `${NAME}` values with, and refuses.
 */
export const request = (
  environment: string | undefined,
  input: typeof McpHostRequest.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const op = Option.getOrUndefined(decodeOp(input))?.op ?? "";

    if (op !== "tools/call") {
      return HostUnsupported.make({ message: `This host does not know the request ${op}`, op });
    }

    const call = decodeCall(input);

    if (Option.isNone(call)) return NotAllowed.make({ message: "The tools/call is malformed" });

    const { server: name, params, ctx } = call.value;

    if (environment === undefined) {
      return NotAllowed.make({ message: "The MCP host's name is unknown" });
    }

    const view = Arr.findFirst(yield* viewServers, (each) => each.server.name === name);

    if (Option.isNone(view)) {
      return UnknownServer.make({ message: `No MCP server ${name} in this Environment` });
    }

    const { server, reach, inventory, state } = view.value;

    if (reach === "off") {
      return NotAllowed.make({ message: `MCP server ${name} is switched off or hidden` });
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

    const tool = Option.flatMap(inventory, (held) =>
      Option.flatMap(
        Arr.findFirst(held.tools, (each) => each["name"] === params.name),
        decodeDefinition,
      ),
    );

    if (Option.isNone(tool)) {
      return NotAllowed.make({ message: `MCP server ${name} lists no tool ${params.name}` });
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

    const timeoutMs = target.success.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const queuedAt = yield* Clock.currentTimeMillis;

    const callCtx: Mutable<McpEngineToolCall["ctx"]> = { origin: ctx.origin };

    if (ctx.conversation !== undefined) callCtx.conversation = ctx.conversation;

    if (ctx.workspace !== undefined) callCtx.workspace = ctx.workspace;

    const sending: Mutable<McpEngineToolCall> = {
      op: "tools/call",
      tool: tool.value,
      ctx: callCtx,
    };

    if (params.arguments !== undefined) sending.arguments = params.arguments;

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
          message: `The call waited for a free slot past its ${timeoutMs / 1000} s timeout, and was not sent`,
          mayHaveRun: false,
        }),
      );
    }

    if (answer.success === "aborted") {
      return callFailed(
        Cut.make({
          message: sent
            ? "The call was cancelled; it may or may not have run"
            : "The call was cancelled before it was sent",
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

    if (result.kind === "failed") {
      // A client grant's refused token is not a sign-in the agent could ask for: the call is unreachable with why.
      const refusal = access.refusal?.(result);

      return callFailed(
        refusal === undefined ? result.error : Unreachable.make({ message: refusal }),
      );
    }

    return result.structuredOutput === undefined
      ? McpHostCompleted.make({ result: result.result })
      : McpHostCompleted.make({ result: result.result, structuredOutput: result.structuredOutput });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The MCP host could not read its storage" })),
    ),
    Effect.withSpan("mcp.request", { attributes: { op: "tools/call" } }),
  );
