// The owner's completion of an argument in the composer's form (`docs/architecture/mcp-in-a-session.md` → Arguments and
// completions): the Session's check against the inventory the tools were last built from, then
// `McpHost.request({ op: "completion/complete" })` with `ctx.origin: "owner"` and the conversation's own Workspace, and the
// host's answer as the form is told it. Completion is UI-only: the model gets no tool for it, and nothing is stored.
//
// - **Never asked of a server that does not declare `completions`,** nor through a host that does not list the `completions`
//   feature: the answer is `unsupported` and nothing is sent (`mcp.md` → Deploys).
// - **Never starts a Container.** A stdio server whose Container is not running answers `not_running`; the host starts none
//   for this op whatever the context says.
// - **Declares nothing that invites a server's own request:** no `ctx.answers`, no `onInput`, no `allowTask`. A Sampling or
//   Elicitation request during a completion is refused: it has no conversation to ask in.
// - **Bounded at 5 s** (`MCP_COMPLETION_TIMEOUT_MS`, and the host's own bound) and never sent again; the abort of the caller
//   (`signal`: a newer keystroke, the form closed, the socket gone) cancels the request at the server.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off newPromise:off -- builders over plain values; the host's abort hook is Promise-based.
import {
  isJsonObject,
  MCP_COMPLETION_TIMEOUT_MS,
  type McpHostCallFailed,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
} from "@cloudpid/mcp/types";
import {
  completionValues,
  MCP_COMPLETION_STATUS,
  type McpCompletionArgument,
  type McpCompletionContext,
  type McpCompletionRef,
  type McpCompletion,
  noCompletion,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./client.ts";
import { contextOf, MCP_CALL_SLACK_MS, type McpCallOrigin } from "./exchange.ts";
import { isReachable } from "./exposure.ts";
import type { McpBuildServer } from "./tools.ts";

/** The host feature that answers `request({ op: "completion/complete" })` (`MCP_HOST_FEATURES`). */
export const MCP_COMPLETIONS_FEATURE = "completions";

/** What a completion is for. */
export type McpCompletionInput = {
  /** The server's configured name. */
  readonly server: string;
  readonly ref: McpCompletionRef;
  readonly argument: McpCompletionArgument;
  readonly context?: McpCompletionContext | undefined;
  readonly conversation: string;
  /** The Workspace (`ws:<id>`) the conversation works in, where a stdio server runs; the Session's when it is none. Asked only for a stdio server. */
  readonly workspaceOf?: Effect.Effect<string | undefined> | undefined;
  /** Aborts when the form asks for another value, closes, or the socket goes. */
  readonly signal: AbortSignal;
};

/** What `completionOf` reads of the Session's MCP tools. */
export type McpCompletionDeps = {
  readonly client: McpHostClientService;
  /** The servers of the inventory the tools were last built from. */
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly origin: McpCallOrigin;
  /** Whether the host lists `completions`. */
  readonly supported: boolean;
  /** How long past the host's own bound the Session waits for it, `MCP_CALL_SLACK_MS` unless a test shortens it. */
  readonly slackMs?: number | undefined;
};

/** A promise that resolves when `signal` aborts, and never otherwise. */
const abortedBy = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** What the form is told of a request that failed. */
const failedWith = (error: McpHostCallFailed["error"]): McpCompletion =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", "StepUpRequired", () => noCompletion(MCP_COMPLETION_STATUS.signIn)),
    Match.tag("Unreachable", (each) =>
      noCompletion(
        each.stopped === true ? MCP_COMPLETION_STATUS.notRunning : MCP_COMPLETION_STATUS.failed,
      ),
    ),
    Match.tag("Unsupported", () => noCompletion(MCP_COMPLETION_STATUS.unsupported)),
    Match.orElse(() => noCompletion(MCP_COMPLETION_STATUS.failed)),
  );

/** The form's answer for what the host answered (the Registry answers the draft composer's through it too). */
export const completionAnswerOf = (answer: McpHostRequestResult | HostLost): McpCompletion =>
  Match.value(answer).pipe(
    Match.tag("Completed", (done) => {
      const { result } = done;

      // A completion is small: a stream is a server answering with something that is no completion.
      if (result.kind !== "inline") {
        void result.body.cancel().catch(() => undefined);

        return noCompletion(MCP_COMPLETION_STATUS.failed);
      }

      const completion = isJsonObject(result.value) ? result.value["completion"] : undefined;

      return isJsonObject(completion)
        ? completionValues(completion)
        : noCompletion(MCP_COMPLETION_STATUS.failed);
    }),
    Match.tag("CallFailed", (failed) => failedWith(failed.error)),
    // A host from before the op: it does not know it.
    Match.tag("HostUnsupported", () => noCompletion(MCP_COMPLETION_STATUS.unsupported)),
    Match.orElse(() => noCompletion(MCP_COMPLETION_STATUS.failed)),
  );

/** The host request for `input`: the owner's, which starts no Container, and declares nothing a server could ask a question with. */
const requestOf = (
  deps: McpCompletionDeps,
  input: McpCompletionInput,
  workspace: string | undefined,
): McpHostRequestInput => {
  const ctx: Mutable<McpHostRequestContext> = {
    ...contextOf(deps.origin, { callId: "completion", conversation: input.conversation }),
    origin: "owner",
    start: false,
  };

  if (workspace !== undefined) ctx.workspace = workspace;

  const params: Mutable<
    Extract<McpHostRequestInput, { readonly op: "completion/complete" }>["params"]
  > = {
    ref: input.ref,
    argument: input.argument,
  };

  if (input.context !== undefined) params.context = { arguments: { ...input.context.arguments } };

  return { op: "completion/complete", server: input.server, params, ctx };
};

/**
 * `input`, completed by its server and answered as the form is told it: the suggestions, or why there are none. Never
 * fails: a cancelled completion answers `failed` whatever the host does (nothing reads it), and a host that does not
 * answer within its bound and the slack is `failed`.
 */
export const completionOf = (
  deps: McpCompletionDeps,
  input: McpCompletionInput,
): Effect.Effect<McpCompletion> => {
  const server = Arr.findFirst(deps.servers, (each) => each.name === input.server);

  // A server that is switched off, `hidden` or not in the set has no form to complete for; nothing is sent.
  if (Option.isNone(server) || !isReachable(server.value)) {
    return Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.unsupported));
  }

  // Not declared, or a host that would answer `HostUnsupported`: the server is never asked.
  if (server.value.completions !== true || !deps.supported) {
    return Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.unsupported));
  }

  const stdio = server.value.server.type === "stdio";
  const cancelled = noCompletion(MCP_COMPLETION_STATUS.failed);

  // The Session giving up on the host: aborts the request the host is running.
  const lost = new AbortController();

  return Effect.gen(function* () {
    if (input.signal.aborted) return cancelled;

    let workspace = deps.origin.workspace;

    if (stdio) {
      workspace =
        (input.workspaceOf === undefined ? undefined : yield* input.workspaceOf) ??
        deps.origin.workspace;

      if (workspace === undefined) return cancelled;
    }

    const hooks: McpHostRequestHooks = {
      untilAborted: () => Promise.race([abortedBy(input.signal), abortedBy(lost.signal)]),
    };

    const asked = deps.client
      .request(requestOf(deps, input, workspace), hooks)
      .pipe(Effect.map(completionAnswerOf));

    const answer = yield* asked.pipe(
      Effect.raceFirst(Effect.promise(() => abortedBy(input.signal)).pipe(Effect.as(cancelled))),
      Effect.raceFirst(
        Effect.sleep(MCP_COMPLETION_TIMEOUT_MS + (deps.slackMs ?? MCP_CALL_SLACK_MS)).pipe(
          Effect.tap(() => Effect.sync(() => lost.abort())),
          Effect.as(cancelled),
        ),
      ),
      Effect.ensuring(Effect.sync(() => lost.abort())),
    );

    return input.signal.aborted ? cancelled : answer;
  });
};
