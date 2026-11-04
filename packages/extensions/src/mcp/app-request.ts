// An App View's request to its own server (`docs/architecture/mcp-apps.md` → An App View's calls): the Session's check
// against its inventory, then `McpHost.request` with `ctx.origin: "app"`, and the host's answer as the View is answered.
//
// - **Allowed:** a `tools/call` of a tool of the server's inventory whose `_meta.ui.visibility` includes `app`, and a
//   `resources/read`, on a server that is not switched off and whose Exposure is not `hidden`. The host checks the same
//   again (`NotAllowed`), and that the server is still the one the call's record names (`ctx.viewHash`).
// - **Server requests and MCP tasks (`docs/architecture/mcp-apps.md` → Server requests from an App View's calls):** a
//   `tools/call` says it can answer a server's form or Sampling request live (`./app-asking.ts`: `ctx.answers`, `onInput`),
//   and a Modern server may answer it with an MCP task, which the Session polls while the View's request is in flight
//   (`./task-view.ts`); a `resources/read` is offered neither, as before.
// - **Never reaches the model:** the result goes back to the View as the server sent it (the store redacts the Secrets
//   held); nothing is written into any conversation.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off newPromise:off -- builders over plain values; the host's abort hook is Promise-based.
import { mcpToolName, mcpToolNames } from "@cloudpid/config";
import {
  isJsonObject,
  type JsonObject,
  type McpAnswers,
  type McpEngineValue,
  type McpHostTaskStarted,
  type PausableDeadline,
  pausableDeadline,
  type McpHostCallFailed,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
  visibilityOfMeta,
} from "@cloudpid/mcp/types";
import {
  conversationOfText,
  MCP_APP_INTERNAL_ERROR,
  mcpAppError,
  type McpAppRequestAnswer,
  type McpAppRequestError,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./client.ts";
import { type AppAsking, appAsking, type McpAppView } from "./app-asking.ts";
import { type McpCallOrigin, contextOf, MCP_CALL_SLACK_MS, waitOf } from "./exchange.ts";
import { isReachable } from "./exposure.ts";
import type { McpQuestionsService } from "./questions.ts";
import type { McpSamplingService } from "./sampling.ts";
import { MCP_APP_TASK_WINDOW_MS, followViewTask, type ViewTaskEnd } from "./task-view.ts";
import type { ViewTaskPlace, ViewTaskStore } from "./task-view-store.ts";
import type { McpTasksTiming } from "./task-port.ts";
import { listedTools, type McpBuildServer } from "./tools.ts";

/** What an App View's request is for: the call it was made in, and the request. The server is the call's record's. */
export type McpAppRequestInput = {
  readonly server: string;
  readonly callId: string;
  readonly conversation: string;
  /** The `viewHash` the call's record pinned, when it pinned one. */
  readonly viewHash?: string | undefined;
  /**
   * The Workspace (`ws:<id>`) the call's conversation works in, where a stdio server runs; the Session's when it is
   * none. Asked only for a stdio server's request.
   */
  readonly workspaceOf?: Effect.Effect<string | undefined> | undefined;
  /** Aborts when the View cancels the request, is torn down, or its page goes. */
  readonly signal: AbortSignal;
  /** What the Session knows of the View: its page's visibility and its one elicitation slot. Absent: no question is asked. */
  readonly view?: McpAppView | undefined;
} & (
  | { readonly method: "tools/call"; readonly name: string; readonly arguments?: JsonObject }
  | { readonly method: "resources/read"; readonly uri: string }
);

/** What `appRequestOf` reads of the Session's MCP tools. */
export type McpAppRequestDeps = {
  readonly client: McpHostClientService;
  /** The servers of the inventory the tools were last built from. */
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly origin: McpCallOrigin;
  /** Marks the Workspace used before a stdio server's request may start its Container; false when it did not answer. */
  readonly ready?: ((workspace: string) => Promise<boolean>) | undefined;
  /** How long past the server's timeout the Session waits for the host, `MCP_CALL_SLACK_MS` unless a test shortens it. */
  readonly slackMs?: number | undefined;
  /** The Session's questions and sampler, which a `tools/call` is asked through; without them none is asked. */
  readonly questions?: McpQuestionsService | undefined;
  readonly sampling?: McpSamplingService | undefined;
  /** Whether the host lists `sampling`: without it no server is told it may sample. */
  readonly hostSamples?: boolean | undefined;
  /** What a `tools/call` is offered an MCP task with: present when the host lists `tasks` and the Session follows them. */
  readonly tasking?:
    | {
        readonly store: ViewTaskStore;
        readonly timing?: McpTasksTiming | undefined;
        /** The servers of the agent's live tasks, which a View's task counts beside (`atCap`). */
        readonly others?: (() => Promise<ReadonlyArray<string>>) | undefined;
      }
    | undefined;
  /** A number that tells one View request's questions from another's: never given twice by one Session's tools. */
  readonly askId: () => number;
};

/** What a View's request came to: its answer, and a line for each question it was asked, for the View's audit log. */
export type McpAppReply = {
  readonly answer: McpAppRequestAnswer;
  readonly notes: ReadonlyArray<string>;
};

/** A promise that resolves when `signal` aborts, and never otherwise. */
const abortedBy = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** Why the Session does not send the request, from its inventory: none when it may be sent. */
const refusalOf = (
  server: Option.Option<McpBuildServer>,
  input: McpAppRequestInput,
): Option.Option<McpAppRequestError> => {
  if (Option.isNone(server)) {
    return Option.some(
      mcpAppError("unavailable", `No MCP server ${input.server} in this Environment`),
    );
  }

  if (!isReachable(server.value)) {
    return Option.some(
      mcpAppError("hidden", `MCP server ${input.server} is switched off or hidden`),
    );
  }

  if (input.method !== "tools/call") return Option.none();

  const tool = Arr.findFirst(listedTools(server.value), (each) => each.name === input.name);

  if (Option.isNone(tool)) {
    return Option.some(
      mcpAppError("refused", `MCP server ${input.server} lists no tool ${input.name}`),
    );
  }

  return visibilityOfMeta(tool.value._meta).includes("app")
    ? Option.none()
    : Option.some(
        mcpAppError(
          "refused",
          `Tool ${input.name} of MCP server ${input.server} is not for App Views`,
        ),
      );
};

/** The model-facing name of `tool` of `server`, as the inventory names it (`mcp__<server>__<tool>`, snake_case, collisions hashed). */
const modelNameOf = (server: McpBuildServer, tool: string): string =>
  mcpToolNames(
    server.name,
    Arr.map(listedTools(server), (each) => each.name),
  ).get(tool) ?? mcpToolName(server.name, tool);

/** What the host answers a request with. */
type HostAnswer = McpHostRequestResult | HostLost;

/** What a request to the host came to: the View's answer, or an MCP task the server answered with, to follow. */
type Sent =
  | { readonly kind: "answer"; readonly answer: McpAppRequestAnswer }
  | { readonly kind: "task"; readonly started: McpHostTaskStarted };

/** The View's answer for how its MCP task `end`ed. */
const taskAnswerOf = (
  end: ViewTaskEnd,
  server: string,
  sunk: string | undefined,
): Effect.Effect<McpAppRequestAnswer> => {
  switch (end.kind) {
    case "completed":
      return valueAnswer(end.result);
    case "refused":
      return Effect.succeed(
        mcpAppError("refused", `${sunk ?? end.message}. ${server}'s MCP task was cancelled`),
      );
    case "stopped":
      return Effect.succeed(mcpAppError("cancelled", "The request was cancelled"));
    case "bound":
      return Effect.succeed(
        mcpAppError(
          "failed",
          `${server}'s MCP task did not finish within ${MCP_APP_TASK_WINDOW_MS / 60_000} minutes, so it was cancelled`,
          MCP_APP_INTERNAL_ERROR,
        ),
      );
    case "ended":
      return Effect.succeed(
        end.status === "cancelled"
          ? mcpAppError("cancelled", `${server}'s MCP task was cancelled`)
          : mcpAppError(
              "failed",
              end.status === "failed"
                ? `${server}'s MCP task failed${end.reason === undefined ? "" : `: ${end.reason}`}`
                : `${server}'s MCP task could not be followed${end.reason === undefined ? "" : `: ${end.reason}`}`,
              end.code ?? MCP_APP_INTERNAL_ERROR,
            ),
      );
  }
};

/** The View's answer for a result's value: the object, or the error that says why it is none. */
const valueAnswer = (result: McpEngineValue): Effect.Effect<McpAppRequestAnswer> => {
  if (result.kind === "stream") {
    // Over 1 MiB: more than a socket message carries, and more than a View is given.
    return Effect.promise(() => result.body.cancel().catch(() => undefined)).pipe(
      Effect.as(
        mcpAppError(
          "failed",
          "The result is too large for an App View (over 1 MiB)",
          MCP_APP_INTERNAL_ERROR,
        ),
      ),
    );
  }

  return Effect.succeed(
    isJsonObject(result.value)
      ? ({ status: "result", result: result.value } as const)
      : mcpAppError("failed", "The server's result is not an object", MCP_APP_INTERNAL_ERROR),
  );
};

/** What the View is answered for the error `error` of its request to `server`. */
const failedWith = (error: McpHostCallFailed["error"], server: string): McpAppRequestError =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", () => ({
      ...mcpAppError("sign_in", `MCP server ${server} needs you signed in`),
      server,
    })),
    Match.tag("StepUpRequired", () => ({
      ...mcpAppError("sign_in", `MCP server ${server} needs you signed in with more access`),
      server,
      stepUp: true,
    })),
    Match.tag("Unreachable", (each) => mcpAppError("unavailable", each.message)),
    Match.tag("ServerError", (each) =>
      mcpAppError("failed", each.message, each.code ?? MCP_APP_INTERNAL_ERROR),
    ),
    Match.tag("NotFound", (each) => mcpAppError("failed", each.message, each.code)),
    Match.orElse((each) => mcpAppError("failed", each.message, MCP_APP_INTERNAL_ERROR)),
  );

/** The App View's answer for what the host answered. */
const answerOf = (answer: HostAnswer, server: string): Effect.Effect<McpAppRequestAnswer> =>
  Match.value(answer).pipe(
    Match.tag("Completed", (done) => valueAnswer(done.result)),
    Match.tag("CallFailed", (failed) => Effect.succeed(failedWith(failed.error, server))),
    Match.tag("UnknownServer", "ServerChanged", (each) =>
      Effect.succeed(mcpAppError("unavailable", each.message)),
    ),
    Match.tag("NotAllowed", (each) => Effect.succeed(mcpAppError("refused", each.message))),
    Match.tag("HostUnsupported", "HostFailed", "HostLost", (each) =>
      Effect.succeed(mcpAppError("failed", each.message, MCP_APP_INTERNAL_ERROR)),
    ),
    Match.orElse((each) =>
      Effect.succeed(
        mcpAppError(
          "failed",
          `The MCP host answered ${each._tag}, which an App View's request never asks for`,
          MCP_APP_INTERNAL_ERROR,
        ),
      ),
    ),
  );

/** What a `tools/call` of a View is offered: the questions it may be asked, and an MCP task. */
type Offered = {
  readonly answers?: McpAnswers | undefined;
  readonly allowTask?: boolean | undefined;
};

/** The host request for `input`, as an App View's: a `tools/call` is offered what `offered` says, a read nothing. */
const requestOf = (
  deps: McpAppRequestDeps,
  input: McpAppRequestInput,
  workspace: string | undefined,
  offered: Offered,
): McpHostRequestInput => {
  const ctx: Mutable<McpHostRequestContext> = {
    ...contextOf(
      deps.origin,
      { callId: input.callId, conversation: input.conversation },
      input.method === "tools/call" ? offered.answers : undefined,
      input.method === "tools/call" ? offered.allowTask : undefined,
    ),
    origin: "app",
  };

  if (workspace !== undefined) ctx.workspace = workspace;

  if (input.viewHash !== undefined) ctx.viewHash = input.viewHash;

  if (input.method === "resources/read") {
    return { op: "resources/read", server: input.server, params: { uri: input.uri }, ctx };
  }

  const params: Mutable<{ name: string; arguments?: JsonObject }> = { name: input.name };

  if (input.arguments !== undefined) params.arguments = input.arguments;

  return { op: "tools/call", server: input.server, params, ctx };
};

/** The words a View's call that a Modern server's refused Sampling request ended is answered with. */
const sunkAnswer = (words: string) =>
  mcpAppError(
    "refused",
    `${words}. On this server's protocol that ends the call, which may have done part of its work`,
  );

/**
 * `input`, sent to its server as an `app` request, and answered as the View is: the result, or the error with why. Never
 * fails: a cancelled request answers `cancelled` whatever the host does, and a host that does not answer within the
 * server's timeout and the slack is `failed`. A `tools/call` may be asked questions (live, `./app-asking.ts`) and answered
 * with an MCP task, followed until it ends, the View goes or 15 minutes pass (`./task-view.ts`).
 */
export const appRequestOf = (
  deps: McpAppRequestDeps,
  input: McpAppRequestInput,
): Effect.Effect<McpAppReply> => {
  const server = Arr.findFirst(deps.servers, (each) => each.name === input.server);
  const refused = refusalOf(server, input);

  if (Option.isSome(refused) || Option.isNone(server)) {
    return Effect.succeed({
      answer: Option.getOrElse(refused, () => mcpAppError("unavailable", "No such server")),
      notes: [],
    });
  }

  const cancelled = mcpAppError("cancelled", "The request was cancelled");
  const conversation = conversationOfText(input.conversation);
  const isCall = input.method === "tools/call";

  // The clock of the request that is out: the Session gives up on the host when it passes.
  let clock: PausableDeadline | undefined;

  // Stops the request's clock while the owner decides, and starts it again: what a question or a Sampling card holds.
  const hold = {
    pause: Effect.suspend(() => clock?.pause ?? Effect.void),
    resume: Effect.suspend(() => clock?.resume ?? Effect.void),
  };

  // The bound of a View's task passing withdraws the cards its questions wait on, as the View going does.
  const expiry = new AbortController();

  const asking: AppAsking | undefined =
    isCall && input.view !== undefined && conversation !== undefined
      ? appAsking(
          {
            questions: deps.questions,
            sampling: deps.sampling,
            hostSamples: deps.hostSamples === true,
          },
          server.value,
          {
            server: input.server,
            tool: modelNameOf(server.value, input.name),
            callId: `app-${deps.askId()}-${input.callId}`,
            conversationId: conversation,
            signal: AbortSignal.any([input.signal, expiry.signal]),
            hold,
            view: input.view,
          },
        )
      : undefined;

  // The place among the caps held for an MCP task, from the offer until the request is over.
  let place: ViewTaskPlace | undefined;

  const reply = (answer: McpAppRequestAnswer): McpAppReply => ({
    answer,
    notes: asking?.notes() ?? [],
  });

  return Effect.gen(function* () {
    if (input.signal.aborted) return reply(cancelled);

    // A stdio server runs in the Container of the call's conversation's Workspace, marked used before it may be started.
    let workspace = deps.origin.workspace;

    if (server.value.server.type === "stdio") {
      workspace =
        (input.workspaceOf === undefined ? undefined : yield* input.workspaceOf) ??
        deps.origin.workspace;

      const named = workspace;

      const ready =
        named !== undefined &&
        (yield* Effect.promise(() => deps.ready?.(named) ?? Promise.resolve(true)));

      if (!ready) {
        return reply(
          mcpAppError(
            "unavailable",
            "The Workspace this server runs in did not answer; the request was not sent",
          ),
        );
      }
    }

    // The Session giving up on the host: aborts the request the host is running. Its clock stands still while a question
    // of the call waits for the owner.
    const lost = yield* pausableDeadline(
      waitOf(server.value, deps.slackMs ?? MCP_CALL_SLACK_MS),
      () => new Error("The Session gave up on the host"),
    );

    clock = lost;

    const { tasking } = deps;

    if (isCall && tasking !== undefined) {
      // One set of caps with the agent's tasks: the place is taken before the call goes out, and given back at the end.
      const others = yield* Effect.promise(() => tasking.others?.() ?? Promise.resolve([]));

      place = tasking.store.offer(input.server, others);
    }

    const hooks: Mutable<McpHostRequestHooks> = {
      // The View cancels, its page goes, or the Session gives up on the host: the host cancels the request.
      untilAborted: () => Promise.race([abortedBy(input.signal), abortedBy(lost.signal)]),
    };

    if (asking !== undefined) Object.assign(hooks, asking.hooks);

    const sending = requestOf(deps, input, workspace, {
      answers: asking?.answers,
      allowTask: place !== undefined,
    });

    const asked: Effect.Effect<Sent> = deps.client.request(sending, hooks).pipe(
      Effect.flatMap((answer: HostAnswer): Effect.Effect<Sent> =>
        Predicate.isTagged(answer, "Task")
          ? Effect.succeed({ kind: "task", started: answer })
          : Effect.map(answerOf(answer, input.server), (each): Sent => ({
              kind: "answer",
              answer: each,
            })),
      ),
    );

    const sent = yield* asked.pipe(
      Effect.raceFirst(
        Effect.promise(() => abortedBy(input.signal)).pipe(
          Effect.as<Sent>({ kind: "answer", answer: cancelled }),
        ),
      ),
      Effect.raceFirst(
        Effect.promise(() => abortedBy(lost.signal)).pipe(
          Effect.as<Sent>({
            kind: "answer",
            answer: mcpAppError(
              "failed",
              "The MCP host did not answer in time",
              MCP_APP_INTERNAL_ERROR,
            ),
          }),
        ),
      ),
      Effect.ensuring(lost.clear),
    );

    let answer: McpAppRequestAnswer;

    if (
      sent.kind === "task" &&
      place !== undefined &&
      tasking !== undefined &&
      conversation !== undefined
    ) {
      // The ctx of the task's own requests: the View's, with no questions, no offer and no pin of its own.
      const ctx: Mutable<McpHostRequestContext> = { ...sending.ctx };

      delete ctx.answers;
      delete ctx.allowTask;
      delete ctx.viewHash;

      const entry = {
        id: `${input.callId}:${sent.started.task.taskId}`,
        server: input.server,
        tool: isCall ? input.name : "",
        taskId: sent.started.task.taskId,
        conn: sent.started.conn,
        callId: input.callId,
        conversation: input.conversation,
        workspace: ctx.workspace,
      };

      place.begin(entry);

      const end = yield* followViewTask({
        client: deps.client,
        started: sent.started,
        server: input.server,
        tool: entry.tool,
        modelTool: modelNameOf(server.value, entry.tool),
        ctx,
        conversation,
        transport: server.value.server.type === "stdio" ? "stdio" : "http",
        signal: input.signal,
        timing: tasking.timing,
        questions:
          asking === undefined
            ? undefined
            : { answers: asking.answers, hooks: asking.hooks, expire: () => expiry.abort() },
      });

      answer = yield* taskAnswerOf(end, input.server, asking?.sunk());
    } else if (sent.kind === "task") {
      // A task nobody can follow (no conversation to follow it for): never offered, so never started.
      answer = mcpAppError(
        "failed",
        "The server started an MCP task that was not asked for",
        MCP_APP_INTERNAL_ERROR,
      );
    } else {
      answer = sent.answer;
    }

    if (asking !== undefined) {
      const words = asking.sunk();

      // A Modern server's Sampling request that was refused ended the call in the core, the server told nothing.
      if (words !== undefined && answer.status === "error" && sent.kind !== "task") {
        answer = sunkAnswer(words);
      }
    }

    // A request cancelled while the host answered it is cancelled all the same: the View has stopped waiting.
    return reply(input.signal.aborted ? cancelled : answer);
  }).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        place?.release();
        await asking?.settle();
      }),
    ),
  );
};
