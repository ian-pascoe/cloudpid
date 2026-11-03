/**
 * The core's task transport: JSON-RPC to a Modern server on a `StreamableHTTPClientTransport` of its own, beside the
 * SDK client's (`docs/architecture/mcp-server-requests.md` → MCP tasks, The wire; The MCP core #394 D8).
 *
 * The SDK's Modern codec answers a `tools/call` only as `resultType: "complete"` or `"input_required"` and refuses
 * `"task"`, and has no `tasks/*` methods, so a task-capable `tools/call` and `tasks/get`, `tasks/update` and
 * `tasks/cancel` go here. The transport frames nothing itself: the caller puts the Modern envelope in `params._meta`
 * (protocol version, client info, client capabilities, with the tasks extension), and the transport derives
 * `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` (the `taskId` for a `tasks/*`) from it. It carries the connection's
 * `fetch`, so the tap's byte limits, retries and verdicts, the token and the redirect rules apply as they do to the
 * client's own requests.
 *
 * A request settles once: with the server's `result`, with the JSON-RPC error that answered it (thrown as the SDK's
 * `ProtocolError`, which the core classifies as any other), with the transport's failure, with a timeout (`SdkError`
 * `RequestTimeout`, started over by each progress notice) or with the caller's abort.
 */
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off -- the SDK's own seam is Promises and callbacks.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type JSONRPCRequest,
  ProtocolError,
  type Result,
  SdkError,
  SdkErrorCode,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import * as Predicate from "effect/Predicate";
import type { Mutable } from "effect/Types";
import type { McpProgress } from "./types.ts";

/** A request's params, with the Modern envelope in `_meta`. */
export type TaskParams = NonNullable<JSONRPCRequest["params"]>;

/** What a request of the wire is given beside its method and params. */
export interface TaskRequestOptions {
  /** Headers besides the ones the transport derives (`Mcp-Param-*`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** How long the server may take; each progress notice for `progress.token` starts it over. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** The `progressToken` the request asked the server to report under, and where its notices go. */
  readonly progress?: {
    readonly token: number;
    readonly notify: (progress: McpProgress) => void;
  };
}

export interface TaskWire {
  /** Sends `method` with `params` and resolves to its `result`. */
  readonly call: (
    method: string,
    params: TaskParams,
    options: TaskRequestOptions,
  ) => Promise<Result>;
  readonly close: () => Promise<void>;
}

interface Pending {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: Error) => void;
  readonly progress: TaskRequestOptions["progress"];
  readonly rearm: () => void;
}

/** A task wire over `transport`, which it starts at its first request. */
export const openTaskWire = (transport: Transport): TaskWire => {
  const pending = new Map<number, Pending>();
  let next = 0;
  let started: Promise<void> | undefined;

  transport.onmessage = (message) => {
    if (isJSONRPCResultResponse(message)) {
      if (Predicate.isNumber(message.id)) pending.get(message.id)?.resolve(message.result);

      return;
    }

    if (isJSONRPCErrorResponse(message)) {
      if (Predicate.isNumber(message.id)) {
        const { code, message: text, data } = message.error;

        pending.get(message.id)?.reject(new ProtocolError(code, text, data));
      }

      return;
    }

    if (isJSONRPCNotification(message) && message.method === "notifications/progress") {
      const { progressToken, progress, total, message: note } = message.params ?? {};

      for (const each of pending.values()) {
        const asked = each.progress;

        if (asked === undefined || asked.token !== progressToken || !Predicate.isNumber(progress)) {
          continue;
        }

        const notice: Mutable<McpProgress> = { progress };

        if (Predicate.isNumber(total)) notice.total = total;

        if (Predicate.isString(note)) notice.message = note;

        each.rearm();
        asked.notify(notice);
      }
    }
  };

  // A failed request surfaces through its own `send`, so the transport's general error channel has nothing to add.
  transport.onerror = () => undefined;

  return {
    call: (method, params, options) =>
      new Promise((resolve, reject) => {
        next += 1;

        const id = next;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          clearTimeout(timer);
          pending.delete(id);
          options.signal.removeEventListener("abort", onAbort);
        };

        const fail = (error: Error) => {
          finish();
          controller.abort();
          reject(error);
        };

        const rearm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              fail(
                new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", {
                  timeout: options.timeoutMs,
                }),
              ),
            options.timeoutMs,
          );
        };

        const onAbort = () => {
          const { reason } = options.signal;

          fail(reason instanceof Error ? reason : new Error("The request was aborted"));
        };

        if (options.signal.aborted) {
          onAbort();

          return;
        }

        options.signal.addEventListener("abort", onAbort, { once: true });

        pending.set(id, {
          resolve: (result) => {
            finish();
            resolve(result);
          },
          reject: fail,
          progress: options.progress,
          rearm,
        });

        rearm();

        started ??= transport.start();

        const sendOptions: Mutable<TransportSendOptions> = { requestSignal: controller.signal };

        if (options.headers !== undefined) sendOptions.headers = { ...options.headers };

        started
          .then(() => transport.send({ jsonrpc: "2.0", id, method, params }, sendOptions))
          .catch((error: Error) => fail(error));
      }),
    close: () => transport.close(),
  };
};
