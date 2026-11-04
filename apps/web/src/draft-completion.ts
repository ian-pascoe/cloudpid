// The draft composer's completions of an MCP prompt's arguments (`docs/architecture/mcp-in-a-session.md` → As built (#485):
// completion): there is no Session to ask, so the Registry's `draftComplete` asks the Environment's host through the main
// Worker, for HTTP servers only. A Worker from before that RPC answers an unknown request with a defect, which is read here
// as `unsupported`: nothing is asked of it again.

// @effect-diagnostics missingPipeableSignature:off -- a hook and a combinator over one RPC.

import {
  GLOBAL_SCOPE,
  type McpCompletion,
  type McpCompletionRef,
  noCompletion,
  MCP_COMPLETION_STATUS,
} from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useMemo } from "react";
import type { FormCompletion } from "./chat/argument-form.tsx";
import { RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { mcpSignInStartHref } from "./settings/mcp-sign-in-model.ts";

/** What a Worker that does not have `draftComplete` answers it: a defect that names the tag. */
const UNKNOWN_RPC = "Unknown request tag: draftComplete";

/** `asked`, with the Worker's answer for an RPC it does not have (a deploy between the page and the Worker) as `unsupported`. */
export const readingOldWorker = <E>(asked: Effect.Effect<McpCompletion, E>) =>
  asked.pipe(
    Effect.catchCauseIf(
      (cause) => Cause.pretty(cause).includes(UNKNOWN_RPC),
      () => Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.unsupported)),
    ),
  );

/** The Registry's `draftComplete`, as a function of what the form asks. */
export const draftCompleteAtom = appRuntime.atom(
  RegistryClient.use((registry) =>
    Effect.succeed((payload: Parameters<typeof registry<"draftComplete">>[1]) =>
      registry("draftComplete", payload),
    ),
  ),
);

/**
 * The completions of the draft's form for `ref` of `server`, in `environment`, or undefined when the server does not
 * declare them (`enabled`). A request while the Registry client is not there fails: the form says suggestions are
 * unavailable, and asks again with the next value.
 */
export const useDraftFormCompletion = ({
  environment,
  server,
  ref,
  enabled,
}: {
  environment: string;
  server: string;
  ref: McpCompletionRef;
  enabled: boolean;
}): FormCompletion | undefined => {
  const result = useAtomValue(draftCompleteAtom);
  const ask = AsyncResult.isSuccess(result) ? result.value : undefined;
  const refKey = JSON.stringify(ref);

  return useMemo(
    () =>
      enabled
        ? {
            scope: JSON.stringify(["draft", environment, server, ref]),
            // Where the owner signs in to the server, and back to the draft.
            signInHref: mcpSignInStartHref({
              scope: environment,
              global: GLOBAL_SCOPE,
              server,
              stepUp: false,
              returnPath: "/",
            }),
            complete: (asking, signal) =>
              ask === undefined
                ? Promise.reject(new Error("the Registry is not connected"))
                : Effect.runPromise(
                    readingOldWorker(
                      ask({
                        environment,
                        server,
                        ref,
                        argument: asking.argument,
                        context: { arguments: asking.context },
                      }),
                    ),
                    { signal },
                  ),
          }
        : undefined,
    // `ref` is held by `refKey`: a new object of the same ref is the same form.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [enabled, environment, server, refKey, ask],
  );
};
