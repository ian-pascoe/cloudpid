// `McpHost.request` (`docs/architecture/mcp-connections.md` → RPC, The engine → Load caps): a Session's request to one of
// the Environment's MCP servers, through `McpEngine` with the caller's hooks. An `op` not in `McpHostRequestInput` is
// `HostUnsupported`.
//
// - **`tools/call`** (#452, #460): the call of a tool of a server that has an inventory, an HTTP server or a stdio server
//   run in the caller's Workspace (`ctx.workspace`; the call may start its Container). It runs inside the caller's
//   invocation, so the caller's `untilAborted`, `onProgress` and `onInput` stubs live as long as it does (#409 answer 2),
//   and go on to the engine as they came. A question a Legacy server asks reaches the caller's `onInput` this way
//   (`ctx.answers` says which kinds it takes), and the call's timeout, the engine's, is paused while it waits: the host
//   holds no question state. It may be offered an MCP task (`ctx.allowTask`, an agent's or an App View's call to an
//   HTTP server). For an App tool (#466) it also starts the read of the App's HTML when none is kept for the inventory
//   (`app-reads.ts`), beside the call when the connection is established already and after it otherwise; the call never
//   waits for it, and answers `app.htmlHash` only if the read has stored the page by then.
// - **`tasks/get`, `tasks/update`, `tasks/cancel`** (#455): follow a task. They carry the task's server and tool and the
//   `conn` it was started on, and answer `ServerChanged` when the name's `conn` is another. The host keeps nothing of a
//   task. A task on a stdio server is `HostUnsupported` until [#494](https://github.com/ian-pascoe/cloudpid/issues/494)
//   (`docs/architecture/mcp-server-requests.md` → MCP tasks).
// - **`resources/list`, `resources/templates/list`, `resources/read`** (#471): a page of a server's resources or templates,
//   from a cursor, kept in the list cache for a Modern server's `ttlMs`; and a read with the SHA-256 of its contents
//   (`resources.ts`).
// - **`prompts/get`** (#463): the owner's pick of a prompt of a server whose inventory lists it, a read through the engine
//   with the checks of a call, bounded at 30 s (or the entry's lower `timeout`).
// - **`resume`** (#480): a `tools/call` answered `InputRequired` (only to a caller with `ctx.answers.defer`), sent
//   again with the answers to its deferred questions. It carries the tool, the `conn` the server asked on (another one
//   now is `ServerChanged`, nothing sent) and the `ResumeState`, which the host passes on unread and never keeps; it is
//   answered as a `tools/call` is (`docs/architecture/mcp-server-requests.md` → Questions).
// - **`ui/html`** (#466): App HTML for a View that mounts. By `hash` it is the host's own storage, which needs only a
//   server of the set. By `uri` it is a read through the engine, joined with the one in flight, with the checks of a call.
//
// How a request reaches the engine (the target, the access, the slots, what is done with the answer) is in
// `engine-round.ts`.
// @effect-diagnostics missingPipeableSignature:off -- the host's method, not a combinator.
import {
  Cut,
  HostFailed,
  HostUnsupported,
  isMcpHostRequestOp,
  isMcpHostTaskRequest,
  MCP_PROMPT_GET_TIMEOUT_MS,
  MCP_TASK_TIMEOUT_MS,
  MCP_UNASKED_TASK_MESSAGE,
  McpHostAppHtml,
  McpHostAppHtmlRequest,
  McpHostCompleted,
  McpHostPromptGet,
  McpHostInputRequired,
  McpHostRequest,
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  type McpEngineRequest,
  type McpEngineRequestResult,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
  McpToolDefinition,
  NoAppHtml,
  NotAllowed,
  ProtocolViolation,
  UnknownServer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { appUriOf } from "./app-html.ts";
import {
  type AppRead,
  type AppReadServices,
  appReadSoFar,
  awaitAppRead,
  readsAlongside,
  startCallRead,
  startMountRead,
  type StartedRead,
} from "./app-reads.ts";
import {
  callContextOf,
  callFailed,
  reachServer,
  resolve,
  sendToEngine,
  serverOf,
} from "./engine-round.ts";
import { resourceRequest } from "./resources.ts";
import { type McpDiscoveryServices, orHalt, writeOrHalt } from "./discovery.ts";
import { versionsOf } from "./server-state.ts";
import { McpHostStore, type McpHostStoreService } from "./store.ts";

const OpOnly = Schema.Struct({ op: Schema.String });

const decodeOp = Schema.decodeUnknownOption(OpOnly);

const decodeRequest = Schema.decodeUnknownOption(McpHostRequest);

const decodeAppHtml = Schema.decodeUnknownOption(McpHostAppHtmlRequest);

const decodePromptGet = Schema.decodeUnknownOption(McpHostPromptGet);

const decodeDefinition = Schema.decodeUnknownOption(McpToolDefinition);

/** The engine's `tools/call` request. */
type McpEngineToolCall = Extract<McpEngineRequest, { readonly op: "tools/call" }>;

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

/**
 * The page kept under `hash`, marked mounted: the read is the answer, and the mark is upkeep, so a write the storage
 * refuses (a replaced instance) halts background work and never costs the page (`mcp-connections.md` → Deploys).
 */
const mountedPage = (store: McpHostStoreService, hash: string) =>
  Effect.gen(function* () {
    const page = store.readApp(hash);

    if (page !== undefined) {
      const now = yield* Clock.currentTimeMillis;

      yield* writeOrHalt(() => store.touchApp(hash, now));
    }

    return page;
  });

/** The hash an App tool's call answers: the page kept for this inventory, or the one a read already in flight has kept. */
const keptHash = (started: Option.Option<StartedRead>) =>
  Option.match(started, {
    onNone: () => Effect.succeedNone,
    onSome: ({ flight }) =>
      appReadSoFar(flight).pipe(
        Effect.map((outcome) =>
          Option.flatMap(outcome, (each) =>
            each.kind === "kept" ? Option.some(each.hash) : Option.none(),
          ),
        ),
      ),
  });

/**
 * `request` for a `tools/call` or a `tasks/*` request: to the server it names, through the engine. For a `tools/call` of an
 * App tool whose HTML is not kept for this inventory's `version`, the read of its `ui://` resource beside it
 * (`docs/architecture/mcp-apps.md` → Declaring and reading Apps); the call answers when it is done, with `app` only if the
 * page is kept by then.
 */
const toolCall = (
  environment: string | undefined,
  op: string,
  input: typeof McpHostRequestInput.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, AppReadServices> =>
  Effect.gen(function* () {
    const decoded = decodeRequest(input);

    if (Option.isNone(decoded)) return NotAllowed.make({ message: `The ${op} is malformed` });

    const call = decoded.value;
    const { server: name, ctx } = call;

    // Before anything is sent, so a request that times out, is cancelled or never gets a slot still names its task.
    if (isMcpHostTaskRequest(call)) {
      yield* Effect.annotateCurrentSpan("mcp.task", yield* taskHash(call.params.taskId));
    }

    const resolved = yield* resolve(environment, name, ctx, call);

    if (Result.isFailure(resolved)) return resolved.failure;

    const { view, views, workspace } = resolved.success;

    const heldTool = (toolName: string) =>
      Option.flatMap(view.inventory, (held) =>
        Option.flatMap(
          Arr.findFirst(held.tools, (each) => each["name"] === toolName),
          decodeDefinition,
        ),
      );

    // A call (or its resume) is offered a task only when the caller can wait for one, for an HTTP server; a `tasks/*`
    // request is a task's.
    const offeredTask = !isMcpHostTaskRequest(call) && view.reach === "http" && mayWaitForTask(ctx);
    const callCtx: Mutable<McpEngineToolCall["ctx"]> = { ...callContextOf(ctx) };

    if (offeredTask || isMcpHostTaskRequest(call)) callCtx.allowTask = true;

    // What the caller can answer goes on as it came: with the caller's `onInput`, which `engineHooks` passes on, it says
    // the call may be asked questions. The host keeps no question or answer (`mcp-server-requests.md` → Questions).
    if (ctx.answers !== undefined) callCtx.answers = ctx.answers;

    const sending = engineRequestOf(call, heldTool, callCtx);

    // A call names a tool the inventory lists; a task's tool, which only checks a completed result, may have gone.
    if (Option.isNone(sending)) {
      return NotAllowed.make({
        message: `MCP server ${name} lists no tool ${call.op === "tools/call" ? call.params.name : call.params.tool}`,
      });
    }

    const reached = yield* reachServer(resolved.success);

    if (Result.isFailure(reached)) return reached.failure;

    const store = yield* McpHostStore;

    // An App tool's HTML is read when it is not kept for this inventory.
    const tool =
      call.op === "tools/call" ? Option.getOrUndefined(heldTool(call.params.name)) : undefined;

    const uri = tool === undefined ? undefined : appUriOf(tool);
    const version = versionsOf(views).version;
    const stored = uri === undefined ? undefined : store.appUi(view.server.conn, uri);

    // The call's read waits behind calls in the engine queue.
    const read: AppRead | undefined =
      uri === undefined || stored?.version === version
        ? undefined
        : {
            resolved: resolved.success,
            reached: reached.success,
            uri,
            version,
            ctx,
            priority: "background",
          };

    // Beside the call when its connection is established already; else after it, so the two never initialize at once.
    const alongside =
      read !== undefined && readsAlongside(store.prior(view.server.conn, workspace));

    const early =
      read !== undefined && alongside
        ? yield* startCallRead(read, hooks)
        : Option.none<StartedRead>();

    // A call that did not complete ends the read it started. One that did leaves it to go on: the caller's stubs end
    // with this invocation, and the read is its own after that. However the call ends, the watcher goes.
    const sent = yield* sendToEngine({
      resolved: resolved.success,
      reached: reached.success,
      request: sending.value,
      hooks,
      mayHaveRun: true,
      timeoutMs: isMcpHostTaskRequest(call) ? MCP_TASK_TIMEOUT_MS : undefined,
      what: isMcpHostTaskRequest(call) ? "The request" : undefined,
    }).pipe(
      Effect.tap((result) =>
        Result.isFailure(result)
          ? Option.match(early, {
              onNone: () => Effect.void,
              onSome: (each) => each.cancel,
            })
          : Effect.void,
      ),
      Effect.ensuring(
        Option.match(early, { onNone: () => Effect.void, onSome: (each) => each.stopWatching }),
      ),
    );

    if (Result.isFailure(sent)) return sent.failure;

    const answer = answered(call, sent.success.result, {
      conn: view.server.conn,
      identity: view.server.identity,
      signIn: sent.success.signIn,
      mayStartTask: offeredTask,
      mayAsk: ctx.answers?.defer === true,
    });

    // Only a completed call answers an App's hash.
    if (!Predicate.isTagged(answer, "Completed")) return answer;

    const late =
      read !== undefined && !alongside
        ? yield* startCallRead(read, undefined)
        : Option.none<StartedRead>();

    // The page kept for this inventory, or the one the read has kept by now; a read still running is not waited for.
    const htmlHash =
      stored?.version === version
        ? stored.hash
        : Option.getOrUndefined(yield* keptHash(Option.orElse(early, () => late)));

    return htmlHash === undefined ? answer : { ...answer, app: { htmlHash } };
  });

/**
 * `request({ op: "ui/html" })`: App HTML for a View that mounts. By `hash`, the page the host kept, marked mounted: it
 * touches nothing remote, so it needs only a server of the set, however it is exposed or signed in, and no Workspace. By
 * `uri`, the `ui://` resource read now and kept, for a call whose read failed, was held back or whose HTML was evicted:
 * the checks of a call (a server that may be called, in the request's Workspace if it is stdio), and a URI that some
 * listed tool of the server declares as its App. It joins the read in flight, and is never held back by a failed one.
 */
const appHtml = (
  environment: string | undefined,
  input: typeof McpHostRequestInput.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, AppReadServices> =>
  Effect.gen(function* () {
    const asked = decodeAppHtml(input);

    if (Option.isNone(asked)) return NotAllowed.make({ message: "The ui/html is malformed" });

    const { server: name, params, ctx } = asked.value;
    const store = yield* McpHostStore;

    if ("hash" in params) {
      const named = yield* serverOf(name);

      if (Option.isNone(named)) {
        return UnknownServer.make({ message: `No MCP server ${name} in this Environment` });
      }

      const page = yield* mountedPage(store, params.hash);

      return page === undefined
        ? NoAppHtml.make({ message: "The host holds no App HTML under that hash" })
        : McpHostAppHtml.make(page);
    }

    const { uri } = params;
    const resolved = yield* resolve(environment, name, ctx);

    if (Result.isFailure(resolved)) return resolved.failure;

    const { view, views } = resolved.success;

    const declared = Arr.some(
      view.inventory.pipe(
        Option.map((held) => held.tools),
        Option.getOrElse(() => []),
      ),
      (tool) => Option.exists(decodeDefinition(tool), (each) => appUriOf(each) === uri),
    );

    if (!declared) {
      return NotAllowed.make({
        message: `No tool of MCP server ${name} declares ${uri} as its App`,
      });
    }

    const reached = yield* reachServer(resolved.success);

    if (Result.isFailure(reached)) return reached.failure;

    const read: AppRead = {
      resolved: resolved.success,
      reached: reached.success,
      uri,
      version: versionsOf(views).version,
      ctx,
      priority: "call",
    };

    let started = yield* startMountRead(read, hooks);
    let outcome = yield* awaitAppRead(started.flight, hooks);

    // The read this mount joined was cancelled by its starter's abort: no failure, and not this mount's to give up on.
    // It reads once more, as the starter of its own.
    if (outcome !== "left" && outcome.kind === "cancelled") {
      started = yield* startMountRead(read, hooks);
      outcome = yield* awaitAppRead(started.flight, hooks);
    }

    // The mount ended, by its abort or its answer: the read it started goes with it, if it is not done.
    if (outcome === "left" || outcome.kind === "cancelled") {
      yield* started.cancel;

      return callFailed(
        Cut.make({ message: "The read of the App's HTML was cancelled", mayHaveRun: false }),
      );
    }

    yield* started.stopWatching;

    if (outcome.kind === "failed") return outcome.answer;

    if (outcome.kind === "unkept") return McpHostAppHtml.make(outcome.page);

    const page = yield* mountedPage(store, outcome.hash);

    return page === undefined
      ? NoAppHtml.make({ message: "The App's HTML was evicted as it was read" })
      : McpHostAppHtml.make(page);
  });

/**
 * Mark `conn`'s inventory expired, so the next read that demands it (a catalog's, a request start's) lists the server
 * again (`docs/architecture/mcp-in-a-session.md` → Freshness). Nothing is started here.
 */
const relistNext = (conn: string) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    store.expireInventory([conn]);
  });

/** Whether `answer` is a server saying it has no such prompt: `NotFound`, or the invalid-params error (`-32602`) it answers with. */
const unknownName = (answer: McpHostRequestResult): boolean =>
  Predicate.isTagged(answer, "CallFailed") &&
  (Predicate.isTagged(answer.error, "NotFound") ||
    (Predicate.isTagged(answer.error, "ServerError") && answer.error.code === -32_602));

/**
 * `request({ op: "prompts/get" })`: the owner's pick of a prompt, got when its message is sent (`docs/architecture/
 * mcp-in-a-session.md` → Getting a prompt at send). The checks of a call (a server that may be called, in the request's
 * Workspace if it is stdio) and a prompt the server's inventory lists; it is a read, so the server cannot have run
 * anything if it is cut. Bounded at 30 s, or the entry's lower `timeout`. `ctx.answers` and `onInput` are passed on as
 * a call's are, when the caller has them; the Session does not yet (#492), so a question the server asks during the
 * get is cancelled.
 */
const promptGet = (
  environment: string | undefined,
  input: typeof McpHostRequestInput.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const asked = decodePromptGet(input);

    if (Option.isNone(asked)) return NotAllowed.make({ message: "The prompts/get is malformed" });

    const { server: name, params, ctx } = asked.value;
    const resolved = yield* resolve(environment, name, ctx);

    if (Result.isFailure(resolved)) return resolved.failure;

    const listed = Option.exists(resolved.success.view.inventory, (held) =>
      Arr.some(held.prompts, (prompt) => prompt["name"] === params.name),
    );

    // A prompt the inventory does not list may be one the server has added since: its list is read again next.
    if (!listed) {
      yield* relistNext(resolved.success.view.server.conn);

      return NotAllowed.make({ message: `MCP server ${name} lists no prompt ${params.name}` });
    }

    const reached = yield* reachServer(resolved.success);

    if (Result.isFailure(reached)) return reached.failure;

    const callCtx: Mutable<McpEngineToolCall["ctx"]> = { ...callContextOf(ctx) };

    if (ctx.answers !== undefined) callCtx.answers = ctx.answers;

    const sent = yield* sendToEngine({
      resolved: resolved.success,
      reached: reached.success,
      request: {
        op: "prompts/get",
        name: params.name,
        arguments: params.arguments ?? {},
        ctx: callCtx,
      },
      hooks,
      mayHaveRun: false,
      timeoutMs: Math.min(
        MCP_PROMPT_GET_TIMEOUT_MS,
        reached.success.target.timeoutMs ?? MCP_PROMPT_GET_TIMEOUT_MS,
      ),
      what: "The prompt get",
    });

    if (Result.isFailure(sent)) {
      // The server does not know a prompt its inventory lists: the inventory is stale, so it is read again next.
      if (unknownName(sent.failure)) yield* relistNext(resolved.success.view.server.conn);

      return sent.failure;
    }

    return sent.success.result.kind === "complete"
      ? McpHostCompleted.make({ result: sent.success.result.result })
      : callFailed(
          ProtocolViolation.make({
            message: `The engine answered prompts/get with ${sent.success.result.kind}`,
          }),
        );
  });

/**
 * `request`: the request `input` asks for, to the server it names, with the caller's `hooks`. Never fails: a server not in
 * the set is `UnknownServer`, one that may not be called (switched off or `hidden`, not discovered, a tool its inventory
 * does not list) is `NotAllowed`, and what the engine or the server failed with is `CallFailed`. Without an
 * Environment the host has no Registry to resolve `${NAME}` values with, and refuses.
 *
 * `tools/call` may be offered an MCP task (`ctx.allowTask`, an agent's or an App View's call to an HTTP server), and
 * `tasks/get`, `tasks/update` and `tasks/cancel` follow one: they carry the task's server and tool and the `conn` it was
 * started on, and answer `ServerChanged` when the name's `conn` is another. The host keeps nothing of a task. A task on a
 * stdio server is `HostUnsupported` until [#494](https://github.com/ian-pascoe/cloudpid/issues/494)
 * (`docs/architecture/mcp-server-requests.md` → MCP tasks). `ui/html` is App HTML for a View that mounts (#466).
 */
export const request = (
  environment: string | undefined,
  input: typeof McpHostRequestInput.Encoded,
  hooks: McpHostRequestHooks,
): Effect.Effect<McpHostRequestResult, never, AppReadServices> => {
  const op = Option.getOrUndefined(decodeOp(input))?.op ?? "";

  return Effect.gen(function* () {
    if (!isMcpHostRequestOp(op)) {
      return HostUnsupported.make({ message: `This host does not know the request ${op}`, op });
    }

    if (op === "ui/html") return yield* appHtml(environment, input, hooks);

    if (op === "prompts/get") return yield* promptGet(environment, input, hooks);

    return op === "resources/list" || op === "resources/templates/list" || op === "resources/read"
      ? yield* resourceRequest(environment, op, input, hooks)
      : yield* toolCall(environment, op, input, hooks);
  }).pipe(
    // A storage operation that fails stops background work too: the instance was replaced.
    Effect.catchCause(
      orHalt(HostFailed.make({ message: "The MCP host could not read its storage" })),
    ),
    Effect.withSpan("mcp.request", { attributes: { op } }),
  );
};

/**
 * The engine's request for `call` with `ctx`: none for a `tools/call` of a tool the inventory does not list. A `tasks/get`
 * carries its tool's definition when the inventory still has it, to check a completed result.
 */
const engineRequestOf = (
  call: McpHostRequest,
  heldTool: (name: string) => Option.Option<McpToolDefinition>,
  ctx: McpEngineToolCall["ctx"],
): Option.Option<McpEngineRequest> => {
  switch (call.op) {
    case "tools/call":
      return Option.map(heldTool(call.params.name), (tool) => {
        const sending: Mutable<McpEngineToolCall> = { op: "tools/call", tool, ctx };

        if (call.params.arguments !== undefined) sending.arguments = call.params.arguments;

        return sending;
      });

    case "tasks/get": {
      const sending: Mutable<Extract<McpEngineRequest, { readonly op: "tasks/get" }>> = {
        op: "tasks/get",
        taskId: call.params.taskId,
        ctx,
      };

      const tool = heldTool(call.params.tool);

      if (Option.isSome(tool)) sending.tool = tool.value;

      return Option.some(sending);
    }

    case "tasks/update":
      return Option.some({
        op: "tasks/update",
        taskId: call.params.taskId,
        inputResponses: call.params.inputResponses,
        ctx,
      });

    case "tasks/cancel":
      return Option.some({ op: "tasks/cancel", taskId: call.params.taskId, ctx });

    case "resume":
      return Option.map(heldTool(call.params.tool), (tool) => ({
        op: "resume",
        tool,
        resume: call.params.resume,
        answers: call.params.answers,
        ctx,
      }));
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
  /** Whether the caller keeps questions (`ctx.answers.defer`): one that does not has none to be answered with. */
  readonly mayAsk: boolean;
}

/**
 * The host's answer to an engine result that is not a failure: what `call` asked for. A `tools/call` is answered with a
 * result, or a task when it could be offered one; a `tasks/get` with its state; a `tasks/update` or `tasks/cancel` with
 * an acknowledgement. Any other answer is an engine that misread the request: a protocol violation.
 */
const answered = (
  call: McpHostRequest,
  result: Exclude<McpEngineRequestResult, { readonly kind: "failed" }>,
  about: Answered,
): McpHostRequestResult => {
  const origin: Mutable<{ signIn?: string; spawn?: string }> = {};

  if (about.signIn !== undefined) origin.signIn = about.signIn;

  if (result.spawn !== undefined) origin.spawn = result.spawn;

  const misread = callFailed(
    ProtocolViolation.make({
      message:
        result.kind === "task"
          ? MCP_UNASKED_TASK_MESSAGE
          : `The engine answered ${call.op} with ${result.kind}`,
    }),
  );

  switch (call.op) {
    case "tools/call":
    case "resume":
      if (result.kind === "input_required") {
        // Never to a call whose caller keeps no questions.
        return about.mayAsk
          ? McpHostInputRequired.make({
              requests: result.requests,
              resume: result.resume,
              conn: about.conn,
              identity: about.identity,
              ...origin,
            })
          : misread;
      }

      if (result.kind === "task") {
        // Never to a call that could not be offered one.
        return about.mayStartTask
          ? McpHostTaskStarted.make({
              task: result.task,
              conn: about.conn,
              identity: about.identity,
              ...origin,
            })
          : misread;
      }

      if (result.kind !== "complete") return misread;

      return result.structuredOutput === undefined
        ? McpHostCompleted.make({ result: result.result })
        : McpHostCompleted.make({
            result: result.result,
            structuredOutput: result.structuredOutput,
          });

    case "tasks/get": {
      if (result.kind !== "task_state") return misread;

      const state: Mutable<Parameters<typeof McpHostTaskState.make>[0]> = {
        task: result.task,
        ...origin,
      };

      if (result.result !== undefined) state.result = result.result;

      if (result.structuredOutput !== undefined) state.structuredOutput = result.structuredOutput;

      return McpHostTaskState.make(state);
    }

    case "tasks/update":
    case "tasks/cancel":
      return result.kind === "task_ack" ? McpHostTaskAck.make(origin) : misread;
  }
};
