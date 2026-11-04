// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off -- builders over plain values, and
// pi-durable's Promise-based tool seam.
// One request from a tool of the `mcp` extension to the host and the wait for its answer (`docs/architecture/
// mcp-in-a-session.md` → The `mcp` extension, Calls and results, Resource tools): the part a `tools/call` and a resource
// list or read share, so they end alike.
//
// The request is awaited for its whole length with its `untilAborted` and `onProgress` hooks, so the stubs outlive it.
// Stop aborts the call's context, which resolves `untilAborted`, and the host cancels. The Session waits at most the
// server's `timeout` and `MCP_CALL_SLACK_MS` from the request's start or its last progress notice (progress resets the
// engine's timeout too); past that, or when the RPC breaks, the request reads as `host_lost`. A stdio server runs in
// the Container of the Workspace of the conversation that asks, which is marked used first. A Legacy server's question
// waits for the owner while the clock stands still. A Modern server's questions, on a tool's call to a host that
// resumes, are kept for later (`docs/architecture/mcp-server-requests.md` → The waiting-question record): the call's
// round ends as `InputRequired`, is stored whole and marked (`mcp.wait.<r>`), and the call waits with no clock running;
// once the owner has answered, `mcp.resumed.<r>` is written and the resume sent. A rerun after a restart waits again
// for a round so marked, and settles any other call it finds sent as one that may have run.
import { declaresSampling, samplingOf } from "@cloudpid/config";
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_ELICITATION_WAIT_MS,
  MCP_INPUT_ROUNDS,
  MCP_SAMPLING_WAIT_MS,
  type McpAnswers,
  type McpHostCompleted,
  type McpHostRequest,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostResourceRequest,
  type PausableDeadline,
  pausableDeadline,
} from "@cloudpid/mcp/types";
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  ToolTaskInput,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { agentOf, conversationWorkspace, SubagentsDoc } from "../subagents/state.ts";
import type { McpAppRecorder } from "./apps.ts";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails, McpElicitationDetail, McpSamplingDetail } from "./details.ts";
import { elicitingHooks, withElicitation } from "./elicit.ts";
import type { Subject } from "./ended.ts";
import { samplingHooks, samplingRefusedResult, withSampling } from "./sample.ts";
import { MCP_SAMPLING_OFF_REASON } from "./sampling-questions.ts";
import type { McpSamplingService } from "./sampling.ts";
import {
  failedWith,
  failureResult,
  hostLostResult,
  interruptedResult,
  streamFailure,
} from "./result.ts";
import { type McpDeferredRound, McpRoundState, type McpQuestionsService } from "./questions.ts";
import { resumeOf, type Rounds, storeRound, waitingRound } from "./rounds.ts";
import type { McpSignInsService } from "./sign-in.ts";
import { readStreamed, type StreamLimits } from "./stream.ts";
import type { McpTaskFollower } from "./task-follow.ts";
import { followInline, recordOfCall, startTask, type TaskCall } from "./task-inline.ts";
import { windowMsOf } from "./task-policy.ts";
import type { McpTasksOptions } from "./task-port.ts";
import type { McpResultPool } from "./task-results.ts";
import { atCap, McpTasksDoc, type McpTaskRecord } from "./task-state.ts";
import type { McpBuildServer } from "./tools.ts";

/** A server's `timeout` when its entry has none, in seconds (`DEFAULT_MCP_TIMEOUT`). */
const DEFAULT_TIMEOUT_S = 60;

/**
 * How long past a call's timeout the Session waits for the host's answer before it reads the call as lost: 60 s, the
 * connects a call may make before it is sent (three when the server's era is in doubt, each up to
 * `MCP_CONNECT_TIMEOUT_MS`) and 15 s more for the RPCs, so the host answers first whenever it can.
 */
export const MCP_CALL_SLACK_MS = 3 * MCP_CONNECT_TIMEOUT_MS + 15_000;

/** The longest a result's stream may be quiet while the Session reads it before it is read as lost, in ms. */
export const MCP_STREAM_IDLE_MS = 30_000;

/**
 * The host feature a call answers a Legacy server's Sampling requests with: a host that lists it declares `sampling` to a
 * server whose definition says `allow` (`docs/architecture/mcp-server-requests.md` → Sampling requests). Without it no
 * server is told it may sample, so none asks.
 */
export const MCP_SAMPLING_FEATURE = "sampling";

/** Whether the host lists `sampling`: a call to a server that `allow`s it may then say it can answer its requests. */
export const samplesOf = (build: {
  readonly features?: ReadonlyArray<string> | undefined;
}): boolean => build.features?.includes(MCP_SAMPLING_FEATURE) === true;

/** How the tools wait: the slack past a call's timeout, `MCP_CALL_SLACK_MS` unless a test shortens it. */
export type McpToolOptions = {
  readonly slackMs?: number;
  /** How long a result's stream may be quiet, `MCP_STREAM_IDLE_MS` unless a test shortens it. */
  readonly streamIdleMs?: number;
  /** How long a result's stream waits for the decode slot, `MCP_STREAM_SLOT_WAIT_MS` unless a test shortens it. */
  readonly streamWaitMs?: number;
  /**
   * A call to Workspace `workspace` (`ws:<id>`) that marks it used (`noteSessionActivity`), awaited before a call to a
   * stdio server, which may start that Workspace's Container; false when it did not answer, and the call is then not sent.
   * Absent: nothing is awaited.
   */
  readonly ready?: ((workspace: string) => Promise<boolean>) | undefined;
  /**
   * The Session's MCP questions. With them, a call says it can answer a Legacy server's elicitation form
   * (`ctx.answers`), which waits for the owner (`docs/architecture/mcp-server-requests.md` → Elicitation requests);
   * without them, every question a server asks is cancelled.
   */
  readonly questions?: McpQuestionsService;
  /**
   * The Session's sampler. With it, a call to a Legacy server whose definition says `sampling: "allow"`, on a host that
   * lists `sampling`, says it can answer the server's Sampling requests (`ctx.answers`), which run on the Session's
   * models (`docs/architecture/mcp-server-requests.md` → Sampling requests); without it none is declared or answered.
   */
  readonly sampling?: McpSamplingService | undefined;
  /**
   * The Session's Sign-in requests, and the Environment they are for: with both, the build registers `mcp_sign_in_ask` when
   * its set has a server that can need a sign-in (`docs/architecture/mcp-sign-in.md` → Sign-in requests).
   */
  readonly signIns?: McpSignInsService | undefined;
  readonly environment?: string | undefined;
  /** How long a signed-in server is waited for to connect, `MCP_SIGN_IN_CONNECT_WAIT_MS` unless a test shortens it. */
  readonly connectWaitMs?: number | undefined;
  /** The extension's system prompt sections: the `mcp_servers` section (`./servers.ts`). */
  readonly sections?: ReadonlyArray<PromptSection>;
  /**
   * Where the records of App calls and the inventory's App tools are kept (`./apps.ts`): with it, a completed call of an
   * App tool is recorded. Without it nothing is.
   */
  readonly apps?: McpAppRecorder | undefined;
  /**
   * How the Session follows the MCP tasks its root agent's calls start (`docs/architecture/mcp-server-requests.md` → MCP
   * tasks): with it, and a host that lists `tasks`, a root call is offered one, the `mcp` extension carries the follower and
   * registers `mcp_tasks`, `mcp_task_wait` and `mcp_task_cancel`. Without it nothing is offered.
   */
  readonly tasks?: McpTasksOptions | undefined;
};

/** Who the Session's calls are made for: the Session and its Workspace (`ws:<id>`). */
export type McpCallOrigin = {
  readonly session?: string | undefined;
  readonly workspace?: string | undefined;
};

/**
 * The host feature a call keeps a Legacy server's `-32042` pages for later with: a host that lists it answers a call
 * with `ctx.answers.pages` `PagesRequired`, and resends it (`docs/architecture/mcp-server-requests.md` → Elicitation
 * requests, URL mode). Without it, a `-32042` is the server's error.
 */
export const MCP_RESEND_FEATURE = "resend";

/**
 * What a call says it can answer when the Session has questions to show: a Legacy server's elicitation form, for as long
 * as the owner has to answer it and a little more, so the Session's own end of the wait comes first.
 */
const ELICITATION_ANSWERS: McpAnswers = {
  elicitation: true,
  inputWaitMs: MCP_ELICITATION_WAIT_MS + 15_000,
};

/**
 * What a call says it can answer when its server's Modern questions are kept for later too: its round ends as
 * `input_required`, and the call waits for the owner after it.
 */
const DEFERRING_ANSWERS: McpAnswers = { ...ELICITATION_ANSWERS, defer: true };

/** What a call says it can answer when its server may sample: for as long as a sample may take, and a little more. */
const SAMPLING_ANSWERS: McpAnswers = {
  sampling: true,
  inputWaitMs: MCP_SAMPLING_WAIT_MS + 15_000,
};

/** `answers` and what a call that samples adds to it (the larger wait of the two). */
const withSamplingAnswers = (answers: McpAnswers | undefined): McpAnswers => ({
  ...answers,
  ...SAMPLING_ANSWERS,
  inputWaitMs: Math.max(answers?.inputWaitMs ?? 0, SAMPLING_ANSWERS.inputWaitMs ?? 0),
});

/** What a call says it can answer when it keeps a Legacy server's `-32042` pages for later too: `pages_required`. */
const PAGING_ANSWERS: McpAnswers = { ...DEFERRING_ANSWERS, pages: true };

/** What a call says it can answer: its questions, kept for later when it defers, and its pages too when the host resends. */
const answersOf = (deferring: boolean, pages: boolean): McpAnswers =>
  deferring ? (pages ? PAGING_ANSWERS : DEFERRING_ANSWERS) : ELICITATION_ANSWERS;

/** The marker written before a call's request leaves: a rerun that finds it settles the call, and never sends it again. */
const SENT = "mcp.sent";

/** How long the Session waits for a request to `server` since its start or its last progress, in ms. */
export const waitOf = (server: McpBuildServer, slackMs: number): number => {
  const { timeout } = server.server;

  return (
    (Predicate.isNumber(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_S) * 1000 + slackMs
  );
};

/** A promise that resolves when any of `signals` aborts, and never without one. */
const abortedBy = (signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve) => {
    for (const signal of signals) {
      if (signal.aborted) return resolve();

      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

/** The call of the `codemode` script that made the nested call the task `api` runs; undefined for a model's own call. */
export const parentCallOf = async (
  api: ToolExecutionApi,
  context: Context,
): Promise<string | undefined> => {
  const task = await api.getTask(api.taskId, context).catch(() => undefined);
  // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
  const input = task?.input as ToolTaskInput | undefined;

  return input?.kind === "nested" ? input.parentCallId : undefined;
};

/** Whether the call is a script's (`codemode`): a nested call of the task `api` runs. */
export const isNested = async (api: ToolExecutionApi, context: Context): Promise<boolean> =>
  (await parentCallOf(api, context)) !== undefined;

/**
 * The Workspace the calling conversation works in (`ws:<id>`): its own Subagent Workspace, or its nearest ancestor's, else
 * `fallback`, the Session's. A read that fails is the Session's too.
 */
const workspaceOfCall = async (
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
  fallback: string | undefined,
): Promise<string | undefined> => {
  try {
    const state = await api.snapshot(SubagentsDoc, context);

    return (
      (state === undefined
        ? undefined
        : conversationWorkspace(state, api.conversationId)?.object) ?? fallback
    );
  } catch {
    return fallback;
  }
};

/** The agent the calling conversation is: `root` (any Session branch), or a subagent's ID. A read that fails is the root's. */
const agentOfCall = async (
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
): Promise<string> => {
  try {
    const state = await api.snapshot(SubagentsDoc, context);

    return (state === undefined ? undefined : agentOf(state, api.conversationId)) ?? "root";
  } catch {
    return "root";
  }
};

/** Whether the calling conversation is a subagent's: it reports a needed sign-in to its parent, since only the root asks. */
const isSubagentCall = async (
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
): Promise<boolean> => (await agentOfCall(api, context)) !== "root";

/** The context of a request: who asks, for which call, and what the call can answer. */
export const contextOf = (
  origin: McpCallOrigin,
  call: { readonly callId: string; readonly conversation: string },
  answers?: McpAnswers,
  allowTask?: boolean,
): McpHostRequestContext => {
  const ctx: Mutable<McpHostRequestContext> = {
    origin: "agent",
    callId: call.callId,
    conversation: call.conversation,
  };

  if (origin.session !== undefined) ctx.session = origin.session;

  if (origin.workspace !== undefined) ctx.workspace = origin.workspace;

  if (answers !== undefined) ctx.answers = answers;

  if (allowTask === true) ctx.allowTask = true;

  return ctx;
};

/** What a request is sent for: the tool that sends it, its server and what a result starts from. */
export type Exchange = {
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  readonly server: McpBuildServer;
  readonly options: McpToolOptions;
  /** The model-facing name of the tool that sends. */
  readonly tool: string;
  /** What `details` starts from; every end of the request keeps it. */
  readonly details: McpDetails;
  /** A tool's call, which may have run when it was cut, or a resource's request, which never has. */
  readonly subject: Subject;
  /**
   * Whether the host resumes a Modern call (its `resume` feature): a tool's call then keeps its server's questions for
   * later, when the Session's questions can (`McpQuestionsService.defers`).
   */
  readonly defers?: boolean | undefined;
  /** Whether the host lists `sampling`: a call or read to a server that may sample says it can answer (`options.sampling`). */
  readonly samples?: boolean | undefined;
  /** Whether the host also resends a Legacy `-32042` (its `resend` feature): the call then keeps its pages for later too. */
  readonly pages?: boolean | undefined;
  /**
   * What the call needs to follow an MCP task its server answers it with (`./task-inline.ts`): present for a tool's call on
   * a host that lists `tasks`, when the Session follows MCP tasks. Whether a given call is offered one is `followsTasks`.
   */
  readonly tasking?: McpTasking | undefined;
};

/** The Session's means of following MCP tasks, as a tool's exchange holds them. */
export type McpTasking = {
  readonly tasks: McpTasksOptions;
  readonly follower: McpTaskFollower;
  readonly pool: McpResultPool;
};

/**
 * Whether this call is offered an MCP task (`allowTask`): the one place the line is drawn. An agent's call (the root's, a
 * subagent's, or a `codemode` script's nested call) to an HTTP server, while the Session and the server are under their
 * caps; an App View's call comes with #498.
 */
export const followsTasks = async (
  exchange: Exchange,
  api: ToolExecutionApi,
  context: Context,
): Promise<boolean> => {
  if (exchange.tasking === undefined || exchange.subject !== "tool") return false;

  if (exchange.server.server.type === "stdio") return false;

  const state = await api.snapshot(McpTasksDoc, context).catch(() => undefined);

  return state === undefined || !atCap(state, exchange.server.name);
};

/**
 * Whether a request is written to the `mcp.sent` marker before it leaves, so a rerun after a restart that finds it never
 * sends it again: a tool's call may have changed something, a resource request only asks.
 */
const remembers = (subject: Subject): boolean => subject === "tool";

/** Who a call is for: a model's may spill, a script's gets its value whole (`codemode`). */
export type Caller = "model" | "script";

/** What a successful request makes of its value, for the `caller` it is for. */
export type OnValue<A> = (
  value: Schema.Json,
  completed: McpHostCompleted,
  caller: Caller,
) => Promise<A>;

/** What a request came to: what `onValue` made of its value and the questions asked, or the result that says why not. */
export type Sent<A> =
  | {
      readonly ok: true;
      readonly value: A;
      readonly asked: Array<McpElicitationDetail>;
      /** The Sampling requests the server made, answered or not. */
      readonly sampled: Array<McpSamplingDetail>;
    }
  | { readonly ok: false; readonly result: ToolExecutionResult<JsonValue> };

/**
 * Sends the request `build` makes (given the Workspace the request is made from and what it can answer) and awaits the
 * host's answer, and what `onValue` makes of its value. Every other end is a result with `exchange.details`: the
 * request was not sent, was stopped, failed, was lost, or its stream could not be read. A question the server asked is
 * noted in that result's `details`, and given with the value (`asked`) for the caller to note in its own.
 */
export const send = async <A>(
  exchange: Exchange,
  api: ToolExecutionApi,
  context: Context,
  build: (
    workspace: string | undefined,
    answers: McpAnswers | undefined,
    allowTask: boolean,
  ) => McpHostRequest | McpHostResourceRequest,
  onValue: OnValue<A>,
): Promise<Sent<A>> => {
  const { client, origin, server, options, tool, subject } = exchange;
  const remember = remembers(subject);
  const base = exchange.details;
  const noun = subject === "tool" ? "call" : "request";
  const failed = (result: ToolExecutionResult<JsonValue>): Sent<A> => ({ ok: false, result });
  const { questions } = options;

  // A Modern server's questions are kept for later on a tool's call, when the host resumes and the Session can keep
  // them.
  const deferring =
    remember && exchange.defers === true && questions !== undefined && questions.defers;

  // A resource's read keeps a Legacy server's `-32042` pages for the owner too, when the host resends: a read has no
  // marker of its own, so a rerun after a restart sends it afresh, and the pages are asked again.
  const paging =
    !remember &&
    subject === "resource" &&
    exchange.pages === true &&
    questions !== undefined &&
    questions.defers;

  const rounds: Rounds | undefined =
    (deferring || paging) && questions !== undefined ? { questions, api, context } : undefined;

  let waiting: McpDeferredRound | undefined;

  // The MCP task the call started before a restart: its record is written in the commit that stores it, so one is found
  // whether or not the `mcp.task` marker followed it.
  let resumedTask: McpTaskRecord | undefined;

  if (remember && (await api.memo<boolean>(SENT, context)) !== undefined) {
    // A rerun after a restart: a round of questions stored and not yet resumed waits again, and an MCP task the call
    // started is followed from where it was. Anything else was sent once, so the call may have run, and is never sent
    // again.
    waiting = rounds === undefined ? undefined : await waitingRound(rounds);

    if (waiting === undefined && exchange.tasking !== undefined) {
      resumedTask = await recordOfCall(api, context, api.callId);
    }

    if (waiting === undefined && resumedTask === undefined) {
      if (questions !== undefined) await Effect.runPromise(questions.settleCall(api.callId));

      return failed(interruptedResult(tool, base));
    }
  }

  const allowTask =
    remember && resumedTask === undefined && (await followsTasks(exchange, api, context));

  // An HTTP server is called from the Session's Workspace, as it always was. A stdio server runs in the Container of the
  // Workspace that calls it: a conversation in a Subagent Workspace calls for it, not for the Session's, and the
  // Workspace is marked used before the call that may start the Container.
  let workspace = origin.workspace;

  if (server.server.type === "stdio") {
    workspace = await workspaceOfCall(api, context, origin.workspace);

    const ready = workspace !== undefined && (await (options.ready?.(workspace) ?? true));

    if (!ready) {
      return failed(
        failedWith(
          `The Workspace this server runs in did not answer; the ${noun} was not sent`,
          base,
        ),
      );
    }
  }

  const wait = waitOf(server, options.slackMs ?? MCP_CALL_SLACK_MS);
  const stopped = context.abortSignal === undefined ? [] : [context.abortSignal];

  // The clock of the request that is out: the Session gives up on the host when it passes.
  let clock: PausableDeadline | undefined;

  // Stops the call's clock while the owner decides, and starts it again: what a question or a Sampling card holds.
  const hold = {
    pause: Effect.suspend(() => clock?.pause ?? Effect.void),
    resume: Effect.suspend(() => clock?.resume ?? Effect.void),
  };

  // A server's question waits for the owner while the call's clock stands still, and Stop withdraws it. A Modern one is
  // kept for later instead when the call defers, and waited for between its rounds, with no clock running.
  const asking =
    questions === undefined
      ? undefined
      : elicitingHooks({
          questions,
          server: server.name,
          tool,
          callId: api.callId,
          conversationId: api.conversationId,
          signal: context.abortSignal,
          source: server.source,
          defers: deferring,
          keepsPages: paging,
          ...hold,
        });

  // A Legacy HTTP server whose definition does not say `off` has its Sampling requests answered on the Session's models,
  // on a tool's call and a resource read (`exchange.samples`): at once for `allow`, after the owner's yes on a card for
  // `ask`. A stdio server declares none until #569.
  const sampling =
    options.sampling !== undefined && exchange.samples === true && declaresSampling(server.server)
      ? samplingHooks({
          sampling: options.sampling,
          server: server.name,
          tool,
          callId: api.callId,
          conversationId: api.conversationId,
          signal: context.abortSignal,
          decision: samplingOf(server.server) === "allow" ? "allow" : "ask",
          // A Modern server's `ask` request is kept with the call's round when the call keeps its questions.
          defers: deferring,
          source: server.source,
          hold,
        })
      : undefined;

  // A rerun's call tells of the questions its earlier rounds were asked, as the instance that asked them would have.
  if (waiting !== undefined) asking?.asked.push(...waiting.asked);

  const questionAnswers =
    questions === undefined ? undefined : answersOf(deferring || paging, exchange.pages === true);

  const request = build(
    workspace,
    sampling === undefined ? questionAnswers : withSamplingAnswers(questionAnswers),
    allowTask,
  );

  // Who the call is for, for a call that may be answered with an MCP task: its script or its model, and its agent.
  const taskCaller =
    exchange.tasking === undefined
      ? undefined
      : {
          caller: (await isNested(api, context)) ? ("script" as const) : ("model" as const),
          agent: await agentOfCall(api, context),
        };

  /** What following an MCP task needs, for a call whose server answers with one. */
  const taskCall = (): TaskCall | undefined =>
    exchange.tasking === undefined || taskCaller === undefined
      ? undefined
      : {
          ...taskCaller,
          api,
          context,
          client,
          tasks: exchange.tasking.tasks,
          origin: { session: origin.session, workspace },
          follower: exchange.tasking.follower,
          pool: exchange.tasking.pool,
          base,
        };

  // Durable before the request leaves, so a restart finds the call sent.
  if (remember && waiting === undefined) await api.memo(SENT, true, context);

  /** One request out to the host under its own clock: the host's answer, or `undefined` when it was lost. */
  const once = async (input: McpHostRequest | McpHostResourceRequest) => {
    const lost = await Effect.runPromise(
      pausableDeadline(wait, () => new Error("The Session gave up on the host")),
    );

    clock = lost;

    const hooks: Mutable<McpHostRequestHooks> = {
      // Stop, or the Session giving up on the host: either way the host cancels the request.
      untilAborted: () => abortedBy([...stopped, lost.signal]),
      // Progress resets the timeout and rides in the running call's `details`, which the web does not draw: never
      // output text, and gone from the settled call's `details`.
      onProgress: (progress) =>
        Effect.runPromise(lost.reset).then(() =>
          api.details({ ...base, progress }, context).catch(() => undefined),
        ),
    };

    if (asking !== undefined && sampling === undefined) {
      hooks.onInput = asking.onInput;
      hooks.onInputEnded = asking.onInputEnded;
      hooks.onInputComplete = asking.onInputComplete;
    } else if (sampling !== undefined) {
      // A request goes to the hook of its kind.
      hooks.onInput = (input) =>
        input.kind === "sampling" || asking === undefined
          ? sampling.onInput(input)
          : asking.onInput(input);

      hooks.onInputEnded = async (key) => {
        sampling.onInputEnded(key);
        await asking?.onInputEnded(key);
      };

      // A page's completion is a form's business only: the sampling hook has none.
      if (asking !== undefined) hooks.onInputComplete = asking.onInputComplete;
    }

    const result = await Promise.race([
      Effect.runPromise(client.request(input, hooks)),
      abortedBy([lost.signal]).then(() => undefined),
    ]).finally(() => Effect.runPromise(lost.clear));

    return result === undefined || lost.signal.aborted || Predicate.isTagged(result, "HostLost")
      ? undefined
      : result;
  };

  /** What the host's last answer comes to: the value `onValue` makes of it, or the result that says why not. */
  const settled = async (
    result: Exclude<Awaited<ReturnType<typeof once>>, undefined>,
  ): Promise<Sent<A>> => {
    if (!Predicate.isTagged(result, "Completed")) {
      // A Modern server's Sampling request that was refused ended the call in the core, the server told nothing: the
      // call says so (`details.error`), whatever the core's own words for it were.
      const refused = sampling?.sunk();

      if (refused !== undefined) return failed(samplingRefusedResult(refused, base));

      return failed(
        failureResult(result, base, subject, { subagent: await isSubagentCall(api, context) }),
      );
    }

    // A script's call gets its value whole and no spill.
    const caller: Caller = (await isNested(api, context)) ? "script" : "model";

    const done = async (value: Schema.Json): Promise<Sent<A>> => ({
      ok: true,
      value: await onValue(value, result, caller),
      asked: [],
      sampled: [],
    });

    if (result.result.kind !== "stream") return done(result.result.value);

    const limits: Mutable<StreamLimits> = {
      signal: context.abortSignal,
      idleMs: options.streamIdleMs ?? MCP_STREAM_IDLE_MS,
    };

    if (options.streamWaitMs !== undefined) limits.waitMs = options.streamWaitMs;

    // Over 1 MiB: the engine's bytes, which the host returned unread, are read here, and the result is cut to what the
    // model or the script gets before the decode slot is given up.
    return readStreamed(result.result.body, result.result.bytes, limits, async (streamed) => {
      if (streamed.kind === "aborted") return failed(failedWith(`The ${noun} was stopped`, base));

      return streamed.kind === "value"
        ? done(streamed.value)
        : failed(streamFailure(streamed.kind, base, subject));
    });
  };

  /**
   * The call's rounds: the request, and while its server's questions are kept for later, each round stored, waited for
   * and resumed, until the host answers anything else. A rerun starts from the round it found waiting.
   */
  const finished = async (): Promise<Sent<A>> => {
    const resumed = taskCall();

    // An MCP task the call started before a restart is followed on; its `tools/call` is never sent again.
    if (resumedTask !== undefined && resumed !== undefined) {
      return failed(await followInline(resumed, resumedTask));
    }

    let round = waiting;
    // A read's `-32042` message: the server's own error, which the read ends with when a page is not accepted.
    let pagesMessage = "";

    let next: McpHostRequest | McpHostResourceRequest | undefined =
      round === undefined ? request : undefined;

    while (true) {
      if (next === undefined) {
        if (rounds === undefined || round === undefined)
          return failed(interruptedResult(tool, base));

        const resumed = await resumeOf(rounds, round, {
          server: server.name,
          ctx: request.ctx,
          asked: asking?.asked,
          read: paging && request.op === "resources/read" ? request : undefined,
          sampling,
          // `server` is the definition when `send` (re)started, so one that reads `off` then (a rerun after an eviction) has
          // no sampler to run what the owner allowed.
          samplingOff: declaresSampling(server.server)
            ? undefined
            : { reason: MCP_SAMPLING_OFF_REASON },
        });

        if (resumed.kind === "refused") return failed(failedWith(pagesMessage, base));

        // A Sampling request of the round was refused: it sinks the round, nothing is sent, and the call ends here.
        if (resumed.kind === "sunk") return failed(samplingRefusedResult(resumed.detail, base));

        if (resumed.kind === "stopped") return failed(failedWith(`The ${noun} was stopped`, base));

        if (resumed.kind === "withdrawn") {
          return failed(
            failedWith(
              `${server.name}'s questions ended before they were answered; the ${noun} was not sent again`,
              base,
            ),
          );
        }

        next = resumed.request;
      }

      const result = await once(next);

      if (result === undefined) return failed(hostLostResult(base, subject));

      // The server answered with an MCP task, which only a call offered one gets: the call waits for it inline, then goes
      // on in the background (`./task-inline.ts`).
      const following = taskCall();

      if (Predicate.isTagged(result, "Task") && following !== undefined) {
        const record = await startTask(following, result, {
          server: server.name,
          tool: next.op === "tools/call" ? next.params.name : (round?.tool ?? ""),
          modelTool: tool,
          windowMs: following.tasks.timing?.windowMs ?? windowMsOf(server.server.timeout),
          source: server.source,
        });

        return failed(await followInline(following, record));
      }

      if (
        !(
          Predicate.isTagged(result, "InputRequired") || Predicate.isTagged(result, "PagesRequired")
        ) ||
        rounds === undefined
      ) {
        return settled(result);
      }

      if (Predicate.isTagged(result, "PagesRequired")) {
        pagesMessage = result.message;

        // A tool's call is ended by the core at its eleventh `-32042`; a read, which keeps no state, is ended here, so
        // its count is this instance's: a restart sends the read afresh, bounded by the Session's restart limit.
        if ((round?.round ?? 0) >= MCP_INPUT_ROUNDS) {
          return failed(
            failedWith(
              `${result.message}. ${server.name} kept asking for the same page; stopped after ${MCP_INPUT_ROUNDS} tries`,
              base,
            ),
          );
        }
      }

      // The server asked questions the call keeps: the round is stored whole, then marked, and the call waits.
      round = {
        callId: api.callId,
        round: (round?.round ?? 0) + 1,
        conn: result.conn,
        tool: next.op === "tools/call" ? next.params.name : (round?.tool ?? ""),
        state: Predicate.isTagged(result, "PagesRequired")
          ? result.resend === undefined
            ? McpRoundState.Read()
            : McpRoundState.Resend({ state: result.resend })
          : McpRoundState.Resume({ state: result.resume }),
        asked: [...(asking?.asked ?? [])],
      };

      // Nothing can record the round (a replaced Session): the call is dropped, and the instance after this one settles
      // it as one that may have run.
      if (!(await storeRound(rounds, round))) return failed(interruptedResult(tool, base));

      next = undefined;
    }
  };

  try {
    const sent = await finished();

    // The call is over: a question it still waits on is withdrawn first, so `details` tells of it too.
    if (questions !== undefined) await Effect.runPromise(questions.settleCall(api.callId));

    await asking?.idle();

    // A sample the server stopped waiting for ends too (its request is aborted), and is told in `details` all the same.
    await sampling?.idle();

    const asked = asking?.asked ?? [];
    const sampled = sampling?.asked ?? [];

    return sent.ok
      ? { ok: true, value: sent.value, asked, sampled }
      : { ok: false, result: withSampling(withElicitation(sent.result, asked), sampled) };
  } finally {
    // However it ended, nothing is left waiting (a second settle is a no-op).
    if (questions !== undefined) await Effect.runPromise(questions.settleCall(api.callId));

    await sampling?.settle();
  }
};
