// What an argument form asks the Session through (`docs/architecture/mcp-in-a-session.md` → Arguments and completions):
// the composer's conversation, the server, and the prompt or resource template the form fills in.

// @effect-diagnostics missingPipeableSignature:off -- a hook, not a combinator.

import type { McpCompletionRef } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useMemo } from "react";
import { sessionClientAtom } from "../session/atoms.ts";
import type { FormCompletion } from "./argument-form.tsx";
import type { ConversationKey } from "./conversation.ts";

/**
 * The completions of a form for `ref` of `server`, or undefined when the server does not declare them (`enabled`), in which
 * case the form asks nothing. The Session's connection may come and go under it: a request while there is none fails, and the
 * form says suggestions are unavailable, then asks again with the next value.
 */
export const useFormCompletion = ({
  key,
  server,
  ref,
  enabled,
  signInHref,
}: {
  key: ConversationKey;
  server: string;
  ref: McpCompletionRef;
  enabled: boolean;
  signInHref: string | undefined;
}): FormCompletion | undefined => {
  const result = useAtomValue(sessionClientAtom(key.sessionId));
  const client = AsyncResult.isSuccess(result) ? result.value : undefined;
  const { conversationId } = key;
  const refKey = JSON.stringify(ref);

  return useMemo(
    () =>
      enabled
        ? {
            scope: JSON.stringify([server, ref]),
            signInHref,
            complete: (ask, signal) =>
              client === undefined
                ? Promise.reject(new Error("the Session is not connected"))
                : Effect.runPromise(
                    client.complete(conversationId, {
                      // @effect-diagnostics-next-line cryptoRandomUUID:off -- the browser names its own request, as a draft's ID is.
                      requestId: crypto.randomUUID(),
                      field: ask.field,
                      server,
                      ref,
                      argument: ask.argument,
                      context: { arguments: ask.context },
                    }),
                    { signal },
                  ),
          }
        : undefined,
    // `ref` is held by `refKey`: a new object of the same ref is the same form.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [enabled, server, refKey, client, conversationId, signInHref],
  );
};
