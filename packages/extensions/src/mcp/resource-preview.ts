// The owner's read of a resource a tool call's card links (`docs/architecture/mcp-in-a-session.md` → Resource links and
// embedded resources): the Session's check against its inventory, then `McpHost.request({ op: "resources/read" })` with
// `ctx.origin: "owner"` and, for a stdio server, `ctx.start: false`, and the host's answer as the card is given it.
//
// - **Never starts a Container:** a stdio server's read says `start: false`, so a Container that is not running answers
//   `stopped` and nothing is woken; a host that does not list `no_start` would drop the key and start it, so a stdio
//   server is not read at all through one (`host_unsupported`). An HTTP server has no Container.
// - **Declares nothing that invites a server's own request:** no `ctx.answers`, no `onInput`, no `allowTask`: a read that
//   needs a question answered is `input_required`, and the card says to open the resource in a conversation.
// - **Never reaches the model:** the contents go to the card as the server sent them, the owner's own view; nothing is
//   written into any conversation or kept.
// - **As large as any result:** up to 16 MiB (`MAX_MCP_RESOURCE_PREVIEW_BYTES`), a result over 1 MiB read from its stream as
//   a call's is, and one whose JSON would pass the socket's message limit is `too_large`, never cut.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off newPromise:off -- builders over plain values; the host's abort hook is Promise-based.
import {
  isJsonObject,
  MCP_URL_REQUIRED_CODE,
  MiB,
  type McpHostCallFailed,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
} from "@cloudpid/mcp/types";
import {
  base64Bytes,
  MAX_MCP_RESOURCE_PREVIEW_BYTES,
  McpResourceContent,
  type McpResourcePreviewAnswer,
  resourceUnavailable,
} from "@cloudpid/protocol";
import { utf8ByteLength } from "@earendil-works/chord/output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./client.ts";
import {
  type McpCallOrigin,
  contextOf,
  MCP_CALL_SLACK_MS,
  MCP_STREAM_IDLE_MS,
  waitOf,
} from "./exchange.ts";
import { isReachable } from "./exposure.ts";
import { PREVIEW_SLOT_OVER, readStreamed, type Streamed, type StreamLimits } from "./stream.ts";
import type { McpBuildServer } from "./tools.ts";

/** What a preview is for: the server and URI of a link on the card of a call in `conversation`. */
export type McpResourcePreviewInput = {
  /** The server's configured name: the call's `details.server`. */
  readonly server: string;
  readonly uri: string;
  readonly conversation: string;
  /**
   * The Workspace (`ws:<id>`) the conversation works in, where a stdio server runs; the Session's when it is none. Asked
   * only for a stdio server.
   */
  readonly workspaceOf?: Effect.Effect<string | undefined> | undefined;
  /** Aborts when the owner closes the preview, or the socket goes. */
  readonly signal: AbortSignal;
  /**
   * Takes the isolate's one decode slot for a result over `PREVIEW_SLOT_OVER`, which the Session holds until the answer is
   * sent (`takeDecodeSlot`): without it the slot is held only while the result is read and decoded, and the answer's own
   * copies (its JSON, the socket's) are made after it is given up. Absent: `readStreamed` takes it itself.
   */
  readonly holdSlot?: Effect.Effect<"held" | "aborted" | "waited"> | undefined;
};

/** What `resourcePreviewOf` reads of the Session's MCP tools. */
export type McpResourcePreviewDeps = {
  readonly client: McpHostClientService;
  /** The servers of the inventory the tools were last built from. */
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly origin: McpCallOrigin;
  /** Whether the host lists `no_start`. */
  readonly noStart: boolean;
  /** How long past the server's timeout the Session waits for the host, `MCP_CALL_SLACK_MS` unless a test shortens it. */
  readonly slackMs?: number | undefined;
  /** How long a result's stream may be quiet, and wait for the decode slot: as a call's (`MCP_STREAM_IDLE_MS`) unless a test shortens them. */
  readonly streamIdleMs?: number | undefined;
  readonly streamWaitMs?: number | undefined;
};

/** A promise that resolves when `signal` aborts, and never otherwise. */
const abortedBy = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const decodeContents = Schema.decodeUnknownOption(Schema.Array(McpResourceContent));

/** What a preview's contents weigh: a text's UTF-8 bytes and a blob's decoded ones. */
const weightOf = (contents: ReadonlyArray<McpResourceContent>): number =>
  Arr.reduce(
    contents,
    0,
    (sum, each) =>
      sum +
      (each.text === undefined ? 0 : utf8ByteLength(each.text)) +
      (each.blob === undefined ? 0 : base64Bytes(each.blob)),
  );

/**
 * The most bytes the JSON of an answer may be on the socket: under the 32 MiB a WebSocket message carries, with room for the
 * answer's envelope. Escapes make JSON longer than the text it holds, so the weight alone does not bound it.
 */
export const MAX_MCP_RESOURCE_ANSWER_BYTES = 28 * 1024 * 1024;

const tooLarge = resourceUnavailable(
  "too_large",
  `The resource is over ${MAX_MCP_RESOURCE_PREVIEW_BYTES / 1024 / 1024} MiB, more than a preview carries`,
);

const askedAQuestion = (server: string) =>
  resourceUnavailable(
    "input_required",
    `${server} asks a question before it gives this resource: open it in a conversation`,
  );

/** The bytes JSON adds to `text` as a string: a backslash for a quote, a backslash and a letter for a control, and `\uXXXX` for the rest of them and a lone surrogate. */
const escapeBytes = (text: string): number => {
  let extra = 0;

  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);

    if (code === 0x22 || code === 0x5c) extra += 1;
    else if (code < 0x20)
      extra += code === 8 || (code >= 9 && code <= 10) || code === 12 || code === 13 ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(at + 1);

      // A pair is two characters of three bytes each in UTF-8 and one of four: written whole. A lone half is escaped.
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) at += 1;
      else extra += 3;
    }
  }

  return extra;
};

/** The bytes the JSON of `contents` is, counted without making it: its texts' UTF-8 bytes and escapes, its blobs' base64. */
export const jsonBytesOf = (contents: ReadonlyArray<McpResourceContent>): number =>
  Arr.reduce(
    contents,
    0,
    (sum, each) =>
      sum +
      utf8ByteLength(each.uri) +
      (each.mimeType === undefined ? 0 : utf8ByteLength(each.mimeType)) +
      (each.text === undefined ? 0 : utf8ByteLength(each.text) + escapeBytes(each.text)) +
      (each.blob === undefined ? 0 : each.blob.length),
  );

/** The answer for the `value` of a read's result: the contents it holds, if they fit what the socket carries. */
const answerOfValue = (value: Schema.Json | undefined): McpResourcePreviewAnswer => {
  const contents = isJsonObject(value) ? decodeContents(value["contents"]) : Option.none();

  if (Option.isNone(contents)) {
    return resourceUnavailable("failed", "The server's answer to the read was not a resource");
  }

  if (weightOf(contents.value) > MAX_MCP_RESOURCE_PREVIEW_BYTES) return tooLarge;

  // Only a large answer is measured: a small one cannot pass the socket's limit.
  if (
    weightOf(contents.value) > MiB &&
    jsonBytesOf(contents.value) > MAX_MCP_RESOURCE_ANSWER_BYTES
  ) {
    return tooLarge;
  }

  return { status: "contents", contents: contents.value };
};

/** What reading a result's stream (a result over 1 MiB, up to 16 MiB of it) came to, as the card is told it. */
const answerOfStream = (streamed: Streamed): McpResourcePreviewAnswer => {
  switch (streamed.kind) {
    case "value":
      return answerOfValue(streamed.value);
    case "too_large":
      return tooLarge;
    case "aborted":
      return resourceUnavailable("cancelled", "The read was cancelled");
    case "waited":
      return resourceUnavailable(
        "failed",
        "Other large results were being read: try the preview again in a moment",
      );
    case "lost":
    case "unreadable":
      return resourceUnavailable("failed", "The result of the read was lost on its way");
  }
};

/**
 * The preview's answer for a read's completed `result`: a result over 1 MiB is read from its stream, as a call's is, and one
 * over `PREVIEW_SLOT_OVER` under the isolate's decode slot, which the Session holds through the send when it can (`holdSlot`).
 */
const contentsOf = (
  result: Extract<McpHostRequestResult, { _tag: "Completed" }>["result"],
  deps: McpResourcePreviewDeps,
  input: McpResourcePreviewInput,
): Effect.Effect<McpResourcePreviewAnswer> => {
  if (result.kind !== "stream") return Effect.succeed(answerOfValue(result.value));

  const limits: Mutable<StreamLimits> = {
    signal: input.signal,
    idleMs: deps.streamIdleMs ?? MCP_STREAM_IDLE_MS,
  };

  if (deps.streamWaitMs !== undefined) limits.waitMs = deps.streamWaitMs;

  const read = () =>
    Effect.promise(() =>
      readStreamed(result.body, result.bytes, limits, async (streamed) => answerOfStream(streamed)),
    );

  if (result.bytes <= PREVIEW_SLOT_OVER || input.holdSlot === undefined) return read();

  return input.holdSlot.pipe(
    Effect.flatMap((taken) => {
      if (taken === "held") {
        limits.slotHeld = true;

        return read();
      }

      // Stopped, or too long in line: the stream is let go unread.
      return Effect.promise(() => result.body.cancel().catch(() => undefined)).pipe(
        Effect.as(answerOfStream({ kind: taken })),
      );
    }),
  );
};

/** What the owner is told of a read that failed. */
const failedWith = (error: McpHostCallFailed["error"], server: string) =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", "StepUpRequired", () =>
      resourceUnavailable("sign_in", `MCP server ${server} needs you signed in`),
    ),
    Match.tag("Unreachable", (each) =>
      each.stopped === true
        ? resourceUnavailable(
            "stopped",
            `${server} runs in a Container that is not running, and opening a preview never starts it`,
          )
        : resourceUnavailable("unavailable", each.message),
    ),
    // A Legacy server's "URL elicitation required": it wants the owner at a page first.
    Match.tag("ServerError", (each) =>
      each.code === MCP_URL_REQUIRED_CODE
        ? askedAQuestion(server)
        : resourceUnavailable("failed", each.message),
    ),
    Match.orElse((each) => resourceUnavailable("failed", each.message)),
  );

/** The card's answer for what the host answered. */
const answerOf = (
  answer: McpHostRequestResult | HostLost,
  server: string,
  deps: McpResourcePreviewDeps,
  input: McpResourcePreviewInput,
): Effect.Effect<McpResourcePreviewAnswer> =>
  Match.value(answer).pipe(
    Match.tag("Completed", (done) => contentsOf(done.result, deps, input)),
    Match.tag("CallFailed", (failed) => Effect.succeed(failedWith(failed.error, server))),
    Match.tag("InputRequired", "PagesRequired", () => Effect.succeed(askedAQuestion(server))),
    Match.tag("UnknownServer", "ServerChanged", "NotAllowed", (each) =>
      Effect.succeed(resourceUnavailable("unavailable", each.message)),
    ),
    Match.orElse((each) =>
      Effect.succeed(
        resourceUnavailable(
          "failed",
          "message" in each ? each.message : `The MCP host answered ${each._tag}`,
        ),
      ),
    ),
  );

/** The host request for `input`: the owner's read, which starts no Container. */
const requestOf = (
  deps: McpResourcePreviewDeps,
  input: McpResourcePreviewInput,
  stdio: boolean,
  workspace: string | undefined,
): McpHostRequestInput => {
  const ctx: Mutable<McpHostRequestContext> = {
    ...contextOf(deps.origin, { callId: "resource-preview", conversation: input.conversation }),
    origin: "owner",
  };

  if (workspace !== undefined) ctx.workspace = workspace;

  if (stdio) ctx.start = false;

  return { op: "resources/read", server: input.server, params: { uri: input.uri }, ctx };
};

/**
 * `input`, read by the owner's preview and answered as the card is: the contents, or why there are none. Never fails: a
 * cancelled read answers `cancelled` whatever the host does, and a host that does not answer within the server's timeout
 * and the slack is `failed`.
 */
export const resourcePreviewOf = (
  deps: McpResourcePreviewDeps,
  input: McpResourcePreviewInput,
): Effect.Effect<McpResourcePreviewAnswer> => {
  const server = Arr.findFirst(deps.servers, (each) => each.name === input.server);

  if (Option.isNone(server)) {
    return Effect.succeed(
      resourceUnavailable("unavailable", `No MCP server ${input.server} in this Environment`),
    );
  }

  if (!isReachable(server.value)) {
    return Effect.succeed(
      resourceUnavailable("hidden", `MCP server ${input.server} is switched off or hidden`),
    );
  }

  const stdio = server.value.server.type === "stdio";

  // A host that would drop `ctx.start` starts the Container: a stdio server is not read through one.
  if (stdio && !deps.noStart) {
    return Effect.succeed(
      resourceUnavailable(
        "host_unsupported",
        "This Session's MCP host cannot read a stdio server without starting its Container yet",
      ),
    );
  }

  const cancelled = resourceUnavailable("cancelled", "The read was cancelled");

  // The Session giving up on the host: aborts the request the host is running.
  const lost = new AbortController();

  return Effect.gen(function* () {
    if (input.signal.aborted) return cancelled;

    let workspace = deps.origin.workspace;

    if (stdio) {
      workspace =
        (input.workspaceOf === undefined ? undefined : yield* input.workspaceOf) ??
        deps.origin.workspace;

      if (workspace === undefined) {
        return resourceUnavailable(
          "unavailable",
          "This server runs in a Workspace, and none is known",
        );
      }
    }

    const hooks: McpHostRequestHooks = {
      untilAborted: () => Promise.race([abortedBy(input.signal), abortedBy(lost.signal)]),
    };

    const asked = deps.client
      .request(requestOf(deps, input, stdio, workspace), hooks)
      .pipe(Effect.flatMap((answer) => answerOf(answer, input.server, deps, input)));

    const answer = yield* asked.pipe(
      Effect.raceFirst(Effect.promise(() => abortedBy(input.signal)).pipe(Effect.as(cancelled))),
      Effect.raceFirst(
        Effect.sleep(waitOf(server.value, deps.slackMs ?? MCP_CALL_SLACK_MS)).pipe(
          Effect.tap(() => Effect.sync(() => lost.abort())),
          Effect.as(resourceUnavailable("failed", "The MCP host did not answer in time")),
        ),
      ),
      Effect.ensuring(Effect.sync(() => lost.abort())),
    );

    return input.signal.aborted ? cancelled : answer;
  });
};
