// The live questions a Legacy server is asking while a call waits (`docs/architecture/mcp-server-requests.md` → The
// waiting-question record, #569): only that a question of server `name` on connection `conn` is waiting, under which key, and the
// caller's `onInputEnded` that withdraws its card. Never the question, its form or the answer (ADR-0041). They are in
// memory only and live as long as the question's `onInput` is pending: an eviction takes them with the call.
//
// The caller is not otherwise told a set change while its call waits (a Session learns the inventory at a request start,
// and none comes while its only Run is blocked on the call), so the host tells it: `endWhere` runs after a set change and
// ends each waiting question whose server is changed, switched off or removed.
// @effect-diagnostics asyncFunction:off -- the hooks are Promise-based RPC stubs
import type { McpEngineHooks, McpHostRequestHooks, McpInputAnswer } from "@cloudpid/mcp/types";

type McpInputAnswerEncoded = typeof McpInputAnswer.Encoded;

/** The server a waiting question was asked by: its name, and the connection key it asked on. */
export type WaitingServer = { readonly name: string; readonly conn: string };

export type WaitingQuestions = {
  /**
   * `hooks` with `onInput` wrapped, so a question that waits in it is known until it is answered. A caller without
   * `onInput`, or without `onInputEnded`, has nothing to be ended: `hooks` as they are.
   */
  readonly watchInput: (server: WaitingServer, hooks: McpHostRequestHooks) => McpHostRequestHooks;
  /**
   * Tell the caller of every waiting question that `reasonOf` has a reason for, once, that its server's question is over
   * (its `onInputEnded`, with the reason). A caller that cannot be told fails nothing.
   */
  readonly endWhere: (reasonOf: (server: WaitingServer) => string | undefined) => void;
};

type Waiting = WaitingServer & {
  readonly key: string;
  /** Tell the caller its question is over, for `reason`; resolves once it heard, or could not be told. */
  readonly end: (reason: string) => Promise<void>;
  /** Why the caller was told its question is over, once it was. */
  endedFor?: string;
};

/** The JSON-RPC code a Sampling request is refused with when its server changed while it waited: no protocol code, cloudpid's own. */
const SERVER_CHANGED_CODE = -1;

/** What a server whose question was ended by a set change is answered if the owner's answer arrived anyway. */
const answerForChangedServer = (kind: "elicitation" | "sampling"): McpInputAnswerEncoded =>
  kind === "elicitation"
    ? { kind: "answered", result: { action: "cancel" } }
    : {
        kind: "refused",
        message: "The server changed while the request waited, so it was not answered",
        code: SERVER_CHANGED_CODE,
      };

export const waitingQuestions = (): WaitingQuestions => {
  const waiting = new Set<Waiting>();

  return {
    watchInput: (server, hooks) => {
      const { onInput, onInputEnded } = hooks;

      if (onInput === undefined || onInputEnded === undefined) return hooks;

      const withWaiting: McpEngineHooks["onInput"] = async (request) => {
        const entry: Waiting = {
          ...server,
          key: request.key,
          // A stub that is gone, or a hook that throws, leaves the question to its own end.
          end: (reason) =>
            Promise.resolve()
              .then(() => onInputEnded(request.key, reason))
              .catch(() => undefined),
        };

        waiting.add(entry);

        try {
          const answer = await onInput(request);

          if (
            entry.endedFor === undefined ||
            (answer.kind !== "answered" && answer.kind !== "sampled")
          ) {
            return answer;
          }

          // The owner's answer that beat the host's word to the caller is not sent on to a server that has changed: what
          // the owner entered was for the one that asked. The caller hears again, before the server does, that it was
          // not sent, so the record of the answer it kept says so (its first word may have come before the answer).
          await entry.end(entry.endedFor);

          return answerForChangedServer(request.kind);
        } finally {
          waiting.delete(entry);
        }
      };

      return { ...hooks, onInput: withWaiting };
    },
    endWhere: (reasonOf) => {
      for (const entry of waiting) {
        const reason = entry.endedFor === undefined ? reasonOf(entry) : undefined;

        if (reason !== undefined) {
          entry.endedFor = reason;
          void entry.end(reason);
        }
      }
    },
  };
};
