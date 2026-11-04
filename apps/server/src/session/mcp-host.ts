// The Session's side of its Environment's `McpHost` (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension).
// (The `/mcp` endpoint's side of the Session is `./mcp.ts`.)
//
// - **`mcpHostClient`** is the live adapter of `McpHostClient`: the calls to the host object over Durable Object RPC
//   (`docs/architecture/mcp-connections.md` → RPC). Every answer is read with the shared readers, so one this build
//   cannot read is `HostFailed`; a `requestStart` or `servers` call that fails is `HostFailed` too, and a `request` whose
//   RPC breaks is `HostLost`, which a `tools/call` reads as maybe run. What failed is logged, never told the model.
// - **`kvMcpToolsStore`** keeps what the installed MCP tools were built from in the Session's storage, so an object that
//   starts again installs the very same tools before anything resumes, and each conversation's last opened Context
//   Window, so `windowOpened` is sent once per window across evictions.
// - **`sessionMcp`** is the Session host's `mcp` option (`SessionHostMcp`): `McpTools` for the Session's Environment, its
//   request start (the Workspace looked up and marked used first; either failing keeps the tools built), and its
//   reinstall of `mcp`, `codemode` with the servers as its namespaces, and `tool-search`, together; and the notices that
//   the `mcp_servers` listing changed (`@cloudpid/extensions/mcp`: `bind` gives `McpTools` the Session's Harness to write
//   them to, `notify` is a conversation's check at its request start).
// @effect-diagnostics asyncFunction:off newPromise:off -- the host's request hooks and the decode slot are Promise-based.
import {
  HostLost,
  makeMcpTools,
  MCP_STREAM_SLOT_WAIT_MS,
  readStreamed,
  type McpAppHtmlInput,
  type McpAppRecorder,
  type McpAppRequestInput,
  type McpResourcePreviewInput,
  type McpHostClientService,
  type McpNotices,
  type McpQuestionsService,
  type McpRequestStartInput,
  type McpSamplingBinding,
  type McpSamplingService,
  type McpSignInsService,
  type McpTasksOptions,
  type McpToolOptions,
  type McpWatchRecorder,
  type McpToolsService,
  type McpToolsStore,
  type PromptSummaries,
  type SweepHarness,
} from "@cloudpid/extensions/mcp";
import { reloadToolSearch } from "@cloudpid/extensions/tool-search";
import {
  mcpAppError,
  type McpAppHtmlAnswer,
  type McpAppRequestAnswer,
  type McpCompletion,
  MCP_COMPLETION_STATUS,
  noCompletion,
  type McpResourcePreviewAnswer,
  MCP_PROMPT_REQUEST_ID_MAX,
  mcpPromptCallId,
  resourceUnavailable,
} from "@cloudpid/protocol";
import {
  HostFailed,
  pausableDeadline,
  type McpApplyResult,
  type McpErrorWire,
  type McpHostPromptGet,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpRequestStartResult,
  type McpServersResult,
  readMcpApplyResult,
  readMcpHostRequestResult,
  readMcpRequestStartResult,
  readMcpServersResult,
} from "@cloudpid/mcp/types";
import type { McpPromptErrorCode } from "@cloudpid/protocol";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { SessionError } from "./errors.ts";
import type {
  SessionHostMcp,
  SessionHostMcpBuild,
  SessionHostMcpPromptGet,
  SessionHostMcpPrompts,
} from "./host.ts";
import { type PromptCatalog, promptCatalog } from "./mcp-prompt-catalog.ts";
import type { PromptRefusal } from "./mcp-prompt.ts";
import { NO_SUMMARIES } from "./mcp-prompt-send.ts";
import type { SessionSettingsValues } from "./settings.ts";

/** What each of `McpHostClient`'s methods is answered on the wire, before the shared readers. */
export type McpHostAnswers = {
  readonly requestStart: typeof McpRequestStartResult.Encoded;
  readonly servers: typeof McpServersResult.Encoded;
  readonly apply: typeof McpApplyResult.Encoded;
  readonly request: typeof McpHostRequestResult.Encoded;
};

/** The host object as the Session reaches it: `McpHostClient`'s methods, answered on the wire, failing with `E`. */
export type McpHostStub<E> = {
  readonly [K in keyof McpHostClientService]: (
    ...args: Parameters<McpHostClientService[K]>
  ) => Effect.Effect<McpHostAnswers[K], E>;
};

/** A call to the host that failed, logged with its cause: `HostFailed`, with a message that names only the call. */
const failed =
  (what: string) =>
  <E>(cause: Cause.Cause<E>) =>
    Effect.logWarning(`The MCP host did not answer ${what}`, cause).pipe(
      Effect.as(HostFailed.make({ message: `The MCP host did not answer ${what}` })),
    );

/**
 * `McpHostClient` over `host`, the stub of the Session's Environment's `McpHost`, found anew for each call. A request's
 * hooks go to the host as RPC stubs, which live as long as the call: the call is awaited for its whole length.
 */
export const mcpHostClient = <E>(host: () => McpHostStub<E>): McpHostClientService => ({
  requestStart: (input) =>
    Effect.suspend(() => host().requestStart(input)).pipe(
      Effect.map(readMcpRequestStartResult),
      Effect.catchCause(failed("requestStart")),
    ),
  servers: (input) =>
    Effect.suspend(() => host().servers(input)).pipe(
      Effect.map(readMcpServersResult),
      Effect.catchCause(failed("servers")),
    ),
  apply: (input) =>
    Effect.suspend(() => host().apply(input)).pipe(
      Effect.map(readMcpApplyResult),
      Effect.catchCause(failed("apply")),
    ),
  request: (input, hooks) =>
    Effect.suspend(() => host().request(input, hooks)).pipe(
      Effect.map(readMcpHostRequestResult),
      Effect.catchCause((cause) =>
        Effect.logWarning("The MCP host's end of a request was lost", cause).pipe(
          Effect.as(HostLost.make({ message: "The MCP host's end of the request was lost" })),
        ),
      ),
    ),
});

/** The Session storage the store keeps its text in. */
export type McpToolsKv = {
  readonly get: <T>(key: string) => T | undefined;
  readonly put: <T>(key: string, value: T) => void;
  readonly delete: (key: string) => boolean;
};

/** The most characters a stored value holds: an inventory over it is kept in parts. */
const PART_LENGTH = 256 * 1024;

/**
 * A store in `kv` for Environment `environment`'s MCP tools: the text in parts of at most `PART_LENGTH` characters
 * under `mcp-tools:<environment>:<n>`, with their count under `mcp-tools:<environment>`, written last, so a text is
 * read whole or not at all; and each conversation's last opened Context Window under
 * `mcp-window:<environment>:<conversation>`; and the hash of the listing the last completed broadcast of notices told
 * every conversation of, under `mcp-broadcast:<environment>`.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store over two values, not a combinator.
export const kvMcpToolsStore = (kv: McpToolsKv, environment: string): McpToolsStore => {
  const countKey = `mcp-tools:${environment}`;
  const partKey = (index: number) => `${countKey}:${index}`;
  const windowKey = (conversation: string) => `mcp-window:${environment}:${conversation}`;
  const broadcastKey = `mcp-broadcast:${environment}`;

  return {
    broadcast: () => kv.get<string>(broadcastKey),
    broadcasted: (hash) => kv.put(broadcastKey, hash),
    window: (conversation) => kv.get<string>(windowKey(conversation)),
    openWindow: (conversation, window) => kv.put(windowKey(conversation), window),
    load: () => {
      const count = kv.get<number>(countKey);

      if (count === undefined) return undefined;

      const parts = Arr.makeBy(count, (index) => kv.get<string>(partKey(index)));

      return Arr.every(parts, (part) => part !== undefined) ? Arr.join(parts, "") : undefined;
    },
    save: (text) => {
      const old = kv.get<number>(countKey) ?? 0;

      kv.delete(countKey);

      for (let index = 0; index < old; index++) kv.delete(partKey(index));

      if (text === undefined) return;

      const count = Math.ceil(text.length / PART_LENGTH);

      for (let index = 0; index < count; index++) {
        kv.put(partKey(index), text.slice(index * PART_LENGTH, (index + 1) * PART_LENGTH));
      }

      kv.put(countKey, count);
    },
  };
};

/**
 * How long the Session waits for the host's answer to a prompt get: the host's own 30 s bound, and its slack. The wait
 * stands still while a question of the server waits for the owner.
 */
const PROMPT_GET_WAIT_MS = 40_000;

/**
 * A prompt get's ID, what its questions are kept and withdrawn under: from the send's `requestId`, a client's UUID, so the
 * web ties the lane row to the cards. It is unique per conversation (a conversation admits a `requestId` once, and a
 * resend of a get that was never admitted reuses it, taking the place of the first). A send with none, or whose `requestId`
 * is over `MCP_PROMPT_REQUEST_ID_MAX` (the ID is part of storage keys: `mcp-question:s:<callId>:<n>`), gets a UUID of its
 * own, which no lane row is tied to.
 */
const promptCallId = (requestId: string | undefined): string =>
  requestId !== undefined && requestId.length <= MCP_PROMPT_REQUEST_ID_MAX
    ? mcpPromptCallId(requestId)
    : // @effect-diagnostics-next-line cryptoRandomUUID:off
      mcpPromptCallId(crypto.randomUUID());

/** The longest an arguments refusal's message is, in characters. */
const PROMPT_ARGUMENTS_MESSAGE = 300;

/** How long a streamed prompt result may go without a byte. */
const PROMPT_STREAM_IDLE_MS = 30_000;

const NO_PROMPTS: PromptCatalog = { prompts: [], mcpServers: [] };

const refusalOf = (code: McpPromptErrorCode, message: string): PromptRefusal => ({
  code,
  message,
});

/** The failure a `CallFailed`'s error is. */
const callFailure = (error: McpErrorWire, server: string): PromptRefusal =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", () =>
      refusalOf("MCP_SIGN_IN_REQUIRED", `Sign in to ${server} to use its prompts`),
    ),
    Match.tag("TooLarge", () =>
      refusalOf("MCP_PROMPT_TOO_LARGE", `${server}'s prompt is too large`),
    ),
    // The spec's invalid-params code: a missing or wrong argument, or a prompt the server does not know.
    Match.tag("ServerError", "NotFound", ({ code, message }) =>
      code === -32602
        ? refusalOf("MCP_PROMPT_ARGUMENTS", message.slice(0, PROMPT_ARGUMENTS_MESSAGE))
        : refusalOf("MCP_PROMPT_FAILED", message),
    ),
    Match.orElse(({ message }) => refusalOf("MCP_PROMPT_FAILED", message)),
  );

/** The failure the host's answer to a prompt get is, or undefined when it completed. */
const failureOf = (
  result: McpHostRequestResult | HostLost,
  server: string,
): PromptRefusal | undefined =>
  Match.value(result).pipe(
    Match.tag("Completed", () => undefined),
    Match.tag("CallFailed", ({ error }) => callFailure(error, server)),
    // A host that does not know the op says so in its own words.
    Match.tag(
      "UnknownServer",
      "NotAllowed",
      "HostFailed",
      "HostLost",
      "HostUnsupported",
      ({ message }) => refusalOf("MCP_PROMPT_FAILED", message),
    ),
    Match.orElse(() =>
      refusalOf("MCP_PROMPT_FAILED", `${server} answered a prompt get with something else`),
    ),
  );

/** A promise that resolves when `signal` aborts, and never without it. */
const abortedBy = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

export type SessionMcpOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown, and then it has no MCP tools. */
  readonly session: string | undefined;
  /** How long the Session waits for the host's answer to a prompt get: `PROMPT_GET_WAIT_MS` unless a test shortens it. */
  readonly promptGetWaitMs?: number | undefined;
  /** The `McpHostClient` of Environment `environment`'s host. */
  readonly host: (environment: string) => McpHostClientService;
  /**
   * Runs an Effect the tools start from a hook of the harness (a model request's touch of the conversation's Resource
   * watches) with the Session's services, its logger and tracer; a bare `Effect.runPromise` without.
   */
  readonly run?: (<A>(effect: Effect.Effect<A>) => Promise<A>) | undefined;
  /** Where the Session keeps what its MCP tools were built from. */
  readonly kv: McpToolsKv;
  /**
   * The object of the Session's Workspace (`ws:<id>`), or null with none: then it has no MCP tools. A lookup that fails
   * keeps the tools as they were built.
   */
  readonly workspace: Effect.Effect<string | null, Cause.UnknownError>;
  /** A call to Workspace object `workspace` that marks it used (`noteSessionActivity`). */
  readonly ready: (workspace: string) => Effect.Effect<void, Cause.UnknownError>;
  /** `codemode` with `namespaces`, to install over the one installed. */
  readonly codemode: (namespaces: ReadonlyArray<CodemodeNamespace>) => Extension;
  /** The Session's MCP questions: with them, a Legacy server's elicitation form is shown to the owner. */
  readonly questions?: McpQuestionsService;
  /**
   * The Session's sampler: with it, a call to a Legacy server whose definition says `sampling: "allow"` is answered its
   * Sampling requests, on the models the host binds (`SessionHostMcp.bindSampling`).
   */
  readonly sampling?: McpSamplingService;
  /** The Session's Sign-in requests: with them, the build registers `mcp_sign_in_ask` when the set has a server that can need one. */
  readonly signIns?: McpSignInsService;
  /** Where the records of App calls and the inventory's App tools are kept (`./mcp-apps-store.ts`). */
  readonly apps?: McpAppRecorder;
  /** What follows the MCP tasks of the agent's calls (`./mcp-tasks.ts`): with it, a root call is offered one. */
  readonly tasks?: McpTasksOptions;

  /**
   * The Session's Resource watches: with it, the tools say what they start and what the host ends, and a conversation
   * that still holds a watch asks the host at its request start even with no server left (`./mcp-watches-store.ts`).
   */
  readonly watches?: McpWatchRecorder;
};

/** The Session host's MCP tools, and the page of an App record, which the sockets serve through the same host client. */
export type SessionMcp = SessionHostMcp<never> & {
  /** The page under an App record's `htmlHash`, through the host's `ui/html`, when it lists `app_html`. Never fails. */
  readonly appHtml: (input: McpAppHtmlInput) => Effect.Effect<McpAppHtmlAnswer>;
  /** An App View's request to its server, checked and sent as the View's own (`McpTools.appRequest`). Never fails. */
  readonly appRequest: (input: McpAppRequestInput) => Effect.Effect<McpAppRequestAnswer>;
  /** The owner's read of a resource a card links, which starts no Container (`McpTools.resourcePreview`). Never fails. */
  readonly resourcePreview: (
    input: McpResourcePreviewInput,
  ) => Effect.Effect<McpResourcePreviewAnswer>;
};

/** The Session host's MCP tools (`SessionHostOptions.mcp`), with one `McpTools` for the Session's Environment. */
export const sessionMcp = (options: SessionMcpOptions): SessionMcp => {
  let held: { readonly environment: string; readonly tools: McpToolsService } | undefined;

  /** Where the notices are written, once the host's Harness is open. */
  let notices: McpNotices | undefined;

  /** What the host does when a follower of an MCP task starts a Run or moves (`settleOnFollowers`): it settles. */
  let settleHost: (() => void) | undefined;

  /**
   * The Workspace marked used before any host call, tried twice: false when it never answered, and the request start
   * then calls nothing (`docs/architecture/mcp-in-a-session.md` → Request start), nor a call to a stdio server.
   */
  const readied = (workspace: string) =>
    options.ready(workspace).pipe(
      Effect.retry({ times: 1 }),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "The Workspace did not answer before an MCP request start; the MCP tools stay as they were",
          cause,
        ).pipe(Effect.as(false)),
      ),
    );

  /**
   * The Session's `McpTools`, made once, from what was kept: its Environment never changes. A call to a stdio server marks
   * the Workspace of the conversation that calls (its Subagent Workspace's, or the Session's) used first.
   */
  const toolsOf = (environment: string) => {
    if (held?.environment === environment) return held.tools;

    const toolOptions: Mutable<McpToolOptions> = {
      ready: (workspace) => Effect.runPromise(readied(workspace)),
      environment,
    };

    if (options.questions !== undefined) toolOptions.questions = options.questions;

    if (options.sampling !== undefined) toolOptions.sampling = options.sampling;

    if (options.signIns !== undefined) toolOptions.signIns = options.signIns;

    if (options.apps !== undefined) toolOptions.apps = options.apps;

    // A Run a follower starts is one the host tells the owner the end of, and a follower that moved (ended, or slept
    // until another time) is a reason to settle: the alarm and the Registry's count follow it (`settleOnFollowers`).
    if (options.tasks !== undefined) {
      const { submitted } = options.tasks;

      toolOptions.tasks = {
        ...options.tasks,
        submitted: (id) => {
          submitted?.(id);
          settleHost?.();
        },
        changed: () => {
          options.tasks?.changed?.();
          settleHost?.();
        },
      };
    }

    if (options.watches !== undefined) toolOptions.watches = options.watches;

    if (options.session !== undefined) toolOptions.session = options.session;

    if (options.run !== undefined) toolOptions.run = options.run;

    const tools = makeMcpTools(
      options.host(environment),
      kvMcpToolsStore(options.kv, environment),
      toolOptions,
    );

    if (notices !== undefined) tools.bindNotices(notices);

    held = { environment, tools };

    return tools;
  };

  /** A request start that cannot be made: the tools stay as they were built, and why is logged. */
  const skipped = (why: string, cause?: Cause.Cause<unknown>) =>
    Effect.logWarning(
      `${why} before an MCP request start; the MCP tools stay as they were`,
      ...(cause === undefined ? [] : [cause]),
    );

  const start = (
    conversationId: ConversationId,
    window: string,
    values: SessionSettingsValues,
  ): Effect.Effect<void> => {
    const { environment, servers } = values.mcp;

    // A Session in no Environment has no MCP host to ask.
    if (environment === null) return Effect.void;

    // A conversation that holds a watch asks the host even with no server left: the host tells it what changed.
    const watching = options.watches?.has(String(conversationId)) === true;

    const startFor = (workspace: string | null) => {
      const input: Mutable<McpRequestStartInput> = {
        // Not read without servers, whose host is never asked. A subagent's conversation asks as the Session's own: the
        // inventory is the Environment's, shared (D13); its calls name its own Subagent Workspace (`McpToolOptions.ready`).
        caller: {
          session: options.session ?? "",
          conversation: String(conversationId),
          workspace: workspace ?? "",
        },
        window,
        servers: workspace === null ? 0 : servers,
        offered: values.toolSearch.offered,
        ready: workspace === null ? Effect.succeed(true) : readied(workspace),
      };

      if (watching) input.watching = true;

      return toolsOf(environment).requestStart(input);
    };

    if (servers === 0) return startFor(null);

    // Not knowing who the Session is, or where its Workspace is, is a failure, not "no servers": nothing built is
    // dropped for it.
    if (options.session === undefined) return skipped("The Session's name is unknown");

    return options.workspace.pipe(
      Effect.asSome,
      Effect.catchCause((cause) =>
        skipped("The Session's Workspace is unknown", cause).pipe(Effect.as(Option.none())),
      ),
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: startFor })),
    );
  };

  const reinstall = (
    installed: readonly Extension[],
    values: SessionSettingsValues,
  ): SessionHostMcpBuild<never> => {
    const { environment } = values.mcp;

    if (environment === null) {
      // No Environment, no MCP servers: the clients are told there are no App tools (it is a no-op when none were told).
      options.apps?.setTools([]);

      return { extensions: [], announce: Effect.void };
    }

    const built = toolsOf(environment).reinstall(values.toolSearch.offered);

    if (Option.isNone(built)) return { extensions: [], announce: Effect.void };

    const { mcp, namespaces } = built.value;
    const codemode = options.codemode(namespaces);

    const others = Arr.map(installed, (each) =>
      each.name === mcp.name ? mcp : each.name === codemode.name ? codemode : each,
    );

    return {
      extensions: [mcp, codemode, reloadToolSearch(others, values.toolSearch)],
      announce: built.value.announce,
    };
  };

  const bind = (next: McpNotices) => {
    notices = next;
    held?.tools.bindNotices(next);
  };

  const settleOnFollowers = (next: () => void) => {
    settleHost = next;
  };

  const sweep = (harness: SweepHarness) =>
    held === undefined ? Effect.void : held.tools.sweepTasks(harness);

  const cancelTask: SessionMcp["cancelTask"] = (harness, task) =>
    held === undefined ? Effect.succeed("unknown" as const) : held.tools.cancelTask(harness, task);

  const keepContainer: SessionMcp["keepContainer"] = (harness, task) =>
    held === undefined
      ? Effect.succeed("unknown" as const)
      : held.tools.keepContainer(harness, task);

  const notify = (conversationId: ConversationId, values: SessionSettingsValues) => {
    const { environment } = values.mcp;

    return environment === null ? Effect.void : toolsOf(environment).notify(conversationId);
  };

  /** The composer's MCP prompts, from the inventory the host keeps: no server is read, no Container started. */
  const catalog = (values: SessionSettingsValues): Effect.Effect<PromptCatalog> => {
    const { environment, servers } = values.mcp;

    if (environment === null || servers === 0) return Effect.succeed(NO_PROMPTS);

    return options
      .host(environment)
      .servers({ parts: ["prompts"] })
      .pipe(
        Effect.map((answer) =>
          Predicate.isTagged(answer, "HostFailed") ? NO_PROMPTS : promptCatalog(answer.servers),
        ),
      );
  };

  /** Get a prompt of the Session's host, in the conversation's Workspace, and run `use` over the result. */
  const getPrompt = <A>(
    values: SessionSettingsValues,
    call: SessionHostMcpPromptGet,
    use: (result: Schema.Json, asked: PromptSummaries) => Promise<A>,
  ): Effect.Effect<A, SessionError> => {
    const { environment } = values.mcp;

    // Every refusal names the server, as the composer's form says which one it is about.
    const refused = (refusal: PromptRefusal) =>
      SessionError.make({ operation: "submit", ...refusal, server: call.server });

    if (environment === null || options.session === undefined) {
      return Effect.fail(
        refused(
          refusalOf("MCP_PROMPT_FAILED", "The Session has no MCP servers to get a prompt from"),
        ),
      );
    }

    const { session } = options;

    // An HTTP server is reached from the Session's Workspace, a stdio server runs in the conversation's own.
    const workspaceOf =
      call.workspace === undefined
        ? options.workspace.pipe(
            Effect.catchCause(() => Effect.succeed(null)),
            Effect.map((found) => found ?? undefined),
          )
        : Effect.succeed(call.workspace);

    return Effect.gen(function* () {
      const workspace = yield* workspaceOf;

      // The get's own clock: the host's 30 s bound and its slack. It stands still while a question of the server waits for
      // the owner (up to 5 min, `MCP_PROMPT_QUESTION_WAIT_MS`); a question that is never answered ends in `cancel`, and
      // the get goes on from there.
      const clock = yield* pausableDeadline(
        options.promptGetWaitMs ?? PROMPT_GET_WAIT_MS,
        () => new Error("The get timed out"),
      );

      // Aborts when the send is withdrawn (Stop) or the get ends: the host cancels the get, and a card that waits is withdrawn.
      const stopped = yield* Effect.abortSignal;

      const asking = toolsOf(environment).promptAsking({
        server: call.server,
        callId: promptCallId(call.requestId),
        command: call.command,
        title: call.title,
        conversationId: call.conversationId,
        signal: stopped,
        hold: { pause: clock.pause, resume: clock.resume },
      });

      const ctx: Mutable<McpHostPromptGet["ctx"]> = {
        origin: "owner",
        session,
        conversation: String(call.conversationId),
      };

      if (workspace !== undefined) ctx.workspace = workspace;

      // The questions the get may be asked are answered live (`ctx.answers`, and the hooks the host passes on to the engine).
      if (asking !== undefined) ctx.answers = asking.answers;

      const request: McpHostPromptGet = {
        op: "prompts/get",
        server: call.server,
        params: { name: call.name, arguments: { ...call.arguments } },
        ctx,
      };

      const get = Effect.tryPromise({
        // The signal aborts when the send is withdrawn (Stop) or the get's clock runs out: the host then cancels the get.
        try: (signal) =>
          getFrom(
            options.host(environment),
            request,
            AbortSignal.any([signal, stopped, clock.signal]),
            // What the server's questions came to is read once the result is here: every one of them has ended by then.
            (result) => use(result, asking?.summaries() ?? NO_SUMMARIES),
            asking?.hooks,
          ),
        catch: (cause) =>
          refused(
            refusalOf(
              "MCP_PROMPT_FAILED",
              cause instanceof Error ? cause.message : "The prompt could not be read",
            ),
          ),
      });

      const timedOut = Effect.promise(() => abortedBy(clock.signal)).pipe(
        Effect.andThen(
          Effect.fail(
            refused(refusalOf("MCP_PROMPT_FAILED", `${call.server} did not answer in time`)),
          ),
        ),
      );

      const got = yield* get.pipe(
        Effect.raceFirst(timedOut),
        Effect.ensuring(
          Effect.andThen(
            clock.clear,
            Effect.promise(() => asking?.settle() ?? Promise.resolve()),
          ),
        ),
      );

      // A Modern server's Sampling request that was refused ended the get in the core, the server told nothing: the send
      // says so, whatever the core's own words for it were.
      const sunk = asking?.sunk();

      if (!got.ok && sunk !== undefined) {
        return yield* refused(refusalOf("MCP_PROMPT_FAILED", sunk));
      }

      if (got.ok) return got.value;

      // A refusal that follows an answer the owner (or cloudpid) gave to a question ends with it: "You declined docs's
      // request for input."
      const line = asking?.answerLine();

      return yield* refused(
        line === undefined || got.refusal.code !== "MCP_PROMPT_FAILED"
          ? got.refusal
          : refusalOf(got.refusal.code, `${got.refusal.message} ${line}`),
      );
    }).pipe(Effect.scoped);
  };

  const prompts: SessionHostMcpPrompts = { session: options.session, catalog, get: getPrompt };

  /** The owner's MCP resources in the composer: through the tools as they were built, which a Session with none has not. */
  const attached: NonNullable<SessionHostMcp<never>["attached"]> = {
    session: options.session,
    menu: (input) =>
      held === undefined
        ? Effect.succeed({ servers: [] })
        : held.tools.attachedResources.menu(input),
    read: (input) =>
      held === undefined
        ? Effect.succeed({ status: "gone", message: "This Session has no MCP servers" })
        : held.tools.attachedResources.read(input),
  };

  const appHtml: SessionMcp["appHtml"] = (input) =>
    held === undefined
      ? Effect.succeed<McpAppHtmlAnswer>({
          status: "unsupported",
          message: "This Session has no MCP servers",
        })
      : held.tools.appHtml(input);

  const appRequest: SessionMcp["appRequest"] = (input) =>
    held === undefined
      ? Effect.succeed<McpAppRequestAnswer>(
          mcpAppError("unavailable", "This Session has no MCP servers"),
        )
      : held.tools.appRequest(input);

  const complete: NonNullable<SessionHostMcp<never>["complete"]> = (input) =>
    held === undefined
      ? Effect.succeed<McpCompletion>(noCompletion(MCP_COMPLETION_STATUS.unsupported))
      : held.tools.complete(input);

  const resourcePreview: SessionMcp["resourcePreview"] = (input) =>
    held === undefined
      ? Effect.succeed<McpResourcePreviewAnswer>(
          resourceUnavailable("unavailable", "This Session has no MCP servers"),
        )
      : held.tools.resourcePreview(input);

  /** The models, Roles, limit and Usage the sampler works with, once the host's Harness is open. */
  const bindSampling = (binding: McpSamplingBinding) => {
    options.sampling?.bind(binding);
  };

  return {
    start,
    reinstall,
    bind,
    bindSampling,
    settleOnFollowers,
    sweep,
    cancelTask,
    keepContainer,
    notify,
    prompts,
    attached,
    complete,
    appHtml,
    appRequest,
    resourcePreview,
  };
};

/** What a prompt get came to: the result `use` made, or why it is refused. */
type Got<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly refusal: PromptRefusal };

/** Ask `client` for `request`, read the result (a large one under the decode slot) and run `use` over it. */
const getFrom = async <A>(
  client: McpHostClientService,
  request: McpHostPromptGet,
  signal: AbortSignal,
  use: (result: Schema.Json) => Promise<A>,
  asking: Pick<McpHostRequestHooks, "onInput" | "onInputEnded" | "onInputComplete"> | undefined,
): Promise<Got<A>> => {
  const result = await Effect.runPromise(
    client.request(request, { ...asking, untilAborted: () => abortedBy(signal) }),
  );

  const failed = failureOf(result, request.server);

  if (failed !== undefined) return { ok: false, refusal: failed };

  // `failureOf` leaves only a completed answer.
  if (!Predicate.isTagged(result, "Completed")) {
    return {
      ok: false,
      refusal: refusalOf("MCP_PROMPT_FAILED", "The host did not complete the get"),
    };
  }

  if (result.result.kind === "inline") return { ok: true, value: await use(result.result.value) };

  return readStreamed(
    result.result.body,
    result.result.bytes,
    { signal, idleMs: PROMPT_STREAM_IDLE_MS, waitMs: MCP_STREAM_SLOT_WAIT_MS },
    async (streamed): Promise<Got<A>> => {
      if (streamed.kind === "value") return { ok: true, value: await use(streamed.value) };

      if (streamed.kind === "too_large") {
        return {
          ok: false,
          refusal: refusalOf("MCP_PROMPT_TOO_LARGE", `${request.server}'s prompt is too large`),
        };
      }

      return {
        ok: false,
        refusal: refusalOf(
          "MCP_PROMPT_FAILED",
          streamed.kind === "aborted"
            ? "The prompt was stopped"
            : "The server's prompt could not be read",
        ),
      };
    },
  );
};
