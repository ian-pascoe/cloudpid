/**
 * Fake MCP servers behind the injected `fetch`, on the SDK server (`docs/architecture/mcp.md` → Testing and tracing):
 * Modern, Legacy stateless, Legacy stateful with a GET stream, and a hostile wrapper that answers chosen requests
 * itself. Each records what reached it, so tests can see what the core sent.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missingPipeableSignature:off schemaSync:off newPromise:off globalDate:off globalTimers:off
import {
  createMcpHandler,
  type GetPromptResult,
  type Prompt,
  inputRequired,
  type McpHttpHandler,
  Server,
  type ServerCapabilities,
  type Tool,
  UrlElicitationRequiredError,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/** One request that reached a fake: its HTTP method, URL, headers and, for a POST, its JSON-RPC body. */
export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly rpc: RpcBody | undefined;
}

/** The parts of a JSON-RPC message the tests look at. */
export interface RpcBody {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly [key: string]: Json };
}

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** A fake MCP server: a `fetch` handler and the requests it received. */
export interface FakeServer {
  readonly handle: (request: Request) => Promise<Response>;
  readonly received: Array<Received>;
}

/** The fakes' tool that echoes its text. */
export const ECHO_TOOL = {
  name: "echo",
  description: "Echo its text.",
  inputSchema: { type: "object" as const },
};

/** The fakes' tool that echoes its text in capitals. */
export const SHOUT_TOOL = {
  name: "shout",
  description: "Echo its text in capitals.",
  inputSchema: { type: "object" as const },
};

const EchoArguments = Schema.Struct({ text: Schema.String });

const BigArguments = Schema.Struct({ bytes: Schema.Int });

const TypedArguments = Schema.Struct({ structured: Schema.optionalKey(Schema.Json) });

/** The fakes' tool that answers with `bytes` bytes of text, for byte limits and large results. */
export const BIG_TOOL = {
  name: "big",
  description: "Answer with that many bytes of text.",
  inputSchema: { type: "object" as const },
};

/** The fakes' tool that never answers: it waits for the request to be cancelled, and records that it was. */
export const HANG_TOOL = {
  name: "hang",
  description: "Wait until cancelled.",
  inputSchema: { type: "object" as const },
};

/**
 * The fakes' tool that reports progress: `steps` notices (`1/steps`, with a message), then answers `done`, or with
 * `hang`, waits until cancelled, as `hang` does. A request that asked for no progress gets none.
 */
export const PROGRESS_TOOL = {
  name: "progress",
  description: "Report progress, then answer or wait until cancelled.",
  inputSchema: {
    type: "object" as const,
    properties: { steps: { type: "number" }, hang: { type: "boolean" } },
  },
};

const ProgressArguments = Schema.Struct({
  steps: Schema.Int,
  hang: Schema.optionalKey(Schema.Boolean),
});

/** The fakes' tool with an `outputSchema`: it answers with the `structuredContent` it is given. */
export const TYPED_TOOL = {
  name: "typed",
  description: "Answer with the structured content given.",
  inputSchema: { type: "object" as const },
  outputSchema: {
    type: "object" as const,
    properties: { count: { type: "number" } },
    required: ["count"],
  },
};

/**
 * The fakes' tool with an `x-mcp-header`: its `region` goes in an `Mcp-Param-Region` header on Modern, and it answers
 * with the region.
 */
export const REGION_TOOL = {
  name: "region",
  description: "Answer with the region.",
  inputSchema: {
    type: "object" as const,
    properties: { region: { type: "string", "x-mcp-header": "Region" } },
  },
};

const RegionArguments = Schema.Struct({ region: Schema.String });

/** The fakes' tool that asks the client for its Roots (`roots/list`) and answers with what it was told, as JSON text. Never listed. */
export const ROOTS_TOOL = {
  name: "roots",
  description: "Answer with the client's Roots.",
  inputSchema: { type: "object" as const },
};

/**
 * The fakes' tool that asks the client a form (`elicitation/create`) during the call, and answers with what it got: the
 * `action` and `content` as JSON text, or, when the client refused the request, `isError` with the error's message. On
 * Modern it asks in `input_required` rounds instead (`rounds`, default 1, of `forms` forms each, default 1, keyed `q1`,
 * `q2`, … and with `roots`, a `roots/list` too, and `samples` Sampling requests keyed `s1`, `s2`, …), each with a
 * `requestState` of `round-<n>`, and answers the last
 * round's responses as JSON text; every answer it gets is recorded in `asked`, with the round and the state it came
 * back with.
 */
export const ASK_TOOL = {
  name: "ask",
  description: "Ask the client a form, then answer with what it said.",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: { type: "string" },
      requestedSchema: { type: "object" },
      standalone: { type: "boolean" },
      giveUpMs: { type: "number" },
      rounds: { type: "number" },
      forms: { type: "number" },
      roots: { type: "boolean" },
      samples: { type: "number" },
    },
  },
};

const AskArguments = Schema.Struct({
  message: Schema.String,
  requestedSchema: Schema.optionalKey(Schema.Json),
  /** Ask on the server's standalone stream (the GET stream), as `server.elicitInput` does, not on the call's own. */
  standalone: Schema.optionalKey(Schema.Boolean),
  /** Stop waiting for the answer after this many milliseconds: the server cancels its own request. */
  giveUpMs: Schema.optionalKey(Schema.Int),
  /** Modern: how many rounds of questions, and how many forms in each; and whether each round asks for Roots too. */
  rounds: Schema.optionalKey(Schema.Int),
  forms: Schema.optionalKey(Schema.Int),
  roots: Schema.optionalKey(Schema.Boolean),
  /** Modern: how many Sampling requests (`s1`, `s2`, ...) each round asks beside its forms. */
  samples: Schema.optionalKey(Schema.Int),
});

/**
 * The fakes' tool that asks the client for a model reply (`sampling/createMessage`) during the call, `rounds` times (a
 * tool loop of the server's own; default 1), each with the request's `params` as given (a one-message request with
 * `maxTokens` 100 when it gives none), and answers with the last reply as JSON text, or, when the client refused a
 * request, `isError` with the error's `code` and message. Every reply or error is recorded in `sampled`.
 */
export const SAMPLE_TOOL = {
  name: "sample",
  description: "Ask the client for a model reply, then answer with what it said.",
  inputSchema: {
    type: "object" as const,
    properties: {
      rounds: { type: "number" },
      params: { type: "object" },
      standalone: { type: "boolean" },
      giveUpMs: { type: "number" },
    },
  },
};

/**
 * The fakes' tool that asks the client to open a page (`elicitation/create`, URL mode) during a Legacy call, and answers
 * with what it got as JSON text. After an `accept` it waits `completeAfterMs` (when given) and tells the client the
 * owner finished there (`notifications/elicitation/complete`, on the call's own stream, or on the standalone one with
 * `completeOnStandalone`), then waits `holdMs` more before it answers. On Modern it asks in `input_required` rounds
 * instead (`rounds` of them, default 1, each with the same page keyed `page`), and answers the last round's responses.
 */
export const VISIT_TOOL = {
  name: "visit",
  description: "Ask the client to open a page, then answer with what it said.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string" },
      message: { type: "string" },
      elicitationId: { type: "string" },
      completeAfterMs: { type: "number" },
      completeOnStandalone: { type: "boolean" },
      holdMs: { type: "number" },
      rounds: { type: "number" },
    },
  },
};

const SampleArguments = Schema.Struct({
  rounds: Schema.optionalKey(Schema.Int),
  params: Schema.optionalKey(Schema.Json),
  /** Ask on the server's standalone stream (the GET stream), not on the call's own. */
  standalone: Schema.optionalKey(Schema.Boolean),
  /** Stop waiting for the reply after this many milliseconds: the server cancels its own request. */
  giveUpMs: Schema.optionalKey(Schema.Int),
});

const VisitArguments = Schema.Struct({
  url: Schema.String,
  message: Schema.optionalKey(Schema.String),
  elicitationId: Schema.optionalKey(Schema.String),
  completeAfterMs: Schema.optionalKey(Schema.Int),
  completeOnStandalone: Schema.optionalKey(Schema.Boolean),
  holdMs: Schema.optionalKey(Schema.Int),
  /** Modern: how many rounds the server asks for the page (default 1) before it answers. */
  rounds: Schema.optionalKey(Schema.Int),
});

/**
 * The fakes' tool that needs the owner at a page before it runs (a Legacy server's `-32042`, URL elicitation
 * required): it answers `-32042` listing `pages`, each a page with its own `elicitationId`, for its first
 * `FakeOptions.gate.times` calls, then answers `opened` (it records the calls it got in `gate.calls`).
 */
export const GATED_TOOL = {
  name: "gated",
  description: "Need the owner at a page first, then answer.",
  inputSchema: { type: "object" as const },
};

/** The MIME type of an MCP App's HTML (`docs/architecture/mcp-apps.md` → Declaring and reading Apps). */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** A tool of an App server whose App is the `ui://` resource `uri`: it answers as `echo` does. */
export const appTool = (name: string, uri: string): Tool => ({
  name,
  description: "Echo its text, with an App.",
  inputSchema: { type: "object" as const },
  _meta: { ui: { resourceUri: uri } },
});

/** One content item of a fake's resource: text or a base64 blob, with its MIME type and its own `_meta`. */
export type FakeContent = {
  readonly uri: string;
  readonly mimeType?: string;
  readonly _meta?: Record<string, Schema.Json>;
} & ({ readonly text: string } | { readonly blob: string });

/** A resource a fake lists and reads: its listing entry's `_meta`, and the content items `resources/read` answers. */
export interface FakeResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly _meta?: Record<string, Schema.Json>;
  /** What `resources/read` answers; a function makes it at each read, so a test of many large pages holds one at a time. */
  readonly contents: ReadonlyArray<FakeContent> | (() => ReadonlyArray<FakeContent>);
  /**
   * A form the server asks before it answers (a Legacy server on the read's own stream, a Modern one as
   * `input_required` with the `requestState` `read-1`): the read's one text content is then the answer as JSON, in
   * place of `contents`.
   */
  readonly asks?: { readonly message: string };
}

/** A page of a fake's resource list as it is built: its items, the next cursor, and a Modern server's cache hints. */
interface FakeListPage<A> {
  items: Array<A>;
  nextCursor?: string;
  ttlMs?: number;
  cacheScope?: string;
}

/** A resource template a fake lists. */
export interface FakeResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** A prompt a fake lists and gets: its listing entry, and the messages `prompts/get` answers for the arguments it was sent. */
export interface FakePrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
  /** What `prompts/get` answers; a throw is the server's error. */
  readonly get: (args: Readonly<Record<string, string>>) => {
    readonly description?: string;
    readonly messages: GetPromptResult["messages"];
  };
  /**
   * A question the server asks before it answers (a Legacy server on the get's own stream, a Modern one as `input_required`
   * with the `requestState` `prompt-1`): a form (`message`) or a model reply (`sample`). The prompt's one assistant message
   * is then the answer as JSON, in place of `get`'s.
   */
  readonly asks?:
    | { readonly message: string }
    | { readonly sample: string }
    | {
        readonly url: string;
        /** A Legacy server goes on for this long after the page's answer. */
        readonly holdMs?: number;
        /** A Modern server asks the same page again this many times (the owner was not done there). */
        readonly again?: number;
        /** A Modern server asks this many pages in one round (`q1`, `q2`, ...; default 1). */
        readonly pages?: number;
      };
  /** The get never answers until the call is cancelled (a server that does not answer in time). */
  readonly hangs?: true;
}

/** What a fake MCP server offers besides the echo tools, and where it records what happened to its calls. */
export interface FakeOptions {
  /** Declares `resources`, lists these, and answers `resources/read` for each by its URI (an unknown one is an error). */
  readonly resources?: ReadonlyArray<FakeResource>;
  /** Lists these as `resources/templates/list` (and declares `resources`). */
  readonly resourceTemplates?: ReadonlyArray<FakeResourceTemplate>;
  /** How many items a page of `resources/list` and `resources/templates/list` holds; all of them in one page by default. */
  readonly resourcePageSize?: number;
  /** The cache hints both lists answer with: `ttlMs`, and `cacheScope` (a Modern server's; a Legacy one sends none, as it has no such field). */
  readonly listCache?: { readonly ttlMs: number; readonly cacheScope?: "public" | "private" };
  /** Declares `prompts`, lists these, and answers `prompts/get` for each by its name (an unknown one is an error). */
  readonly prompts?: ReadonlyArray<FakePrompt>;
  /**
   * Declares `completions` and answers `completion/complete` with what `complete` returns for the request's `params`
   * (`ref`, `argument`, `context`); a throw is the server's error. With `hangs` it never answers until the request is
   * cancelled, and notes the argument's name in `cancelled`.
   */
  readonly completions?: {
    readonly complete: (params: {
      readonly ref: { readonly type: string; readonly name?: string; readonly uri?: string };
      readonly argument: { readonly name: string; readonly value: string };
      readonly context?:
        | { readonly arguments?: Readonly<Record<string, string>> | undefined }
        | undefined;
    }) => {
      readonly values: ReadonlyArray<string>;
      readonly total?: number;
      readonly hasMore?: boolean;
    };
    readonly hangs?: true;
  };
  /** List `big`, `hang`, `typed` and `region` after `echo` and `shout`; they answer whether listed or not. */
  readonly listMore?: boolean;
  /** What the server says of itself: its `instructions` (default `Use the echo tool.`) and the name in its `serverInfo`. */
  readonly instructions?: string;
  readonly serverName?: string;
  /** What the server advertises in `capabilities.extensions` (a Modern server's MCP tasks, `io.modelcontextprotocol/tasks`). */
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, never>>>> | undefined;
  /** The names of the calls whose request was cancelled while they ran. */
  readonly cancelled?: Array<string>;
  /**
   * The `gated` tool: it answers `-32042` for its first `times` calls (each listing `pages` pages, default 1, with
   * the `elicitationId` `page-1`, … unless `sameId`, `page-1` each time); `calls` counts what it was sent.
   */
  readonly gate?: {
    readonly times: number;
    calls: number;
    readonly pages?: number;
    readonly url?: string;
  };
  /** Like `gate`, for `prompts/get`: it answers `-32042` for its first `times` gets (each listing `pages` pages), and counts them in `calls`. */
  readonly gatePrompts?: {
    readonly times: number;
    calls: number;
    readonly pages?: number;
    readonly url?: string;
  };
  /** Like `gate`, for `resources/read`: it answers `-32042` for its first `times` reads, and counts them in `calls`. */
  readonly gateReads?: { readonly times: number; calls: number; readonly url?: string };
  /** What the client answered the `ask` tool's questions with (`{ action, content? }`), or the error it refused with. */
  readonly asked?: Array<Json>;
  /** What the client answered the `sample` tool's requests with (a `CreateMessageResult`), or `{ error, code }`. */
  readonly sampled?: Array<Json>;
  /**
   * Declares `resources.subscribe` (and `listChanged`) and answers `resources/subscribe` and `resources/unsubscribe`,
   * recording the URIs asked. A URI in `refuse` is answered with an error. A Modern server serves `subscriptions/listen`
   * as the SDK does, whatever this says.
   */
  readonly subscriptions?: {
    readonly subscribed: Array<string>;
    readonly unsubscribed: Array<string>;
    readonly refuse?: ReadonlyArray<string>;
  };
  /** Further tools listed last, which answer as `echo` does unless something in front of the server answers first. */
  readonly moreTools?: ReadonlyArray<Tool>;
  /**
   * Declares `logging`, and sends these as `notifications/message` with every `tools/call` and every first page of `tools/list`, each only where the client's
   * level lets it through (Legacy: its `logging/setLevel`; Modern: its `_meta` `logLevel`, none without one).
   */
  readonly logs?:
    | ReadonlyArray<{
        readonly level: "debug" | "info" | "notice" | "warning" | "error";
        readonly data: unknown;
        readonly logger?: string;
      }>
    | undefined;
}

/**
 * Waits until `signal` aborts, then calls `aborted` and rejects. `aborted` runs in the abort itself, since the
 * call's own request may be gone by the time a continuation would run (a Worker cancels a disconnected request's).
 */
const untilAborted = (signal: AbortSignal, aborted: () => void) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted();
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });

/**
 * An SDK server answering `tools/list` a page at a time and `tools/call` for its tools: `echo` and `shout`, and
 * `big`, `hang`, `typed` and `region`, listed only with `listMore`, and `progress` and `ask`, listed only in `moreTools`.
 */
const fakeMcp = (
  sends?: (server: Server) => Promise<void>,
  options: FakeOptions = {},
  modern = false,
) => {
  const capabilities: ServerCapabilities = { tools: { listChanged: true } };

  if (options.logs !== undefined) capabilities.logging = {};

  if (options.resources !== undefined || options.resourceTemplates !== undefined) {
    capabilities.resources = {};
  }

  if (options.subscriptions !== undefined) {
    capabilities.resources = { subscribe: true, listChanged: true };
  }

  if (options.prompts !== undefined) capabilities.prompts = { listChanged: true };

  if (options.completions !== undefined) capabilities.completions = {};

  if (options.extensions !== undefined) capabilities.extensions = { ...options.extensions };

  const server = new Server(
    { name: options.serverName ?? "fake", version: "1.0.0" },
    {
      capabilities,
      instructions: options.instructions ?? "Use the echo tool.",
    },
  );

  server.setRequestHandler("tools/list", async (request, ctx) => {
    if (request.params?.cursor === undefined) {
      for (const log of options.logs ?? []) {
        await ctx.mcpReq.log(log.level, log.data, log.logger);
      }
    }

    return request.params?.cursor === "page-2"
      ? {
          tools: [
            ...(options.listMore === true
              ? [SHOUT_TOOL, BIG_TOOL, HANG_TOOL, TYPED_TOOL, REGION_TOOL]
              : [SHOUT_TOOL]),
            ...(options.moreTools ?? []),
          ],
        }
      : { tools: [ECHO_TOOL], nextCursor: "page-2" };
  });

  if (options.resources !== undefined || options.resourceTemplates !== undefined) {
    const resources = options.resources ?? [];
    const templates = options.resourceTemplates ?? [];

    /** `all`'s page that starts at the numeric `cursor`, with the cursor of the next page and the lists' cache hints. */
    const pageOf = <A>(all: ReadonlyArray<A>, cursor: string | undefined) => {
      const size = options.resourcePageSize ?? Math.max(all.length, 1);
      const from = cursor === undefined ? 0 : Number(cursor);
      const next = from + size;

      const page: FakeListPage<A> = { items: all.slice(from, next) };

      if (next < all.length) page.nextCursor = String(next);

      // A Legacy server has no cache hints.
      if (modern && options.listCache !== undefined) Object.assign(page, options.listCache);

      return page;
    };

    server.setRequestHandler("resources/list", async (request) => {
      const { items, ...rest } = pageOf(
        resources.map(({ contents: _contents, asks: _asks, ...listed }) => listed),
        request.params?.cursor,
      );

      return { resources: items, ...rest };
    });

    server.setRequestHandler("resources/templates/list", async (request) => {
      const { items, ...rest } = pageOf(templates, request.params?.cursor);

      return { resourceTemplates: items.map((each) => ({ ...each })), ...rest };
    });

    server.setRequestHandler("resources/read", async (request, ctx) => {
      const { gateReads } = options;

      if (gateReads !== undefined) {
        gateReads.calls += 1;

        if (gateReads.calls <= gateReads.times) {
          throw new UrlElicitationRequiredError(
            [
              {
                mode: "url" as const,
                elicitationId: "page-1",
                url: gateReads.url ?? "https://example.com/authorize",
                message: "Authorize first",
              },
            ],
            "Authorization needed",
          );
        }
      }

      const found = resources.find((each) => each.uri === request.params.uri);

      if (found === undefined) throw new Error(`No resource ${request.params.uri}`);

      // A Modern server asks in its answer: `input_required` first, then the read answered with the round's responses.
      if (found.asks !== undefined && modern) {
        const responses = ctx.mcpReq.inputResponses;

        if (responses === undefined) {
          return inputRequired({
            inputRequests: {
              q1: inputRequired.elicit({
                message: found.asks.message,
                requestedSchema: { type: "object", properties: {} },
              }),
            },
            requestState: "read-1",
          });
        }

        // SAFETY: the client's answers are JSON.
        options.asked?.push({
          round: 1,
          state: ctx.mcpReq.requestState<string>() ?? "",
          responses: { ...responses } as Json,
        });

        return {
          contents: [
            { uri: found.uri, mimeType: "application/json", text: JSON.stringify(responses["q1"]) },
          ],
        };
      }

      if (found.asks !== undefined) {
        const answer = await ctx.mcpReq.send({
          method: "elicitation/create",
          params: {
            message: found.asks.message,
            requestedSchema: { type: "object", properties: {} },
          },
        });

        return {
          contents: [
            { uri: found.uri, mimeType: "application/json", text: JSON.stringify({ ...answer }) },
          ],
        };
      }

      return {
        contents: [...(Predicate.isFunction(found.contents) ? found.contents() : found.contents)],
      };
    });
  }

  if (options.subscriptions !== undefined) {
    const { subscribed, unsubscribed, refuse = [] } = options.subscriptions;

    server.setRequestHandler("resources/subscribe", async (request) => {
      if (refuse.includes(request.params.uri)) throw new Error("Cannot subscribe to that resource");

      subscribed.push(request.params.uri);

      return {};
    });
    server.setRequestHandler("resources/unsubscribe", async (request) => {
      unsubscribed.push(request.params.uri);

      return {};
    });
  }

  if (options.completions !== undefined) {
    const { completions } = options;

    server.setRequestHandler("completion/complete", async (request, ctx) => {
      if (completions.hangs === true) {
        return untilAborted(ctx.mcpReq.signal, () =>
          options.cancelled?.push(request.params.argument.name),
        );
      }

      const { values, total, hasMore } = completions.complete(request.params);

      // oxlint-disable-next-line anti-slop/no-known-value-widening -- the optional keys are added below, as the fake was told
      const completion: { values: string[]; total?: number; hasMore?: boolean } = {
        values: [...values],
      };

      if (total !== undefined) completion.total = total;

      if (hasMore !== undefined) completion.hasMore = hasMore;

      return { completion };
    });
  }

  if (options.prompts !== undefined) {
    const { prompts } = options;

    server.setRequestHandler("prompts/list", async () => ({
      prompts: prompts.map(
        ({ get: _get, asks: _asks, hangs: _hangs, arguments: args, ...listed }) => {
          const entry: Prompt = { ...listed };

          if (args !== undefined) entry.arguments = [...args];

          return entry;
        },
      ),
    }));
    server.setRequestHandler("prompts/get", async (request, ctx) => {
      const found = prompts.find((each) => each.name === request.params.name);

      if (found === undefined) throw new Error(`No prompt ${request.params.name}`);

      const { gatePrompts } = options;

      if (gatePrompts !== undefined) {
        gatePrompts.calls += 1;

        if (gatePrompts.calls <= gatePrompts.times) {
          throw new UrlElicitationRequiredError(
            Array.from({ length: gatePrompts.pages ?? 1 }, (_unused, index) => ({
              mode: "url" as const,
              elicitationId: `page-${index + 1}`,
              url: gatePrompts.url ?? "https://example.com/authorize",
              message: "Authorize first",
            })),
            "Authorization needed",
          );
        }
      }

      if (found.hangs === true) {
        return untilAborted(ctx.mcpReq.signal, () => options.cancelled?.push(request.params.name));
      }

      const { asks } = found;

      if (asks !== undefined) {
        const answered = (answer: Json | undefined): GetPromptResult => ({
          messages: [
            { role: "assistant", content: { type: "text", text: JSON.stringify(answer) } },
          ],
        });

        // A Modern server asks in its answer: `input_required` first, then the get answered with the round's responses.
        if (modern) {
          const responses = ctx.mcpReq.inputResponses;
          const round = Number(ctx.mcpReq.requestState<string>()?.slice("prompt-".length) ?? "0");

          const morePages = (): Record<string, ReturnType<typeof inputRequired.elicitUrl>> => {
            const more: Record<string, ReturnType<typeof inputRequired.elicitUrl>> = {};

            if ("url" in asks) {
              for (let page = 2; page <= (asks.pages ?? 1); page += 1) {
                more[`q${page}`] = inputRequired.elicitUrl({
                  url: asks.url,
                  message: "Open the page",
                });
              }
            }

            return more;
          };

          const ask = (next: number) =>
            inputRequired({
              inputRequests: {
                q1:
                  "message" in asks
                    ? inputRequired.elicit({
                        message: asks.message,
                        requestedSchema: { type: "object", properties: {} },
                      })
                    : "url" in asks
                      ? inputRequired.elicitUrl({ url: asks.url, message: "Open the page" })
                      : inputRequired.createMessage({
                          messages: [
                            { role: "user", content: { type: "text", text: asks.sample } },
                          ],
                          maxTokens: 100,
                        }),
                ...morePages(),
              },
              requestState: `prompt-${next}`,
            });

          if (responses === undefined) return ask(1);

          // SAFETY: the client's answers are JSON.
          options.asked?.push({
            round,
            state: ctx.mcpReq.requestState<string>() ?? "",
            responses: { ...responses } as Json,
          });

          // The owner was not done at the page: the server asks for it once more.
          if ("url" in asks && round <= (asks.again ?? 0)) return ask(round + 1);

          // SAFETY: the client's answers are JSON.
          return answered(responses["q1"] as Json);
        }

        const answer = await ctx.mcpReq.send(
          "message" in asks
            ? {
                method: "elicitation/create",
                params: {
                  message: asks.message,
                  requestedSchema: { type: "object", properties: {} },
                },
              }
            : "url" in asks
              ? {
                  method: "elicitation/create",
                  params: {
                    mode: "url",
                    elicitationId: "e1",
                    url: asks.url,
                    message: "Open the page",
                  },
                }
              : {
                  method: "sampling/createMessage",
                  params: {
                    messages: [{ role: "user", content: { type: "text", text: asks.sample } }],
                    maxTokens: 100,
                  },
                },
        );

        // A page's answer is told at once; the server then goes on for a while, as a call to a slow server does.
        if ("url" in asks && asks.holdMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, asks.holdMs));
        }

        // SAFETY: the client's answer is JSON.
        return answered({ ...answer } as Json);
      }

      const got = found.get(request.params.arguments ?? {});

      return { ...got, messages: [...got.messages] };
    });
  }

  server.setRequestHandler("tools/call", async (request, ctx) => {
    await sends?.(server);

    for (const log of options.logs ?? []) {
      await ctx.mcpReq.log(log.level, log.data, log.logger);
    }

    switch (request.params.name) {
      case "big": {
        const { bytes } = Schema.decodeUnknownSync(BigArguments)(request.params.arguments);

        return { content: [{ type: "text", text: "x".repeat(bytes) }] };
      }

      case "hang":
        return untilAborted(ctx.mcpReq.signal, () => options.cancelled?.push(request.params.name));

      case "progress": {
        const { steps, hang } = Schema.decodeUnknownSync(ProgressArguments)(
          request.params.arguments,
        );

        const token = ctx.mcpReq._meta?.progressToken;

        for (let step = 1; token !== undefined && step <= steps; step++) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: step, total: steps, message: `step ${step}` },
          });
        }

        if (hang === true) {
          return untilAborted(ctx.mcpReq.signal, () =>
            options.cancelled?.push(request.params.name),
          );
        }

        return { content: [{ type: "text", text: "done" }] };
      }

      case "roots": {
        // Modern asks in an `input_required` round and reads the answer from the retry; Legacy asks on the call's stream.
        if (modern) {
          const answered = ctx.mcpReq.inputResponses?.["roots"];

          return answered === undefined
            ? inputRequired({ inputRequests: { roots: inputRequired.listRoots() } })
            : { content: [{ type: "text", text: JSON.stringify(answered) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(await server.listRoots()) }] };
      }

      case "ask": {
        const { message, requestedSchema, standalone, giveUpMs, rounds, forms, roots, samples } =
          Schema.decodeUnknownSync(AskArguments)(request.params.arguments);

        if (modern) {
          const state = ctx.mcpReq.requestState<string>();
          const round = state === undefined ? 0 : Number(state.replace("round-", ""));
          const responses = ctx.mcpReq.inputResponses ?? {};

          if (round > 0 && state !== undefined) {
            // SAFETY: the client's answers are JSON.
            options.asked?.push({ round, state, responses: { ...responses } as Json });
          }

          if (round >= (rounds ?? 1)) {
            return { content: [{ type: "text", text: JSON.stringify(responses) }] };
          }

          const inputRequests: Record<string, ReturnType<typeof inputRequired.elicit>> = {};

          for (let form = 1; form <= (forms ?? 1); form++) {
            inputRequests[`q${form}`] = inputRequired.elicit({
              message,
              // SAFETY: the test gives a form's schema, which the SDK's own check reads.
              requestedSchema: (requestedSchema ?? { type: "object", properties: {} }) as never,
            });
          }

          if (roots === true) inputRequests["roots"] = inputRequired.listRoots();

          for (let sample = 1; sample <= (samples ?? 0); sample++) {
            inputRequests[`s${sample}`] = inputRequired.createMessage({
              messages: [{ role: "user", content: { type: "text", text: `Sample ${sample}` } }],
              maxTokens: 100,
            });
          }

          return inputRequired({ inputRequests, requestState: `round-${round + 1}` });
        }

        try {
          // SAFETY: the test gives a form's schema, which the SDK's own check reads.
          const params = {
            message,
            requestedSchema: (requestedSchema ?? { type: "object", properties: {} }) as never,
          };

          // `ctx.mcpReq.elicitInput` sends on the standalone stream too; `send` is related to this call's request.
          const answer =
            standalone === true
              ? await server.elicitInput(params)
              : await ctx.mcpReq.send(
                  { method: "elicitation/create", params },
                  giveUpMs === undefined ? undefined : { signal: AbortSignal.timeout(giveUpMs) },
                );

          // SAFETY: an elicitation result is JSON.
          options.asked?.push({ ...answer } as Json);

          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        } catch (error) {
          const text = error instanceof Error ? error.message : "failed";

          options.asked?.push({ error: text });

          return { isError: true, content: [{ type: "text", text }] };
        }
      }

      case "sample": {
        const { rounds, params, standalone, giveUpMs } = Schema.decodeUnknownSync(SampleArguments)(
          request.params.arguments,
        );

        // SAFETY: the test gives the request's parameters, which the SDK's own check reads.
        const asked = {
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
          maxTokens: 100,
          ...(params as object),
        } as never;

        let answer: unknown;

        try {
          for (let round = 0; round < (rounds ?? 1); round++) {
            answer =
              standalone === true
                ? await server.createMessage(asked)
                : await ctx.mcpReq.send(
                    { method: "sampling/createMessage", params: asked },
                    giveUpMs === undefined ? undefined : { signal: AbortSignal.timeout(giveUpMs) },
                  );

            // SAFETY: a sampling result is JSON.
            options.sampled?.push({ ...(answer as object) } as Json);
          }

          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        } catch (error) {
          const text = error instanceof Error ? error.message : "failed";

          const code =
            Predicate.hasProperty(error, "code") && Predicate.isNumber(error.code)
              ? error.code
              : undefined;

          options.sampled?.push({ error: text, code: code ?? null });

          return { isError: true, content: [{ type: "text", text: `${code ?? "?"}: ${text}` }] };
        }
      }

      case "visit": {
        const {
          url,
          message,
          elicitationId,
          completeAfterMs,
          completeOnStandalone,
          holdMs,
          rounds,
        } = Schema.decodeUnknownSync(VisitArguments)(request.params.arguments);

        // Modern asks in an `input_required` round (`rounds`, default 1, each with the same page, keyed `page`) and reads
        // what the client answered from the retry, recording it in `asked` with the round it came back in.
        if (modern) {
          const state = ctx.mcpReq.requestState<string>();
          const round = state === undefined ? 0 : Number(state.replace("visit-", ""));
          const responses = ctx.mcpReq.inputResponses ?? {};

          if (round > 0) {
            // SAFETY: the client's answers are JSON.
            options.asked?.push({ round, responses: { ...responses } as Json });
          }

          if (round >= (rounds ?? 1)) {
            return { content: [{ type: "text", text: JSON.stringify(responses) }] };
          }

          return inputRequired({
            inputRequests: {
              page: inputRequired.elicitUrl({ url, message: message ?? "Open the page" }),
            },
            requestState: `visit-${round + 1}`,
          });
        }

        const id = elicitationId ?? "e1";

        try {
          const answer = await ctx.mcpReq.send({
            method: "elicitation/create",
            params: { mode: "url", elicitationId: id, url, message: message ?? "Open the page" },
          });

          // SAFETY: an elicitation result is JSON.
          options.asked?.push({ ...answer } as Json);

          if (answer.action === "accept" && completeAfterMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, completeAfterMs));

            const complete = {
              method: "notifications/elicitation/complete" as const,
              params: { elicitationId: id },
            };

            if (completeOnStandalone === true) await server.notification(complete);
            else await ctx.mcpReq.notify(complete);
          }

          if (holdMs !== undefined) await new Promise((resolve) => setTimeout(resolve, holdMs));

          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        } catch (error) {
          const text = error instanceof Error ? error.message : "failed";

          options.asked?.push({ error: text });

          return { isError: true, content: [{ type: "text", text }] };
        }
      }

      case "gated": {
        const { gate } = options;

        if (gate !== undefined) {
          gate.calls += 1;

          if (gate.calls <= gate.times) {
            throw new UrlElicitationRequiredError(
              Array.from({ length: gate.pages ?? 1 }, (_unused, index) => ({
                mode: "url" as const,
                elicitationId: `page-${index + 1}`,
                url: gate.url ?? "https://example.com/authorize",
                message: "Authorize first",
              })),
              "Authorization needed",
            );
          }
        }

        return { content: [{ type: "text", text: "opened" }] };
      }

      case "region": {
        const { region } = Schema.decodeUnknownSync(RegionArguments)(request.params.arguments);

        return { content: [{ type: "text", text: region }] };
      }

      case "typed": {
        const { structured } = Schema.decodeUnknownSync(TypedArguments)(request.params.arguments);
        const content = [{ type: "text" as const, text: JSON.stringify(structured ?? null) }];

        return structured === undefined ? { content } : { content, structuredContent: structured };
      }

      default: {
        const { text } = Schema.decodeUnknownSync(EchoArguments)(request.params.arguments);

        return {
          content: [
            { type: "text", text: request.params.name === "shout" ? text.toUpperCase() : text },
          ],
        };
      }
    }
  });

  return server;
};

const readRpc = async (request: Request): Promise<RpcBody | undefined> => {
  if (request.method !== "POST") {
    return undefined;
  }

  try {
    // SAFETY: a fake reads the body only to record it; malformed bodies record as absent.
    return (await request.clone().json()) as RpcBody;
  } catch {
    return undefined;
  }
};

const recording = (handle: (request: Request) => Promise<Response>): FakeServer => {
  const received: Array<Received> = [];

  return {
    received,
    handle: async (request) => {
      received.push({
        method: request.method,
        url: request.url,
        headers: new Headers(request.headers),
        rpc: await readRpc(request),
      });

      return handle(request);
    },
  };
};

/**
 * A Modern (`2026-07-28`) server: stateless, and answering any Legacy request as unsupported. `notify` publishes a
 * change to the open `subscriptions/listen` streams, as the SDK's handler does.
 */
export const modernServer = (
  options?: FakeOptions,
): FakeServer & Pick<McpHttpHandler, "notify"> => {
  const handler = createMcpHandler(() => fakeMcp(undefined, options, true), { legacy: "reject" });

  return { ...recording(handler.fetch), notify: handler.notify };
};

/** A Legacy server with no sessions: each POST is answered by a fresh server; GET and DELETE are 405. */
export const legacyStatelessServer = (options?: FakeOptions): FakeServer =>
  recording(async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await fakeMcp(undefined, options).connect(transport);

    return transport.handleRequest(request);
  });

/**
 * A Legacy server with sessions: answers on SSE, keeps a GET stream per session (recording what the client reads of
 * it), and forgets sessions on demand.
 */
export const legacyStatefulServer = (options?: FakeOptions) => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, Server>();
  const streamed: Array<string> = [];
  let next = 0;

  /** `response`, with what the client reads of a GET stream recorded in `streamed`. */
  const recordStream = (request: Request, response: Response) => {
    if (request.method !== "GET" || response.body === null) {
      return response;
    }

    const decoder = new TextDecoder();

    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          streamed.push(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
      }),
    );

    return new Response(body, response);
  };

  const fake = recording(async (request) => {
    const id = request.headers.get("mcp-session-id");

    if (id !== null) {
      const transport = sessions.get(id);

      return transport === undefined
        ? Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } },
            { status: 404 },
          )
        : recordStream(request, await transport.handleRequest(request));
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${++next}`,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
        servers.set(sessionId, server);
      },
    });

    // A notification on the GET stream with every call, as servers announcing changes do.
    const server = fakeMcp(
      (each) => each.notification({ method: "notifications/tools/list_changed" }),
      options,
    );

    await server.connect(transport);

    return transport.handleRequest(request);
  });

  return {
    ...fake,
    sessions,
    /** The text the client has read of the GET streams. */
    streamed,
    /** Forget every session, as a restarted server does. */
    forget: () => sessions.clear(),
    /** Tell every session's GET stream that the resource `uri` was updated. */
    update: async (uri: string) => {
      await Promise.all([...servers.values()].map((each) => each.sendResourceUpdated({ uri })));
    },
    /** Tell every session's GET stream that a list changed. */
    listChanged: async (list: "tools" | "prompts" | "resources") => {
      await Promise.all(
        [...servers.values()].map((each) =>
          each.notification({ method: `notifications/${list}/list_changed` }),
        ),
      );
    },
    /** Close every session's GET stream, as a server cutting them does; the sessions stay. */
    cutStreams: async () => {
      await Promise.all([...sessions.values()].map((each) => each.close()));
    },
  };
};

/**
 * A hostile server: `answer` may answer a request itself (by its JSON-RPC body), else `base` does. Used for cut
 * streams, oversize bodies, bad headers and odd error bodies.
 */
export const hostileServer = (
  base: FakeServer,
  answer: (request: Request, rpc: RpcBody | undefined) => Response | undefined,
): FakeServer =>
  recording(async (request) => answer(request, await readRpc(request)) ?? base.handle(request));

/** The `fetch` the core is given: every request goes to `server`, by any URL. */
export const fetchTo =
  (server: FakeServer): typeof fetch =>
  async (input, init) =>
    server.handle(new Request(input, init));

/** The JSON-RPC requests (not notifications) a fake received, by method. */
export const rpcMethods = (server: FakeServer) =>
  server.received.flatMap((received) =>
    received.rpc?.method !== undefined && received.rpc.id !== undefined
      ? [received.rpc.method]
      : [],
  );

/** An SSE response carrying `events` as `message` events, then ending. */
export const sse = (events: ReadonlyArray<Json>) =>
  new Response(
    events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

// ---------------------------------------------------------------------------------------------------------------------
// A fake Modern task server (`docs/architecture/mcp-server-requests.md` → Testing): a Modern server that advertises
// `io.modelcontextprotocol/tasks` and answers a `tools/call` of `report` with an MCP task when the request declares the
// extension, and `tasks/get`, `tasks/update` and `tasks/cancel` for the tasks it made. `@modelcontextprotocol/ext-tasks`
// (0.2.x, a devDependency only) has the requester's side of the wire and no server's, so the fake speaks the wire
// itself, from its schemas (`core/v2`), and checks what the spec asks of a client: the standard headers
// (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` mirroring `taskId`) and the extension in the request's `_meta`.
// ---------------------------------------------------------------------------------------------------------------------

/** The MCP tasks extension's id. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * The tool the task server answers with a task. Its arguments pick what the task does: `region` goes in an
 * `Mcp-Param-Region` header; `polls` is how many `tasks/get` it takes to complete (default 1); `bytes` makes the
 * result that much text; `inline` answers at once as a synchronous call does, even to a client that declared the
 * extension; `ask` makes the task wait for an answer to a form (`tasks/update`) before it completes, `sample` for the answer to
 * a Sampling request, `page` for a URL-mode page and `unsupported` for a form cloudpid cannot take; `lag` keeps it
 * `input_required` for that many polls after the answer; `fail` ends it `failed`.
 */
export const REPORT_TOOL = {
  name: "report",
  description: "Make a report, as an MCP task if the client can wait for one.",
  inputSchema: {
    type: "object" as const,
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      polls: { type: "number" },
      bytes: { type: "number" },
      inline: { type: "boolean" },
      ask: { type: "boolean" },
      sample: { type: "boolean" },
      page: { type: "boolean" },
      unsupported: { type: "boolean" },
      lag: { type: "number" },
      fail: { type: "boolean" },
    },
  },
};

/** What a task of the fake is doing: its status, the polls it still takes and what it ends with. */
export interface FakeTask {
  readonly id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  pollsLeft: number;
  readonly text: string;
  /** The answers `tasks/update` brought, by key. */
  answers: { readonly [key: string]: Json } | undefined;
  /** What it asks while `input_required`. */
  readonly question: "form" | "sample" | "page" | "unsupported";
  /** The polls it stays `input_required` after the answer. */
  lag: number;
  /** The `tasks/update` it was sent. */
  updates: number;
  readonly fail: boolean;
}

export interface TaskServerOptions extends FakeOptions {
  /** Answer a `report` call from a client that did not declare the extension with `-32021`, as a task-only tool does. */
  readonly requireTask?: boolean;
  /** Do not advertise the extension. */
  readonly unadvertised?: boolean;
  /** Answer a `report` call with a task even to a client that did not declare the extension, as a broken server does. */
  readonly alwaysTask?: boolean;
  /** `pollIntervalMs` in every task the server reports. */
  readonly pollIntervalMs?: number;
  /** Make `report` a tool of an App (`_meta.ui.resourceUri`), which Views may call too. */
  readonly appUri?: string;
}

export interface TaskServer extends FakeServer {
  readonly tasks: Map<string, FakeTask>;
  /** Whether each request declared the tasks extension in its `_meta`, by method. */
  readonly declared: Array<{ readonly method: string; readonly tasks: boolean }>;
}

/** The client's declaration in a request's `_meta`: the extensions it names. */
const Meta = Schema.Struct({
  "io.modelcontextprotocol/clientCapabilities": Schema.optionalKey(
    Schema.Struct({
      extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
});

const ReportCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(
    Schema.Struct({
      region: Schema.optionalKey(Schema.String),
      polls: Schema.optionalKey(Schema.Int),
      bytes: Schema.optionalKey(Schema.Int),
      inline: Schema.optionalKey(Schema.Boolean),
      ask: Schema.optionalKey(Schema.Boolean),
      sample: Schema.optionalKey(Schema.Boolean),
      page: Schema.optionalKey(Schema.Boolean),
      unsupported: Schema.optionalKey(Schema.Boolean),
      lag: Schema.optionalKey(Schema.Int),
      fail: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  _meta: Schema.optionalKey(Meta),
});

const TaskCall = Schema.Struct({
  taskId: Schema.String,
  inputResponses: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  _meta: Schema.optionalKey(Meta),
});

const decodeReportCall = Schema.decodeUnknownOption(ReportCall);

const decodeTaskCall = Schema.decodeUnknownOption(TaskCall);

const rpcError = (id: string | number | undefined, code: number, message: string, data?: Json) =>
  Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data },
    },
    { status: 400 },
  );

const rpcResult = (
  id: string | number | undefined,
  result: { readonly [key: string]: Json | undefined },
) => Response.json({ jsonrpc: "2.0", id: id ?? null, result });

const ID_PATTERN = /^[a-z0-9-]+$/;

const CREATED_AT = "2026-01-01T00:00:00.000Z";

/** A header value, with a `=?base64?<UTF-8 in base64>?=` wrapper (SEP-2243) taken off. */
const decodedHeader = (value: string | null): string | null => {
  if (value === null || !value.startsWith("=?base64?") || !value.endsWith("?=")) return value;

  const bytes = Uint8Array.from(atob(value.slice(9, -2)), (char) => char.codePointAt(0) ?? 0);

  return new TextDecoder().decode(bytes);
};

const TASKS_REQUIRED = {
  requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
};

/** A Modern server that advertises MCP tasks and answers `report` with one. */
export const modernTaskServer = (options: TaskServerOptions = {}): TaskServer => {
  const base = modernServer({
    ...options,
    listMore: true,
    moreTools: [
      ...(options.moreTools ?? []),
      options.appUri === undefined
        ? REPORT_TOOL
        : { ...REPORT_TOOL, _meta: { ui: { resourceUri: options.appUri } } },
    ],
    extensions: options.unadvertised === true ? undefined : { [TASKS_EXTENSION]: {} },
  });

  const tasks = new Map<string, FakeTask>();
  const declared: TaskServer["declared"] = [];
  let next = 0;

  const view = (task: FakeTask) => ({
    taskId: task.id,
    status: task.status,
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
    ttlMs: 60_000,
    statusMessage: task.status === "working" ? "Making the report" : task.status,
    pollIntervalMs: options.pollIntervalMs,
  });

  /** The `inputRequests` of a task that waits for input. */
  const questionOf = (task: FakeTask) => {
    switch (task.question) {
      case "sample":
        return {
          summary: {
            method: "sampling/createMessage",
            params: {
              messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
              maxTokens: 100,
            },
          },
        };
      case "page":
        return {
          visit: {
            method: "elicitation/create",
            params: {
              mode: "url",
              message: "Sign in",
              url: "https://login.example.com/go",
              elicitationId: "e1",
            },
          },
        };
      case "unsupported":
        return {
          which: {
            method: "elicitation/create",
            params: {
              message: "Which region?",
              requestedSchema: {
                type: "object",
                properties: { nested: { type: "object", properties: {} } },
              },
            },
          },
        };
      default:
        return {
          which: {
            method: "elicitation/create",
            params: {
              message: "Which region?",
              requestedSchema: { type: "object", properties: {} },
            },
          },
        };
    }
  };

  const snapshot = (task: FakeTask) => {
    switch (task.status) {
      case "input_required":
        return {
          ...view(task),
          inputRequests: questionOf(task),
        };
      case "completed":
        return {
          ...view(task),
          result: { resultType: "complete", content: [{ type: "text", text: task.text }] },
        };
      case "failed":
        return { ...view(task), error: { code: -32000, message: "the report failed" } };
      default:
        return view(task);
    }
  };

  /** The `Mcp-*` headers a Modern request must carry, against its body. */
  const headerProblem = (request: Request, method: string, name: string | undefined) => {
    if (request.headers.get("mcp-protocol-version") !== "2026-07-28") {
      return "MCP-Protocol-Version is not 2026-07-28";
    }

    if (request.headers.get("mcp-method") !== method) return "Mcp-Method does not match the body";

    if (name !== undefined && request.headers.get("mcp-name") !== name) {
      return "Mcp-Name does not match the body";
    }

    return undefined;
  };

  const report = (
    id: string | number,
    request: Request,
    call: typeof ReportCall.Type,
    extensions: ReadonlyArray<string>,
  ) => {
    declared.push({ method: "tools/call", tasks: extensions.includes(TASKS_EXTENSION) });

    const given = call.arguments ?? {};
    const region = given.region ?? "";

    // The `Mcp-Param` header a tool's `x-mcp-header` asks for must mirror the argument.
    if (region !== "" && decodedHeader(request.headers.get("mcp-param-region")) !== region) {
      return rpcError(id, -32020, "Mcp-Param-Region does not match the arguments");
    }

    const text = (given.bytes ?? 0) > 0 ? "x".repeat(given.bytes ?? 0) : `report:${region}`;
    const complete = { resultType: "complete", content: [{ type: "text", text }] };

    if (!extensions.includes(TASKS_EXTENSION) && options.alwaysTask !== true) {
      return options.requireTask === true
        ? rpcError(id, -32021, "This tool runs only as an MCP task", TASKS_REQUIRED)
        : rpcResult(id, complete);
    }

    const problem = headerProblem(request, "tools/call", "report");

    if (problem !== undefined) return rpcError(id, -32020, problem);

    if (given.inline === true) return rpcResult(id, complete);

    next += 1;

    const task: FakeTask = {
      id: `task-${next}`,
      status:
        given.ask === true ||
        given.sample === true ||
        given.page === true ||
        given.unsupported === true
          ? "input_required"
          : "working",
      pollsLeft: given.polls ?? 1,
      text,
      answers: undefined,
      question:
        given.sample === true
          ? "sample"
          : given.page === true
            ? "page"
            : given.unsupported === true
              ? "unsupported"
              : "form",
      lag: given.lag ?? 0,
      updates: 0,
      fail: given.fail === true,
    };

    tasks.set(task.id, task);

    return rpcResult(id, { resultType: "task", ...view(task) });
  };

  const taskMethod = (
    id: string | number,
    request: Request,
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    call: typeof TaskCall.Type,
    extensions: ReadonlyArray<string>,
  ) => {
    declared.push({ method, tasks: extensions.includes(TASKS_EXTENSION) });

    if (!ID_PATTERN.test(call.taskId)) return rpcError(id, -32602, "taskId is required");

    const problem = headerProblem(request, method, call.taskId);

    if (problem !== undefined) return rpcError(id, -32020, problem);

    if (!extensions.includes(TASKS_EXTENSION)) {
      return rpcError(id, -32021, "tasks/* needs the tasks extension", TASKS_REQUIRED);
    }

    const task = tasks.get(call.taskId);

    if (task === undefined) return rpcError(id, -32602, "Unknown task");

    switch (method) {
      case "tasks/get": {
        // An answered task stays `input_required` for `lag` polls, as a server slow to move on does.
        if (task.status === "input_required" && task.answers !== undefined) {
          if (task.lag > 0) task.lag -= 1;
          else task.status = "working";
        }

        if (task.status === "working") {
          task.pollsLeft -= 1;

          if (task.pollsLeft <= 0) task.status = task.fail ? "failed" : "completed";
        }

        return rpcResult(id, { resultType: "complete", ...snapshot(task) });
      }

      case "tasks/update": {
        if (task.status === "input_required" && call.inputResponses !== undefined) {
          task.updates += 1;
          task.answers = call.inputResponses;

          if (task.lag === 0) task.status = "working";
        }

        return rpcResult(id, { resultType: "complete" });
      }

      case "tasks/cancel": {
        if (task.status === "working" || task.status === "input_required") {
          task.status = "cancelled";
        }

        return rpcResult(id, { resultType: "complete" });
      }
    }
  };

  const handle = async (request: Request): Promise<Response | undefined> => {
    const rpc = await readRpc(request);

    if (rpc?.method === undefined || rpc.id === undefined) return undefined;

    const { id, method, params } = rpc;

    if (method === "tools/call") {
      const call = Option.getOrUndefined(decodeReportCall(params));

      return call?.name === "report"
        ? report(id, request, call, extensionsOf(call._meta))
        : undefined;
    }

    if (method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel") {
      const call = Option.getOrUndefined(decodeTaskCall(params));

      return call === undefined
        ? rpcError(id, -32602, "taskId is required")
        : taskMethod(id, request, method, call, extensionsOf(call._meta));
    }

    return undefined;
  };

  const fake = recording(async (request) => (await handle(request)) ?? base.handle(request));

  return { ...fake, tasks, declared };
};

/** The extensions a request's `_meta` declares the client has. */
const extensionsOf = (meta: typeof Meta.Type | undefined) =>
  Record.keys(meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions ?? {});
