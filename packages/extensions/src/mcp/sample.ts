// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What a call of an MCP tool does with the Sampling requests its Legacy server makes (`docs/architecture/
// mcp-server-requests.md` → Sampling requests; ADR-0039): the hook the host passes on to the engine (`onInput`, for a
// request of kind `sampling`), which runs the request on the Session's sampler (`./sampling.ts`) and answers the server
// with the model's reply or the refusal; and what the model and `details` read of them. Only a server whose definition
// says `sampling: "allow"` is declared a client that samples, so no request reaches here from any other.
//
// Nothing of what was asked or answered goes into `details` or a diagnostic: those say that the server asked, which Role
// answered, what it cost, and why a refusal was one. The messages and the reply are in the Session's records.
import {
  isJsonObject,
  type McpInputAnswer,
  type McpInputRequest,
  plainLine,
} from "@cloudpid/mcp/types";
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
import type { McpSamplingDetail } from "./details.ts";
import type { McpSamplingService } from "./sampling.ts";

/** The call that asks, as the tool knows it. */
export type SamplingCall = {
  readonly sampling: McpSamplingService;
  readonly server: string;
  /** The model-facing name of the tool. */
  readonly tool: string;
  readonly callId: string;
  readonly conversationId: ConversationId;
  /** Aborts when Stop does: a sample under way is stopped, and a card waiting is withdrawn. */
  readonly signal: AbortSignal | undefined;
  /** What the server's definition says: `allow` answers without asking, `ask` asks the owner on a card first. */
  readonly decision: "allow" | "ask";
  /** Where the server's definition is, for the card's badge. */
  readonly source?: McpElicitationSource | undefined;
  /** Stop the call's own clock while the owner decides, and start it again. */
  readonly hold?:
    | { readonly pause: Effect.Effect<void>; readonly resume: Effect.Effect<void> }
    | undefined;
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
};

/** The hook for the Sampling requests of a call of the tool `call.tool`. */
export const samplingHooks = (call: SamplingCall): Sampling => {
  const asked: Array<McpSamplingDetail> = [];
  const running = new Set<Promise<unknown>>();
  const controllers = new Map<string, AbortController>();

  const answer = async (
    request: typeof McpInputRequest.Encoded,
  ): Promise<typeof McpInputAnswer.Encoded> => {
    // Only the engine's Legacy connection asks, and only the requests of this kind are the sampler's.
    if (request.kind !== "sampling") {
      return { kind: "refused", message: "unsupported request", code: -32601 };
    }

    const controller = new AbortController();

    controllers.set(request.key, controller);

    const signal =
      call.signal === undefined
        ? controller.signal
        : AbortSignal.any([call.signal, controller.signal]);

    const outcome = await Effect.runPromise(
      call.sampling.sample({
        server: call.server,
        tool: call.tool,
        callId: call.callId,
        conversationId: call.conversationId,
        key: request.key,
        params: request.params,
        signal,
        decision: call.decision,
        source: call.source,
        hold: call.hold,
      }),
    ).finally(() => controllers.delete(request.key));

    asked.push(outcome.detail);

    return outcome.kind === "sampled"
      ? { kind: "sampled", result: outcome.result }
      : { kind: "refused", message: outcome.message, code: outcome.code };
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
    get asked() {
      return asked;
    },
  };
};

/** What the model is told of one request that was not answered, in words that carry nothing the server wrote. */
const lineOf = (detail: McpSamplingDetail): string | undefined => {
  if (detail.status === "answered") return undefined;

  if (detail.by === "owner" || detail.by === "grant") {
    return `${detail.server} asked for a model reply; refused by you`;
  }

  // Nothing the server wrote is in a reason, but the model's own failure may carry the provider's words: kept short and plain.
  const why = (() => {
    switch (detail.why) {
      case "unanswered":
        return "the owner did not answer in time";
      case "budget":
        return "out of budget";
      case "cap":
        return "over the limit for one call";
      default:
        return plainLine(detail.reason ?? "no reason given", 400).replace(/[<>]/g, "");
    }
  })();

  return `${detail.server} asked for a model reply; ${detail.status === "refused" ? "refused" : "failed"}: ${why}`;
};

/**
 * `result` of a call whose server made Sampling requests: `details.sampling` says what became of each (never what it
 * held), and a diagnostic line tells the agent of each one that was not answered. The server's own result is untouched.
 */
export const withSampling = (
  result: ToolExecutionResult<JsonValue>,
  asked: ReadonlyArray<McpSamplingDetail>,
): ToolExecutionResult<JsonValue> => {
  if (asked.length === 0) return result;

  const lines = Arr.filterMap(asked, (detail) => {
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
