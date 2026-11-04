// An App View's request to its own server (`docs/architecture/mcp-apps.md` → An App View's calls): the Session's check
// against its inventory, then `McpHost.request` with `ctx.origin: "app"`, and the host's answer as the View is answered.
//
// - **Allowed:** a `tools/call` of a tool of the server's inventory whose `_meta.ui.visibility` includes `app`, and a
//   `resources/read`, on a server that is not switched off and whose Exposure is not `hidden`. The host checks the same
//   again (`NotAllowed`), and that the server is still the one the call's record names (`ctx.viewHash`).
// - **Declares nothing that invites a server's own request:** the request has no `ctx.answers` and no `allowTask`, and
//   no `onInput` hook, so a server's elicitation or sampling request on it is cancelled or refused, and no MCP task is
//   offered, until [#498](https://github.com/ian-pascoe/cloudpid/issues/498) builds them.
// - **Never reaches the model:** the result goes back to the View as the server sent it (the store redacts the Secrets
//   held); nothing is written into any conversation.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off newPromise:off -- builders over plain values; the host's abort hook is Promise-based.
import {
  isJsonObject,
  type JsonObject,
  type McpHostCallFailed,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
  visibilityOfMeta,
} from "@cloudpid/mcp/types";
import {
  MCP_APP_INTERNAL_ERROR,
  mcpAppError,
  type McpAppReason,
  type McpAppRequestAnswer,
  type McpAppRequestError,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./client.ts";
import { type McpCallOrigin, contextOf, MCP_CALL_SLACK_MS, waitOf } from "./exchange.ts";
import { isReachable } from "./exposure.ts";
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
  /** Aborts when the View cancels the request, or its page goes. */
  readonly signal: AbortSignal;
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
};

const failure: (reason: McpAppReason, message: string, code?: number) => McpAppRequestError =
  mcpAppError;

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
    return Option.some(failure("unavailable", `No MCP server ${input.server} in this Environment`));
  }

  if (!isReachable(server.value)) {
    return Option.some(failure("hidden", `MCP server ${input.server} is switched off or hidden`));
  }

  if (input.method !== "tools/call") return Option.none();

  const tool = Arr.findFirst(listedTools(server.value), (each) => each.name === input.name);

  if (Option.isNone(tool)) {
    return Option.some(
      failure("refused", `MCP server ${input.server} lists no tool ${input.name}`),
    );
  }

  return visibilityOfMeta(tool.value._meta).includes("app")
    ? Option.none()
    : Option.some(
        failure("refused", `Tool ${input.name} of MCP server ${input.server} is not for App Views`),
      );
};

/** What the host answers a request with. */
type HostAnswer = McpHostRequestResult | HostLost;

/** What the View is answered for the error `error` of its request to `server`. */
const failedWith = (error: McpHostCallFailed["error"], server: string): McpAppRequestError =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", () => ({
      ...failure("sign_in", `MCP server ${server} needs you signed in`),
      server,
    })),
    Match.tag("StepUpRequired", () => ({
      ...failure("sign_in", `MCP server ${server} needs you signed in with more access`),
      server,
      stepUp: true,
    })),
    Match.tag("Unreachable", (each) => failure("unavailable", each.message)),
    Match.tag("ServerError", (each) =>
      failure("failed", each.message, each.code ?? MCP_APP_INTERNAL_ERROR),
    ),
    Match.tag("NotFound", (each) => failure("failed", each.message, each.code)),
    Match.orElse((each) => failure("failed", each.message, MCP_APP_INTERNAL_ERROR)),
  );

/** The App View's answer for what the host answered. */
const answerOf = (answer: HostAnswer, server: string): Effect.Effect<McpAppRequestAnswer> =>
  Match.value(answer).pipe(
    Match.tag("Completed", (done): Effect.Effect<McpAppRequestAnswer> => {
      const { result } = done;

      if (result.kind === "stream") {
        // Over 1 MiB: more than a socket message carries, and more than a View is given.
        return Effect.promise(() => result.body.cancel().catch(() => undefined)).pipe(
          Effect.as(
            failure(
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
          : failure("failed", "The server's result is not an object", MCP_APP_INTERNAL_ERROR),
      );
    }),
    Match.tag("CallFailed", (failed) => Effect.succeed(failedWith(failed.error, server))),
    Match.tag("UnknownServer", "ServerChanged", (each) =>
      Effect.succeed(failure("unavailable", each.message)),
    ),
    Match.tag("NotAllowed", (each) => Effect.succeed(failure("refused", each.message))),
    Match.tag("HostUnsupported", "HostFailed", "HostLost", (each) =>
      Effect.succeed(failure("failed", each.message, MCP_APP_INTERNAL_ERROR)),
    ),
    Match.orElse((each) =>
      Effect.succeed(
        failure(
          "failed",
          `The MCP host answered ${each._tag}, which an App View's request never asks for`,
          MCP_APP_INTERNAL_ERROR,
        ),
      ),
    ),
  );

/** The host request for `input`, as an App View's: no `answers`, no `allowTask`. */
const requestOf = (
  deps: McpAppRequestDeps,
  input: McpAppRequestInput,
  workspace: string | undefined,
): McpHostRequestInput => {
  const ctx: Mutable<McpHostRequestContext> = {
    ...contextOf(deps.origin, { callId: input.callId, conversation: input.conversation }),
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

/**
 * `input`, sent to its server as an `app` request, and answered as the View is: the result, or the error with why. Never
 * fails: a cancelled request answers `cancelled` whatever the host does, and a host that does not answer within the
 * server's timeout and the slack is `failed`.
 */
export const appRequestOf = (
  deps: McpAppRequestDeps,
  input: McpAppRequestInput,
): Effect.Effect<McpAppRequestAnswer> => {
  const server = Arr.findFirst(deps.servers, (each) => each.name === input.server);
  const refused = refusalOf(server, input);

  if (Option.isSome(refused) || Option.isNone(server)) {
    return Effect.succeed(
      Option.getOrElse(refused, () => failure("unavailable", "No such server")),
    );
  }

  const cancelled = failure("cancelled", "The request was cancelled");

  // The Session giving up on the host: aborts the request the host is running.
  const lost = new AbortController();

  return Effect.gen(function* () {
    if (input.signal.aborted) return cancelled;

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
        return failure(
          "unavailable",
          "The Workspace this server runs in did not answer; the request was not sent",
        );
      }
    }

    const hooks: McpHostRequestHooks = {
      // The View cancels, its page goes, or the Session gives up on the host: the host cancels the request.
      untilAborted: () => Promise.race([abortedBy(input.signal), abortedBy(lost.signal)]),
    };

    const asked = deps.client
      .request(requestOf(deps, input, workspace), hooks)
      .pipe(Effect.flatMap((answer) => answerOf(answer, input.server)));

    const answer = yield* asked.pipe(
      Effect.raceFirst(Effect.promise(() => abortedBy(input.signal)).pipe(Effect.as(cancelled))),
      Effect.raceFirst(
        Effect.sleep(waitOf(server.value, deps.slackMs ?? MCP_CALL_SLACK_MS)).pipe(
          Effect.tap(() => Effect.sync(() => lost.abort())),
          Effect.as(
            failure("failed", "The MCP host did not answer in time", MCP_APP_INTERNAL_ERROR),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => lost.abort())),
    );

    // A request cancelled while the host answered it is cancelled all the same: the View has stopped waiting.
    return input.signal.aborted ? cancelled : answer;
  });
};
