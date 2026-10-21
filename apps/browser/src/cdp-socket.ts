// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off globalConsole:off missingPipeableSignature:off
// A CDP connection to a Browser Run session over its binding, the transport a Browser Handoff needs. `agents/browser`'s
// own `CdpConnection` answers commands but hands no events to its caller, and the end of a handoff
// (`Cloudflare.handoffComplete`) is one.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserBinding } from "agents/browser";
import type { CdpEvent, CdpParams, CdpTransport } from "./handoff.ts";

/** How long a command may take. */
const COMMAND_TIMEOUT_MS = 10_000;

/** A message from Browser Run: the answer to a command, or an event. */
const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Finite),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  sessionId: Schema.optionalKey(Schema.String),
});

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

type Pending = {
  readonly method: string;
  readonly resolve: (result: Schema.Json) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Open a CDP connection to Browser Run session `browserSessionId`. */
export const openCdpSocket = async (
  binding: BrowserBinding,
  browserSessionId: string,
): Promise<CdpTransport> => {
  const response = await binding.fetch(
    `https://localhost/v1/devtools/browser/${browserSessionId}`,
    {
      headers: { Upgrade: "websocket" },
    },
  );

  const socket = response.webSocket;

  if (socket === null) {
    throw new Error(`Browser Run did not open a CDP connection (${response.status})`);
  }

  socket.accept();

  let nextId = 1;
  let onEvent: (event: CdpEvent) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let closed = false;
  const pending = new Map<number, Pending>();

  const end = (reason: string) => {
    if (closed) return;

    closed = true;

    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      pending.delete(id);
      waiting.reject(new Error(reason));
    }

    onClose();
  };

  socket.addEventListener("message", (event) => {
    const message = decodeMessage(event.data);

    if (Option.isNone(message)) return;

    const { id, result, error, method, params, sessionId } = message.value;

    if (id === undefined) {
      if (method !== undefined) onEvent({ method, params, sessionId });

      return;
    }

    const waiting = pending.get(id);

    if (waiting === undefined) return;

    clearTimeout(waiting.timer);
    pending.delete(id);

    if (error === undefined) waiting.resolve(result ?? null);
    else waiting.reject(new Error(`${waiting.method}: ${error.message ?? "CDP error"}`));
  });
  socket.addEventListener("close", () => end("The CDP connection closed"));
  socket.addEventListener("error", () => end("The CDP connection failed"));

  return {
    send: (method: string, params?: CdpParams, sessionId?: string) =>
      new Promise<Schema.Json>((resolve, reject) => {
        if (closed) {
          reject(new Error(`${method}: the CDP connection is closed`));

          return;
        }

        const id = nextId++;

        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out after ${COMMAND_TIMEOUT_MS}ms: ${method}`));
        }, COMMAND_TIMEOUT_MS);

        pending.set(id, { method, resolve, reject, timer });

        try {
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`${method}: ${String(error)}`, { cause: error }));
        }
      }),
    onEvent: (listener) => {
      onEvent = listener;
    },
    onClose: (listener) => {
      onClose = listener;
    },
    close: () => {
      try {
        socket.close(1000, "Done");
      } catch {
        // Already closed.
      }

      end("The CDP connection was closed");
    },
  };
};
