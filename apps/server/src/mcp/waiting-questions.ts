// The live questions a Legacy server is asking while a call waits (`docs/architecture/mcp-server-requests.md` → The waiting
// question record, #569): only that a question of server `name` on connection `conn` is waiting, under which key, and the
// caller's `onInputEnded` that withdraws its card. Never the question, its form or the answer (ADR-0041). They are in
// memory only and live as long as the question's `onInput` is pending: an eviction takes them with the call.
//
// The caller is not otherwise told a set change while its call waits (a Session learns the inventory at a request start,
// and none comes while its only Run is blocked on the call), so the host tells it: `endWhere` runs after a set change and
// ends each waiting question whose server is changed, switched off or removed.
// @effect-diagnostics asyncFunction:off -- the hooks are Promise-based RPC stubs
import type { McpEngineHooks, McpHostRequestHooks } from "@cloudpid/mcp/types";

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
  readonly end: (reason: string) => void;
  told: boolean;
};

export const waitingQuestions = (): WaitingQuestions => {
  const waiting = new Set<Waiting>();

  return {
    watchInput: (server, hooks) => {
      const { onInput, onInputEnded } = hooks;

      if (onInput === undefined || onInputEnded === undefined) return hooks;

      const watched: McpEngineHooks["onInput"] = async (request) => {
        const entry: Waiting = {
          ...server,
          key: request.key,
          told: false,
          end: (reason) => {
            // A stub that is gone, or a hook that throws, leaves the question to its own end.
            void Promise.resolve()
              .then(() => onInputEnded(request.key, reason))
              .catch(() => undefined);
          },
        };

        waiting.add(entry);

        try {
          return await onInput(request);
        } finally {
          waiting.delete(entry);
        }
      };

      return { ...hooks, onInput: watched };
    },
    endWhere: (reasonOf) => {
      for (const entry of waiting) {
        const reason = entry.told ? undefined : reasonOf(entry);

        if (reason !== undefined) {
          entry.told = true;
          entry.end(reason);
        }
      }
    },
  };
};
