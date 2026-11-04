// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off newPromise:off -- builders over plain values; the host's abort hook is Promise-based.
// The owner's side of MCP resources in the composer (`docs/architecture/mcp-in-a-session.md` → Attached resources): the
// `@` menu's listing, and the one read of an Attached resource at send. Both go to the host as the owner's own request
// (`ctx.origin: "owner"`), through the inventory the tools were last built from, and neither is a tool call:
//
// - **The listing never starts a Container.** A stdio server's pages are asked with `ctx.start: false` (only with the host's
//   `no_start` feature: without it a stdio server is a muted row), so a Container that is not running answers `stopped` and
//   nothing is woken; an HTTP server has no Container. The menu holds a listing for 30 s on the client.
// - **The read at send may start the Container** ("the owner sending a message is real activity", `mcp-connections.md` →
//   Who may start a Container): it says nothing of `start`.
// - **A read has no conversation to ask in.** It declares nothing that invites a server's own request (no `ctx.answers`, no
//   `onInput`, no `allowTask`): a Legacy server's Sampling request is refused and its Elicitation request cancelled by the
//   host, and a Modern server that asks anyway ends the read as `input_required`, which is the error line.
// - **What the server returned is `use`'s to make a message of**, inside the decode slot a large result takes, so the slot
//   is not given up before the content is cut to what the message keeps.
import {
  isJsonObject,
  type McpHostCallFailed,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestInput,
  type McpHostRequestResult,
} from "@cloudpid/mcp/types";
import {
  ATTACHED_RESOURCE_READ_MS,
  boundedText,
  MAX_MENU_PAGES,
  MAX_MENU_RESOURCES,
  MAX_RESOURCE_NAME,
  MAX_RESOURCE_URI,
  type McpMenuResource,
  type McpMenuServer,
  type McpResourceMenu,
  oneLine as flatLine,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { HostLost, McpHostClientService } from "./client.ts";
import {
  contextOf,
  MCP_CALL_SLACK_MS,
  MCP_STREAM_IDLE_MS,
  type McpCallOrigin,
  waitOf,
} from "./exchange.ts";
import { isReachable } from "./exposure.ts";
import { isAppResource } from "./resource-list.ts";
import { MCP_STREAM_SLOT_WAIT_MS, readStreamed } from "./stream.ts";
import type { McpBuildServer } from "./tools.ts";

/**
 * The host feature that takes `ctx.start: false` on a `resources/read` (`MCP_HOST_FEATURES`): a stdio server's read then
 * never starts its Container. Without it a stdio server is not read for a preview or listed for the menu.
 */
export const MCP_NO_START_FEATURE = "no_start";

/** How long the menu waits for one page of a server's list, in ms. */
const MENU_PAGE_MS = 10_000;

/** What `listResourceMenu` and `readAttachedResource` read of the Session's MCP tools. */
export type AttachedResourcesDeps = {
  readonly client: McpHostClientService;
  /** The servers of the inventory the tools were last built from. */
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly origin: McpCallOrigin;
  /** Whether the host lists `no_start`. */
  readonly noStart: boolean;
  /** How long past the server's timeout the Session waits for the host, `MCP_CALL_SLACK_MS` unless a test shortens it. */
  readonly slackMs?: number | undefined;
  /** How long a read at send may take, `ATTACHED_RESOURCE_READ_MS` unless a test shortens it. */
  readonly readMs?: number | undefined;
  /** How long a streamed result waits for the decode slot, `MCP_STREAM_SLOT_WAIT_MS` unless a test shortens it. */
  readonly slotWaitMs?: number | undefined;
};

/** A resource's content as a read gives it: a `text`, or a base64 `blob`, under the URI it has. */
export type AttachedContent = {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly blob?: string | undefined;
};

const Content = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  blob: Schema.optionalKey(Schema.String),
});

const decodeContent = Schema.decodeUnknownOption(Content);

/** The contents of a `resources/read` value that this build reads (a text or a blob each); undefined for a value that is not a read. */
export const contentsOfRead = (value: Schema.Json): ReadonlyArray<AttachedContent> | undefined => {
  if (!isJsonObject(value) || !Arr.isArray(value["contents"])) return undefined;

  return Arr.filterMap(value["contents"], (entry) => {
    const content = decodeContent(entry);

    return Option.isSome(content) &&
      (content.value.text !== undefined || content.value.blob !== undefined)
      ? Result.succeed(content.value)
      : Result.failVoid;
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// The host's request

const ownerContext = (
  deps: AttachedResourcesDeps,
  call: { readonly callId: string; readonly conversation: string },
  workspace: string | undefined,
  start: boolean,
): McpHostRequestContext => {
  const ctx: Mutable<McpHostRequestContext> = {
    ...contextOf(deps.origin, call),
    origin: "owner",
  };

  if (workspace !== undefined) ctx.workspace = workspace;

  if (!start) ctx.start = false;

  return ctx;
};

const isStdio = (server: McpBuildServer): boolean => server.server.type === "stdio";

/** A promise that resolves when `signal` aborts, and never without it. */
const abortedBy = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** What the host answers to one request, or why there is no answer. */
type Asked = Data.TaggedEnum<{
  Answered: { readonly answer: McpHostRequestResult | HostLost };
  Timeout: {};
  Cancelled: {};
}>;

const Asked = Data.taggedEnum<Asked>();

/** `input` sent to the host with a signal to abort its work, bounded by `boundMs` and the server's own timeout and slack. */
const asked = (
  deps: AttachedResourcesDeps,
  server: McpBuildServer,
  signal: AbortSignal,
  input: McpHostRequestInput,
  boundMs: number,
): Effect.Effect<Asked> => {
  // The Session giving up on the host: aborts the request the host is running.
  const lost = new AbortController();

  const hooks: McpHostRequestHooks = {
    untilAborted: () => Promise.race([abortedBy(signal), abortedBy(lost.signal)]),
  };

  return deps.client.request(input, hooks).pipe(
    Effect.map((answer): Asked => Asked.Answered({ answer })),
    Effect.timeoutOrElse({
      duration: Math.min(boundMs, waitOf(server, deps.slackMs ?? MCP_CALL_SLACK_MS)),
      orElse: () => Effect.succeed<Asked>(Asked.Timeout()),
    }),
    Effect.raceFirst(
      Effect.promise(() => abortedBy(signal)).pipe(Effect.as<Asked>(Asked.Cancelled())),
    ),
    Effect.ensuring(Effect.sync(() => lost.abort())),
  );
};

const oneLine = (text: string): string => boundedText(flatLine(text), 300);

const QUESTION = (server: string) =>
  `${server} asked a question before it would give this resource, which cannot be answered when a message is sent`;

/** Why the server's answer is no contents, in the words of an error line: what a failed `CallFailed` came to. */
const failureLine = (error: McpHostCallFailed["error"], server: string): string =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", "StepUpRequired", () => `${server} needs you signed in`),
    Match.tag("Unreachable", (each) =>
      each.stopped === true ? `${server} is not running` : oneLine(each.message),
    ),
    Match.tag("ProtocolViolation", (each) =>
      each.message.includes("input_required") ? QUESTION(server) : oneLine(each.message),
    ),
    Match.orElse((each) => oneLine(each.message)),
  );

// ---------------------------------------------------------------------------------------------------------------------
// The read at send

/** What a read at send came to. `gone` is not found or the server gone; `failed` is any other failure, in the words of the error line. */
export type AttachedReadResult<A> =
  | { readonly status: "read"; readonly value: A }
  | { readonly status: "gone"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

/** One resource to read at send, and what makes a message of its contents. */
export type AttachedReadInput<A> = {
  /** The server's configured name. */
  readonly server: string;
  readonly uri: string;
  readonly conversation: string;
  /**
   * The Workspace (`ws:<id>`) the conversation works in, where a stdio server runs; the Session's when it is none. Asked
   * only for a stdio server.
   */
  readonly workspaceOf?: Effect.Effect<string | undefined> | undefined;
  /** Aborts when Stop withdraws the message. */
  readonly signal: AbortSignal;
  /**
   * Makes what the message keeps of the contents: run once, inside the decode slot a large result takes. A failure of it
   * (a file that could not be written) is the read's `failed`.
   */
  readonly use: (contents: ReadonlyArray<AttachedContent>) => Promise<A>;
};

const gone = (message: string): AttachedReadResult<never> => ({ status: "gone", message });

const failed = (message: string): AttachedReadResult<never> => ({ status: "failed", message });

/** What `use` makes of a completed read's result, or why there is nothing to use. */
const usedBy = <A>(
  deps: AttachedResourcesDeps,
  input: AttachedReadInput<A>,
  result: Extract<McpHostRequestResult, { _tag: "Completed" }>["result"],
): Promise<AttachedReadResult<A>> => {
  const make = async (value: Schema.Json): Promise<AttachedReadResult<A>> => {
    const contents = contentsOfRead(value);

    if (contents === undefined) return failed("The server's answer to the read was not a resource");

    if (contents.length === 0) return failed("The server gave no content for it");

    try {
      return { status: "read", value: await input.use(contents) };
    } catch (error) {
      return failed(oneLine(error instanceof Error ? error.message : "It could not be kept"));
    }
  };

  if (result.kind === "inline") return make(result.value);

  return readStreamed(
    result.body,
    result.bytes,
    {
      signal: input.signal,
      idleMs: MCP_STREAM_IDLE_MS,
      waitMs: deps.slotWaitMs ?? MCP_STREAM_SLOT_WAIT_MS,
    },
    async (streamed) => {
      if (streamed.kind === "value") return make(streamed.value);

      return failed(
        Match.value(streamed).pipe(
          Match.when({ kind: "aborted" }, () => "The read was stopped"),
          Match.when({ kind: "too_large" }, () => "The resource is too large to read"),
          Match.orElse(() => "The resource could not be read"),
        ),
      );
    },
  );
};

const isNotFound = Predicate.isTagged("NotFound");

/** A read the server failed: a resource it does not have is gone, anything else is the error line. */
const failedRead = (
  error: McpHostCallFailed["error"],
  server: string,
): AttachedReadResult<never> => {
  const line = failureLine(error, server);

  return isNotFound(error) ? gone(line) : failed(line);
};

/** What the host's answer to a read at send is: `use`'s message, a gone resource, or the error line. */
const answeredWith = <A>(
  deps: AttachedResourcesDeps,
  input: AttachedReadInput<A>,
  result: McpHostRequestResult | HostLost,
): Effect.Effect<AttachedReadResult<A>> =>
  Match.value(result).pipe(
    Match.tag("Completed", (done) => Effect.promise(() => usedBy(deps, input, done.result))),
    Match.tag("CallFailed", ({ error }) => Effect.succeed(failedRead(error, input.server))),
    Match.tag("InputRequired", "PagesRequired", () =>
      Effect.succeed(failed(QUESTION(input.server))),
    ),
    Match.tag("UnknownServer", "ServerChanged", "NotAllowed", (each) =>
      Effect.succeed(gone(oneLine(each.message))),
    ),
    Match.orElse((each) =>
      Effect.succeed(
        failed("message" in each ? oneLine(each.message) : `The MCP host answered ${each._tag}`),
      ),
    ),
  );

/**
 * `input`'s resource, read once through the host as the owner's request, and made into what the message keeps by
 * `input.use`. Never fails: a server not in the inventory, off, `hidden` or without resources, and a resource the server
 * says it does not have, are `gone`; every other ending is `failed` with a line for the block.
 */
export const readAttachedResource = <A>(
  deps: AttachedResourcesDeps,
  input: AttachedReadInput<A>,
): Effect.Effect<AttachedReadResult<A>> => {
  const server = Arr.findFirst(deps.servers, (each) => each.name === input.server);

  if (Option.isNone(server)) {
    return Effect.succeed(gone(`${input.server} is no longer an MCP server of this Environment`));
  }

  if (!isReachable(server.value) || server.value.resources !== true) {
    return Effect.succeed(gone(`${input.server} is switched off or offers no resources`));
  }

  const stdio = isStdio(server.value);
  const readMs = deps.readMs ?? ATTACHED_RESOURCE_READ_MS;

  return Effect.gen(function* () {
    if (input.signal.aborted) return failed("The read was stopped");

    let workspace = deps.origin.workspace;

    if (stdio) {
      workspace =
        (input.workspaceOf === undefined ? undefined : yield* input.workspaceOf) ?? workspace;
    }

    const request: McpHostRequestInput = {
      op: "resources/read",
      server: input.server,
      params: { uri: input.uri },
      ctx: ownerContext(
        deps,
        { callId: "attached-resource", conversation: input.conversation },
        workspace,
        true,
      ),
    };

    const answer = yield* asked(deps, server.value, input.signal, request, readMs);

    return yield* Match.value(answer).pipe(
      Match.tag("Cancelled", () => Effect.succeed(failed("The read was stopped"))),
      Match.tag("Timeout", () =>
        Effect.succeed(failed(`${input.server} did not answer in ${String(readMs / 1000)} s`)),
      ),
      Match.tag("Answered", ({ answer: result }) => answeredWith(deps, input, result)),
      Match.exhaustive,
    );
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// The menu's listing

const ListedResource = Schema.Struct({
  uri: Schema.String,
  name: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Finite),
});

const decodeListed = Schema.decodeUnknownOption(ListedResource);

const decodePage = Schema.decodeUnknownOption(
  Schema.Struct({
    resources: Schema.Json.pipe(Schema.Array, Schema.optionalKey),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
);

/** The longest description a menu row keeps, in characters. */
const MAX_MENU_DESCRIPTION = 300;

const oneLineOf = (text: string, max: number): string => flatLine(boundedText(text, max));

/** What the menu keeps of a listed resource: bounded and cleaned, or nothing for an App's or one with no usable URI. */
const menuResourceOf = (entry: Schema.Json): ReadonlyArray<McpMenuResource> => {
  const listed = decodeListed(entry);

  if (Option.isNone(listed)) return [];

  const { uri, mimeType } = listed.value;

  if (uri === "" || uri.length > MAX_RESOURCE_URI || isAppResource(uri, mimeType)) return [];

  const resource: Mutable<McpMenuResource> = {
    uri,
    name: oneLineOf(listed.value.name ?? listed.value.title ?? uri, MAX_RESOURCE_NAME),
  };

  if (listed.value.title !== undefined) {
    resource.title = oneLineOf(listed.value.title, MAX_RESOURCE_NAME);
  }

  if (listed.value.description !== undefined) {
    resource.description = oneLineOf(listed.value.description, MAX_MENU_DESCRIPTION);
  }

  if (mimeType !== undefined) resource.mimeType = oneLineOf(mimeType, 100);

  if (listed.value.size !== undefined && listed.value.size >= 0) {
    resource.size = Math.trunc(listed.value.size);
  }

  return [resource];
};

/** Where a server's definition is, as the menu names it: `owner`, or `repo:<owner/repo>`. */
const sourceOf = (server: McpBuildServer): string =>
  server.source?.kind === "repo" && server.source.slug !== undefined
    ? `repo:${server.source.slug}`
    : "owner";

/** The state a menu row is muted for when the build says its server is not up yet: connecting, signing in, or neither. */
const stateRow = (state: string): string => {
  if (state === "sign_in" || state === "rejected") return "sign_in";

  return state === "not_discovered" || state === "connecting" ? "connecting" : "unavailable";
};

/** What a failed list page makes of a server's menu row. */
const failedState = (answer: Asked): string =>
  Match.value(answer).pipe(
    Match.tag("Answered", ({ answer: result }) =>
      Match.value(result).pipe(
        Match.tag("CallFailed", ({ error }) =>
          Match.value(error).pipe(
            Match.tag("SignInRequired", "StepUpRequired", () => "sign_in"),
            Match.tag("Unreachable", (each) => (each.stopped === true ? "stopped" : "unavailable")),
            Match.orElse(() => "unavailable"),
          ),
        ),
        Match.orElse(() => "unavailable"),
      ),
    ),
    Match.orElse(() => "unavailable"),
  );

/** The result of a page the host answered, or none for any other ending. */
const completedOf = (answer: Asked) =>
  Match.value(answer).pipe(
    Match.tag("Answered", ({ answer: result }) =>
      Match.value(result).pipe(
        Match.tag("Completed", (done) => Option.some(done.result)),
        Match.orElse(() => Option.none()),
      ),
    ),
    Match.orElse(() => Option.none()),
  );

/** One server's resources, page by page: what the menu lists, bounded, or the state it is muted for. */
const listServer = (
  deps: AttachedResourcesDeps,
  server: McpBuildServer,
  conversation: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Effect.Effect<McpMenuServer> =>
  Effect.gen(function* () {
    const stdio = isStdio(server);
    const base = { server: server.name, source: sourceOf(server) };
    const muted = (state: string): McpMenuServer => ({ ...base, state, resources: [] });

    // A host that would drop `ctx.start` starts the Container: a stdio server is not listed through one.
    if (stdio && !deps.noStart) return muted("unavailable");

    const resources: Array<McpMenuResource> = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_MENU_PAGES && !truncated; page++) {
      const request: McpHostRequestInput = {
        op: "resources/list",
        server: server.name,
        params: cursor === undefined ? {} : { cursor },
        ctx: ownerContext(deps, { callId: "resource-menu", conversation }, workspace, !stdio),
      };

      const answer = yield* asked(deps, server, signal, request, MENU_PAGE_MS);
      const completed = completedOf(answer);

      // What was listed before the page that failed stays; a first page that fails mutes the row.
      if (Option.isNone(completed)) {
        if (resources.length === 0) return muted(failedState(answer));

        truncated = true;
        break;
      }

      const { value: result } = completed;

      // A page of a large list comes as a stream the menu does not read: the listing stops at what it has.
      if (result.kind !== "inline") {
        void result.body.cancel().catch(() => undefined);

        if (resources.length === 0) return muted("unavailable");

        truncated = true;
        break;
      }

      const read = decodePage(result.value);

      if (Option.isNone(read)) {
        if (resources.length === 0) return muted("unavailable");

        truncated = true;
        break;
      }

      for (const entry of read.value.resources ?? []) {
        if (resources.length >= MAX_MENU_RESOURCES) {
          truncated = true;
          break;
        }

        resources.push(...menuResourceOf(entry));
      }

      cursor = read.value.nextCursor;

      if (cursor === undefined || cursor === "") break;

      if (page === MAX_MENU_PAGES - 1) truncated = true;
    }

    return truncated
      ? { ...base, state: "ok", resources, truncated }
      : { ...base, state: "ok", resources };
  });

/** What the menu is listing for. */
export type ResourceMenuInput = {
  readonly conversation: string;
  /** The Workspace (`ws:<id>`) the conversation works in, asked only when a stdio server is listed. */
  readonly workspaceOf?: Effect.Effect<string | undefined> | undefined;
  readonly signal: AbortSignal;
};

/**
 * The `@` menu's resources: for each server the resource tools reach (enabled, not `hidden`, with resources) its listed
 * resources, or the state its row is muted for; and a muted row for a server that is not discovered yet. Never fails, and
 * never starts a Container (`ctx.start: false` for a stdio server's pages).
 */
export const listResourceMenu = (
  deps: AttachedResourcesDeps,
  input: ResourceMenuInput,
): Effect.Effect<McpResourceMenu> => {
  const reachable = Arr.filter(deps.servers, isReachable);

  return Effect.gen(function* () {
    const { workspace } = deps.origin;

    const stdioWorkspace = Arr.some(reachable, isStdio)
      ? ((input.workspaceOf === undefined ? undefined : yield* input.workspaceOf) ?? workspace)
      : workspace;

    const servers = yield* Effect.forEach(
      reachable,
      (server): Effect.Effect<McpMenuServer | undefined> => {
        if (server.resources === true) {
          return listServer(
            deps,
            server,
            input.conversation,
            isStdio(server) ? stdioWorkspace : workspace,
            input.signal,
          );
        }

        // Not discovered yet, or signing in: the row says so. A server discovered with no resources has no row.
        return Effect.succeed(
          server.discoveredAt === undefined
            ? {
                server: server.name,
                source: sourceOf(server),
                state: stateRow(server.state),
                resources: [],
              }
            : undefined,
        );
      },
      { concurrency: 4 },
    );

    return { servers: Arr.filter(servers, (each): each is McpMenuServer => each !== undefined) };
  });
};
