// `McpHost.request` (`docs/architecture/mcp-connections.md` → RPC, The engine → Load caps): a Session's call to one of
// the Environment's MCP servers, sent through `McpEngine` with the caller's hooks. As built (#452), `op: "tools/call"`
// to an HTTP server that has an inventory; any other `op` is `HostUnsupported`.
//
// The call runs inside the caller's invocation, so the caller's `untilAborted` and `onProgress` stubs live as long as
// it does (#409 answer 2), and they go on to the engine as they came. It takes a request slot on its server (8) and on
// the host (32), then a slot of the engine queue as a call, served before background work (`limits.ts`); a call that
// waits for a slot counts the wait toward nothing of the server's. The caller's abort ends a wait at once; once sent,
// the engine cuts the server request itself.
// @effect-diagnostics missingPipeableSignature:off -- the host's method, not a combinator.
import {
  Cut,
  HostFailed,
  HostUnsupported,
  McpHostCallFailed,
  McpHostCompleted,
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
import { targetOf, writeOrHalt, type McpDiscoveryServices } from "./discovery.ts";
import { McpEngineClient } from "./engine.ts";
import { McpLoadCaps } from "./limits.ts";
import { viewServers } from "./server-state.ts";
import { McpHostStore } from "./store.ts";

const OpOnly = Schema.Struct({ op: Schema.String });

const decodeOp = Schema.decodeUnknownOption(OpOnly);

const decodeCall = Schema.decodeUnknownOption(McpHostToolCall);

const decodeDefinition = Schema.decodeUnknownOption(McpToolDefinition);

/** The engine's `tools/call` request. */
type McpEngineToolCall = Extract<McpEngineRequest, { readonly op: "tools/call" }>;

const callFailed = (error: McpHostCallFailed["error"]) => McpHostCallFailed.make({ error });

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

    if (reach === "stdio") {
      return NotAllowed.make({ message: `MCP server ${name} runs over stdio, which comes later` });
    }

    // A server that wants a sign-in is not sent the call: the owner signs in first.
    if (state === "sign_in" || state === "rejected") {
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
    const target = yield* targetOf(environment, server);

    if (Result.isFailure(target)) {
      return callFailed(Unreachable.make({ message: target.failure.message }));
    }

    /** Whether the engine was given the call: an abort before it was cannot have run anything. */
    let sent = false;

    const callCtx: Mutable<McpEngineToolCall["ctx"]> = { origin: ctx.origin };

    if (ctx.conversation !== undefined) callCtx.conversation = ctx.conversation;

    if (ctx.workspace !== undefined) callCtx.workspace = ctx.workspace;

    const sending: Mutable<McpEngineToolCall> = {
      op: "tools/call",
      tool: tool.value,
      ctx: callCtx,
    };

    if (params.arguments !== undefined) sending.arguments = params.arguments;

    const engineCall = Effect.suspend(() => {
      sent = true;

      return engine.request(target.success, store.prior(server.conn), sending, hooks);
    });

    const answer = yield* caps
      .inFlight(server.conn, caps.engineCall("call", engineCall))
      .pipe(
        Effect.asSome,
        Effect.raceFirst(Effect.as(abortOf(hooks), Option.none())),
        Effect.result,
      );

    if (Result.isFailure(answer)) {
      // The engine is out of reach, or its RPC broke mid-call: the server may have run it.
      return callFailed(Cut.make({ message: answer.failure.message, mayHaveRun: true }));
    }

    if (Option.isNone(answer.success)) {
      return callFailed(
        Cut.make({
          message: sent
            ? "The call was cancelled; it may or may not have run"
            : "The call was cancelled before it was sent",
          mayHaveRun: sent,
        }),
      );
    }

    const result = answer.success.value;
    const now = yield* Clock.currentTimeMillis;

    // The rows the call changed are kept as a discovery's are; a write the storage refuses never fails the result.
    yield* writeOrHalt(() => store.applyEngineState(server.conn, result.state, now));

    if (result.kind === "failed") return callFailed(result.error);

    return result.structuredOutput === undefined
      ? McpHostCompleted.make({ result: result.result })
      : McpHostCompleted.make({ result: result.result, structuredOutput: result.structuredOutput });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The MCP host could not read its storage" })),
    ),
    Effect.withSpan("mcp.request", { attributes: { op: "tools/call" } }),
  );
