// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What a call of an MCP tool does with the Sampling requests its server makes (`docs/architecture/
// mcp-server-requests.md` → Sampling requests; ADR-0039): the hook the host passes on to the engine (`onInput`, for a
// request of kind `sampling`), which runs the request on the Session's sampler (`./sampling.ts`) and answers the server
// with the model's reply or the refusal; and what the model and `details` read of them. Only a server whose definition
// says `sampling: "allow"` or `"ask"` is declared a client that samples, so no request reaches here from any other.
// A Modern server's request has no error form to answer with: a refusal ends the call locally (`sunk`), and on a call that
// keeps its questions for later an `ask` request is kept with the call's round (`defer`) and run when it resumes (`resume`).
//
// Nothing of what was asked or answered goes into `details` or a diagnostic: those say that the server asked, which Role
// answered, what it cost, and why a refusal was one. The messages and the reply are in the Session's records.
import {
  isJsonObject,
  type JsonObject,
  type McpInputAnswer,
  type McpInputRequest,
  plainLine,
} from "@cloudpid/mcp/types";
import type { McpSampledMode } from "@cloudpid/config";
import type { McpDeferredSample } from "./deferred-questions.ts";
import type { ClockHold } from "./elicit.ts";
import type { McpElicitationSource } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  ToolDiagnostic,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { McpDetails, McpSamplingDetail } from "./details.ts";
import { failedWith } from "./result.ts";
import type { McpSamplingOutcome, McpSamplingService } from "./sampling.ts";

/** The call that asks, as the tool knows it. */
export type SamplingCall = {
  readonly sampling: McpSamplingService;
  readonly server: string;
  /** The model-facing name of the tool; for a prompt send, the prompt's command. */
  readonly tool: string;
  /** The title of the MCP prompt whose `prompts/get` asks: its requests wait live for 5 min and tell the owner nothing. */
  readonly prompt?: string | undefined;
  /** The call is an App View's `tools/call`: its requests wait live for 5 min and tell the owner nothing. */
  readonly app?: true | undefined;
  /** The handle of the MCP task whose requests these are (`callId` is then its key, `taskOwner`). */
  readonly task?: string | undefined;
  readonly callId: string;
  readonly conversationId: ConversationId;
  /** Aborts when Stop does: a sample under way is stopped, and a card waiting is withdrawn. */
  readonly signal: AbortSignal | undefined;
  /** Asked at each request: aborts when a card waiting for it is to be withdrawn (`McpSamplingAsk.withdraw`). */
  readonly withdraw?: (() => AbortSignal) | undefined;
  /** What the server's definition says: `allow` answers without asking, `ask` asks the owner on a card first. */
  readonly decision: McpSampledMode;
  /** The call keeps a Modern server's questions for later: its `ask` requests are kept with the round, not shown live. */
  readonly defers?: boolean | undefined;
  /** Where the server's definition is, for the card's badge. */
  readonly source?: McpElicitationSource | undefined;
  /** Stop the call's own clock while the owner decides, and start it again. */
  readonly hold?: ClockHold | undefined;
};

/** The hook of a call whose server may sample, and the requests it made. */
export type Sampling = {
  readonly onInput: (
    request: typeof McpInputRequest.Encoded,
  ) => Promise<typeof McpInputAnswer.Encoded>;
  /** The server stopped waiting for the request `key`: its sample is stopped. */
  readonly onInputEnded: (key: string) => void;
  /** Resolves once every request the call made has ended, however it ended. */
  readonly idle: () => Promise<void>;
  /** The call is over: its count and what its records were taken against are forgotten. */
  readonly settle: () => Promise<void>;
  /** What became of each request, in order; read when the call ends. */
  readonly asked: Array<McpSamplingDetail>;
  /**
   * Run a request that was kept with its round, now that it resumes: its answer for the round's resume, or the refusal
   * that sinks it.
   */
  readonly resume: (kept: McpDeferredSample["sample"], key: string) => Promise<McpSamplingOutcome>;
  /**
   * The first request of a Modern server that was refused: the call ends locally, the server told nothing (an
   * `InputResponse` has no error form). Absent while none was.
   */
  readonly sunk: () => McpSamplingDetail | undefined;
};

/** The hook for the Sampling requests of a call of the tool `call.tool`. */
export const samplingHooks = (call: SamplingCall): Sampling => {
  const asked: Array<McpSamplingDetail> = [];
  const running = new Set<Promise<unknown>>();
  const controllers = new Map<string, AbortController>();
  let sunk: McpSamplingDetail | undefined;

  /** The request `key` run on the sampler, its end noted, and (on a Modern server) a refusal noted as the call's. */
  const run = (
    key: string,
    params: JsonObject,
    kept: McpDeferredSample["sample"] | undefined,
    modern: boolean,
  ): Promise<McpSamplingOutcome> => {
    const controller = new AbortController();

    controllers.set(key, controller);

    const signal =
      call.signal === undefined
        ? controller.signal
        : AbortSignal.any([call.signal, controller.signal]);

    return Effect.runPromise(
      call.sampling.sample({
        server: call.server,
        tool: call.tool,
        callId: call.callId,
        conversationId: call.conversationId,
        key,
        params,
        signal,
        decision: call.decision,
        defers: call.defers === true && modern,
        resumed: kept,
        prompt: call.prompt,
        app: call.app,
        withdraw: call.withdraw?.(),
        task: call.task,
        source: call.source,
        hold: call.hold,
      }),
    )
      .finally(() => controllers.delete(key))
      .then((outcome) => {
        if (outcome.kind === "deferred") return outcome;

        asked.push(outcome.detail);

        // A Modern server has no refusal to be told: the call ends, and the first one is why.
        if (outcome.kind === "refused" && modern) sunk ??= outcome.detail;

        return outcome;
      });
  };

  const answer = async (
    request: typeof McpInputRequest.Encoded,
  ): Promise<typeof McpInputAnswer.Encoded> => {
    // Only the requests of this kind are the sampler's.
    if (request.kind !== "sampling") {
      return { kind: "refused", message: "unsupported request", code: -32601 };
    }

    const outcome = await run(request.key, request.params, undefined, request.era === "modern");

    switch (outcome.kind) {
      case "deferred":
        return { kind: "defer" };
      case "sampled":
        return { kind: "sampled", result: outcome.result };
      case "refused":
        return { kind: "refused", message: outcome.message, code: outcome.code };
    }
  };

  const onInput: Sampling["onInput"] = (request) => {
    const pending = answer(request);

    running.add(pending);
    void pending.finally(() => running.delete(pending)).catch(() => undefined);

    return pending;
  };

  return {
    onInput,
    onInputEnded: (key) => controllers.get(key)?.abort(),
    idle: () => Promise.allSettled(running).then(() => undefined),
    settle: () => Effect.runPromise(call.sampling.settleCall(call.callId)),
    resume: (kept, key) => run(key, kept.params, kept, true),
    sunk: () => sunk,
    get asked() {
      return asked;
    },
  };
};

/** How one request that was not answered ended, in words that carry nothing the server wrote. */
export const wordsOf = (detail: McpSamplingDetail): string => {
  if (detail.by === "owner" || detail.by === "grant") return "refused by you";

  // Nothing the server wrote is in a reason, but the model's own failure may carry the provider's words: kept short and plain.
  const why = (() => {
    switch (detail.why) {
      case "unanswered":
        return plainLine(detail.reason ?? "the owner did not answer in time", 400).replace(
          /[<>]/g,
          "",
        );
      case "budget":
        return "out of budget";
      case "cap":
        return "over the limit for one call";
      default:
        return plainLine(detail.reason ?? "no reason given", 400).replace(/[<>]/g, "");
    }
  })();

  return `${detail.status === "refused" ? "refused" : "failed"}: ${why}`;
};

/** What a request that was not answered came to, in the words a refusal that ends a call is told with. */
export const refusedWords = (detail: McpSamplingDetail): string =>
  `${detail.server} asked for a model reply, which was ${wordsOf(detail)}`;

/** What the model is told of one request that was not answered, in words that carry nothing the server wrote. */
const lineOf = (detail: McpSamplingDetail): string | undefined =>
  detail.status === "answered"
    ? undefined
    : `${detail.server} asked for a model reply; ${wordsOf(detail)}`;

/**
 * What the model reads of a Modern call that a refused Sampling request ended (`docs/architecture/
 * mcp-server-requests.md` → Sampling requests, Refusals): an `InputResponse` has no error form, so the server was told
 * nothing and the call ends here, `isError`, with `details.error: "sampling_refused"` (a script's call gets the same
 * code: a script reads only a failed call's text, so the code is in it). The call's own work may be partly done.
 */
export const samplingRefusedResult = (
  detail: McpSamplingDetail,
  base: McpDetails,
): ToolExecutionResult<JsonValue> =>
  failedWith(
    `${refusedWords(detail)}. On this server's protocol that ends the call, which may have done part of its work (sampling_refused).`,
    { ...base, error: "sampling_refused" },
  );

/**
 * `result` of a call whose server made Sampling requests: `details.sampling` says what became of each (never what it
 * held), and a diagnostic line tells the agent of each one that was not answered. The server's own result is untouched.
 */
export const withSampling = (
  result: ToolExecutionResult<JsonValue>,
  asked: ReadonlyArray<McpSamplingDetail>,
): ToolExecutionResult<JsonValue> => {
  if (asked.length === 0) return result;

  // A call a refusal ended says so in its own words: no line for the same request again.
  const ended = isJsonObject(result.details) && result.details["error"] === "sampling_refused";

  const lines = Arr.filterMap(ended ? [] : asked, (detail) => {
    const line = lineOf(detail);

    return line === undefined ? Result.failVoid : Result.succeed(line);
  });

  const diagnostics: ReadonlyArray<ToolDiagnostic> = [
    ...(result.diagnostics ?? []),
    ...Arr.map(lines, (message): ToolDiagnostic => ({
      severity: "info",
      code: "sampling",
      message,
    })),
  ];

  const details: { [key: string]: Schema.Json } = isJsonObject(result.details)
    ? { ...result.details, sampling: asked }
    : { sampling: asked };

  // SAFETY: a `Schema.Json` is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
  return { ...result, details: details as JsonValue, diagnostics };
};
