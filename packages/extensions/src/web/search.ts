// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off
// `web_search`: Exa or Parallel, over their hosted MCP endpoints. Ported from pi-web-tools' `src/web-search.ts` (see
// ../../NOTICE.md). The keys are deploy-time secrets (`WebConfig`); with neither set the tool says so.
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WebConfig } from "./config.ts";
import { WebToolError } from "./errors.ts";
import { fitOutput } from "./output.ts";
import { discardBody, readBoundedBody, statusCause } from "./response.ts";
import { WebTransport } from "./transport.ts";

export type SearchProvider = "exa" | "parallel";

const EXA_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const DEFAULT_NUM_RESULTS = 8;

/** Default total budget for Search Provider text, in Unicode code points. */
const DEFAULT_CONTEXT_MAX_CHARACTERS = 6000;
const MAX_CONTEXT_MAX_CHARACTERS = 50_000;

/** Longest `objective` Exa's `web_search_exa` schema accepts, in characters. */
const EXA_OBJECTIVE_MAX_CHARACTERS = 4096;
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_PROVIDER_MESSAGE_CHARACTERS = 500;
const NO_SEARCH_RESULTS = "No search results found. Please try a different query.";
const EXA_RATE_LIMITED_META = "ai.exa/rateLimited";

/** Total request budget, including reading the response. */
export const WEB_SEARCH_TIMEOUT_MS = 25_000;

const WebSearchParameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Web Search query" }),
  numResults: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: `Maximum number of results (default: ${DEFAULT_NUM_RESULTS}, maximum: 20). Exa applies it; for Parallel, the returned result list is trimmed to this count.`,
    }),
  ),
  contextMaxCharacters: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CONTEXT_MAX_CHARACTERS }),
    ).annotate({
      description: `Maximum characters of Search Provider text returned (1–50,000, default: 6,000). Exa results share it so each keeps its Title and URL; other text is cut at that many code points. Cuts are marked; raise it to read more.`,
    }),
  ),
});

/** What programs (code mode) receive: the provider's text, trimmed to `numResults` (Parallel) and cut at `contextMaxCharacters`. */
export const WebSearchOutput = Schema.Struct({
  provider: Schema.Literals(["exa", "parallel"]),
  content: Schema.String.annotate({
    description:
      "Search Provider's text answer, trimmed to numResults (Parallel) and cut at contextMaxCharacters (default 6,000)",
  }),
});

const DESCRIPTION =
  "Discover current public web information using Exa or Parallel. Results are textual, cut at 6,000 characters by default and shared across results (see contextMaxCharacters), and model-visible output is truncated to 50 KiB or 2,000 lines.";

type SearchArguments = typeof WebSearchParameters.Type;

const providerName = (provider: SearchProvider): string =>
  provider === "exa" ? "Exa" : "Parallel";

/** OpenCode's stable FNV-1a checksum, so a Session picks the same provider on every call. */
const fnv1aChecksum = (content: string): string | undefined => {
  if (content.length === 0) return undefined;

  let hash = 0x811c9dc5;

  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
};

/**
 * The provider for `sessionId`: the only one with a key, or, with both, one chosen by a stable hash of the ID so
 * a conversation keeps its provider. None when neither key is set.
 */
export const selectSearchProvider = (
  keys: { readonly exa: boolean; readonly parallel: boolean },
  sessionId: string,
): SearchProvider | undefined => {
  if (keys.exa && keys.parallel) {
    return Number.parseInt(fnv1aChecksum(sessionId) ?? "0", 36) % 2 === 0 ? "exa" : "parallel";
  }

  if (keys.exa) return "exa";

  return keys.parallel ? "parallel" : undefined;
};

/** The first `limit` Unicode code points of `text`. */
const truncateCodePoints = (text: string, limit: number): string =>
  // UTF-16 length never undercounts code points, so shorter text is certainly within the limit.
  text.length <= limit ? text : Arr.join(Arr.take(Array.from(text), limit), "");

// --- Provider responses ----------------------------------------------------------------------------------------

const McpResponse = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))),
  method: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
      isError: Schema.optional(Schema.Boolean),
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Finite),
      message: Schema.optional(Schema.String),
    }),
  ),
});

type McpResponse = typeof McpResponse.Type;

const decodeMcpResponse = Schema.decodeUnknownOption(Schema.fromJsonString(McpResponse));

/** The request id sent, which a provider echoes on its response. */
const REQUEST_ID = 1;

/** Turns provider-controlled text into one short, key-free, control-free line. */
type Sanitize = (text: string) => string;

const withDetail = (summary: string, detail: string): string =>
  detail === "" ? summary : `${summary}: ${detail}`;

const describeJsonRpcError = (
  provider: SearchProvider,
  error: NonNullable<McpResponse["error"]>,
  sanitize: Sanitize,
): string =>
  withDetail(
    `${providerName(provider)} returned error${error.code === undefined ? "" : ` ${error.code}`}`,
    sanitize(error.message ?? ""),
  );

/** What one JSON-RPC payload says: nothing for us, the provider's text, or a failure it reported. */
type Payload =
  | { readonly kind: "skipped" }
  | { readonly kind: "result"; readonly text: string | undefined }
  | { readonly kind: "failure"; readonly message: string };

const firstText = (content: NonNullable<McpResponse["result"]>["content"]): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(
      Arr.findFirst(
        content ?? [],
        ({ type, text }) => type === "text" && text !== undefined && text.length > 0,
      ),
      ({ text }) => Option.fromUndefinedOr(text),
    ),
  );

const parsePayload = (payload: string, provider: SearchProvider, sanitize: Sanitize): Payload => {
  const trimmed = payload.trim();

  if (!trimmed.startsWith("{")) return { kind: "skipped" };

  const decoded = decodeMcpResponse(trimmed);

  if (Option.isNone(decoded))
    return {
      kind: "failure",
      message: `${providerName(provider)} returned an unrecognized response`,
    };

  const response = decoded.value;

  // Notifications carry a method but no result or error; responses to other requests are not ours.
  if (response.result === undefined && response.error === undefined) return { kind: "skipped" };

  if (response.id !== undefined && response.id !== null && response.id !== REQUEST_ID) {
    return { kind: "skipped" };
  }

  if (response.error !== undefined) {
    return { kind: "failure", message: describeJsonRpcError(provider, response.error, sanitize) };
  }

  const result = response.result;

  if (result === undefined) return { kind: "skipped" };

  const text = firstText(result.content);
  const detail = text === undefined ? "" : sanitize(text);

  if (provider === "exa" && result._meta?.[EXA_RATE_LIMITED_META] === true) {
    return { kind: "failure", message: withDetail("Exa rate limit reached", detail) };
  }

  if (result.isError === true) {
    return {
      kind: "failure",
      message: withDetail(`${providerName(provider)} reported an error`, detail),
    };
  }

  return { kind: "result", text };
};

/** Split a Server-Sent Events body into events, joining each event's `data:` lines with newlines. */
const sseEventPayloads = (body: string): string[] => {
  const events: string[] = [];
  let data: string[] = [];

  const flush = (): void => {
    if (data.length > 0) events.push(Arr.join(data, "\n"));

    data = [];
  };

  for (const line of body.split(/\r\n|\n|\r/)) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }

  flush();

  return events;
};

/**
 * The answer to our request from a JSON or SSE body. The first payload carrying text or a failure decides, so a later
 * error never replaces an earlier answer. `text` is undefined for a valid result without text.
 */
const parseMcpResponse = (
  body: string,
  provider: SearchProvider,
  sanitize: Sanitize,
): { readonly text: string | undefined } | { readonly failure: string } => {
  const trimmed = body.trim();
  const payloads = trimmed.startsWith("{") ? [trimmed] : sseEventPayloads(body);
  let sawResult = false;

  for (const payload of payloads) {
    const parsed = parsePayload(payload, provider, sanitize);

    if (parsed.kind === "skipped") continue;

    if (parsed.kind === "failure") return { failure: parsed.message };

    sawResult = true;

    if (parsed.text !== undefined) return { text: parsed.text };
  }

  return sawResult
    ? { text: undefined }
    : { failure: `${providerName(provider)} returned an unrecognized response` };
};

// --- Keys never reach the model --------------------------------------------------------------------------------

const secretVariants = (secret: string): string[] => [
  secret,
  encodeURIComponent(secret),
  new URLSearchParams({ k: secret }).toString().slice(2),
];

/** Remove the API keys, in every encoding a URL might carry, from echoed text. */
const redactKeys = (message: string, keys: readonly string[]): string =>
  Arr.reduce(keys, message, (text, key) =>
    key === ""
      ? text
      : Arr.reduce(secretVariants(key), text, (redacted, variant) =>
          redacted.replaceAll(variant, "[REDACTED]"),
        ),
  );

// Terminal escape sequences start with ESC; they are removed from provider text.
const TERMINAL_SEQUENCE =
  // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching ESC and BEL is the purpose of this expression.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

// oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Matching control characters is the purpose of this expression.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * The sanitizer for text a Search Provider controls. Keys are redacted before anything is cut and again after control
 * characters are removed, so no key fragment survives truncation.
 */
const providerTextSanitizer =
  (keys: readonly string[]): Sanitize =>
  (text) => {
    const stripped = redactKeys(text, keys)
      .replace(TERMINAL_SEQUENCE, "")
      .replace(CONTROL_CHARACTERS, "")
      .replace(/\p{Cf}/gu, "");

    const collapsed = redactKeys(stripped, keys).replace(/\s+/g, " ").trim();

    return truncateCodePoints(collapsed, MAX_PROVIDER_MESSAGE_CHARACTERS) === collapsed
      ? collapsed
      : `${truncateCodePoints(collapsed, MAX_PROVIDER_MESSAGE_CHARACTERS)}…`;
  };

// --- Shaping the answer ----------------------------------------------------------------------------------------

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Parallel's `web_search` has no result-count field, but its text is a pretty-printed JSON object with a `results`
 * array. Trim that array to `numResults` and print it the same way; anything else is returned unchanged.
 */
const limitResultCount = (provider: SearchProvider, text: string, numResults: number): string => {
  if (provider !== "parallel") return text;

  const decoded = decodeJsonObject(text);

  if (Option.isNone(decoded)) return text;

  const { results } = decoded.value;

  if (!Array.isArray(results) || results.length <= numResults) return text;

  return JSON.stringify({ ...decoded.value, results: Arr.take(results, numResults) }, null, 2);
};

/** Starts one Exa result: a `Title:` line directly followed by its `URL:` line. */
const EXA_RESULT_START = /(?:^|\n\n)(?=Title: [^\n]*\nURL: )/;
const EXA_RESULT_SEPARATOR = "\n\n";

/** Exa's metadata keys; the first line with any other key (`Highlights:`, `Text:`, ...) opens the body. */
const EXA_HEADER_LINE = /^(?:Title|URL|Published Date|Published|Author|Image|Favicon|ID|Score): /;

/** The lines a model needs to choose a URL for `web_fetch`. */
const EXA_ESSENTIAL_LINE = /^(?:Title|URL): /;

/** A metadata line Exa fills with `N/A`; it tells the model nothing and only spends budget. */
const EXA_EMPTY_HEADER_LINE = /^[^:]+: N\/A$/;

/** Below this many code points a body share shows only a stub such as `Hi` (from `Highlights:`), so the body is dropped. */
const MIN_USEFUL_BODY_CHARACTERS = 80;

/** One Exa result: all metadata lines, just Title and URL, and the body that follows the metadata. */
type ExaResult = {
  readonly header: string;
  readonly essentialHeader: string;
  readonly body: string;
};

const splitExaResults = (text: string): ExaResult[] | undefined => {
  const blocks = Arr.filter(text.split(EXA_RESULT_START), (block) => block !== "");

  if (blocks.length === 0 || !Arr.every(blocks, (block) => block.startsWith("Title: "))) {
    return undefined;
  }

  return Arr.map(blocks, (block) => {
    const lines = block.split("\n");
    let count = 0;

    while (count < lines.length && EXA_HEADER_LINE.test(lines[count] ?? "")) count++;

    const headerLines = lines.slice(0, count);

    return {
      header: Arr.join(
        Arr.filter(
          headerLines,
          (line) => EXA_ESSENTIAL_LINE.test(line) || !EXA_EMPTY_HEADER_LINE.test(line),
        ),
        "\n",
      ),
      essentialHeader: Arr.join(
        Arr.filter(headerLines, (line) => EXA_ESSENTIAL_LINE.test(line)),
        "\n",
      ),
      body: block.slice(Arr.join(headerLines, "\n").length),
    };
  });
};

const joinExaResults = (results: readonly ExaResult[]): string =>
  Arr.join(
    Arr.map(results, ({ header, body }) => header + body),
    EXA_RESULT_SEPARATOR,
  );

/**
 * The hint for reading more. The model did not choose the default budget, so only a default cut says how to raise it;
 * an explicit budget is already the model's own choice.
 */
const moreHint = (explicit: number | undefined): string =>
  explicit === undefined
    ? `; pass contextMaxCharacters (up to ${MAX_CONTEXT_MAX_CHARACTERS}) for more`
    : "";

type Body = { readonly length: number; readonly index: number };

const byIndex = Order.mapInput(Order.Number, (body: Body) => body.index);

const byLengthThenIndex = Order.combine(
  Order.mapInput(Order.Number, (body: Body) => body.length),
  byIndex,
);

/** Split `budget` code points over bodies: short ones keep all, the rest share what remains evenly. */
const shareBodyBudget = (lengths: readonly number[], budget: number): number[] => {
  const shares = [...lengths];
  let remaining = budget;

  let pending = Arr.sort(
    Arr.map(lengths, (length, index): Body => ({ length, index })),
    byLengthThenIndex,
  );

  while (pending.length > 0) {
    const fair = Math.floor(remaining / pending.length);
    const first = pending[0];

    if (first === undefined || first.length > fair) break;

    remaining -= first.length;
    pending = pending.slice(1);
  }

  let extra = pending.length === 0 ? 0 : remaining % pending.length;
  const fair = pending.length === 0 ? 0 : Math.floor(remaining / pending.length);

  for (const { index } of Arr.sort(pending, byIndex)) {
    shares[index] = fair + (extra > 0 ? 1 : 0);

    if (extra > 0) extra--;
  }

  return shares;
};

/**
 * Split `limit` code points across an Exa result list so every result keeps its header lines and a fair share of its
 * body. When the full headers do not fit, only each Title and URL line is kept. A body whose share is too small to
 * read is dropped. Undefined when even the Title and URL lines do not fit, so the caller falls back to one plain cut.
 */
const shareSearchBudget = (
  results: readonly ExaResult[],
  limit: number,
  explicit: number | undefined,
): string | undefined => {
  const separators = EXA_RESULT_SEPARATOR.length * (results.length - 1);

  const fixedLength = (headers: readonly string[]): number =>
    Arr.reduce(headers, separators, (sum, header) => sum + Array.from(header).length);

  let headers = Arr.map(results, ({ header }) => header);
  let reduced = false;

  if (fixedLength(headers) > limit) {
    headers = Arr.map(results, ({ essentialHeader }) => essentialHeader);
    reduced = true;

    if (fixedLength(headers) > limit) return undefined;
  }

  const bodies = Arr.map(results, ({ body }) => Array.from(body));

  const shares = shareBodyBudget(
    Arr.map(bodies, (body) => body.length),
    limit - fixedLength(headers),
  );

  const cut: number[] = [];

  const kept = Arr.map(headers, (header, index) => {
    const body = bodies[index] ?? [];
    const fullShare = shares[index] ?? 0;

    if (body.length <= fullShare) return header + Arr.join(body, "");

    cut.push(index + 1);

    const share = fullShare < MIN_USEFUL_BODY_CHARACTERS ? 0 : fullShare;

    return header + Arr.join(Arr.take(body, share), "");
  });

  const label = cut.length === 1 ? "result" : "results";

  const shortened =
    cut.length === 0 ? "" : `; ${label} ${Arr.join(Arr.map(cut, String), ", ")} shortened`;

  const dropped = reduced ? "; metadata other than Title and URL dropped" : "";

  return `${Arr.join(kept, EXA_RESULT_SEPARATOR)}\n\n[Search results cut at ${limit} characters, shared across ${results.length} results${shortened}${dropped}${moreHint(explicit)}; web_fetch a result's URL for the full page]`;
};

/**
 * Cut provider text at `contextMaxCharacters` code points (default 6,000), then mark the cut. An Exa result list
 * shares that budget so each result keeps its Title and URL; other text is cut once.
 */
export const limitSearchText = (providerText: string, explicit: number | undefined): string => {
  const limit = explicit ?? DEFAULT_CONTEXT_MAX_CHARACTERS;
  const results = splitExaResults(providerText);
  const text = results === undefined ? providerText : joinExaResults(results);
  const kept = truncateCodePoints(text, limit);

  if (kept === text) return text;

  const shared = results === undefined ? undefined : shareSearchBudget(results, limit, explicit);

  return shared ?? `${kept}\n\n[Search results cut at ${limit} characters${moreHint(explicit)}]`;
};

// --- Calling a provider ----------------------------------------------------------------------------------------

type ProviderRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

const providerRequest = (
  provider: SearchProvider,
  key: string,
  args: SearchArguments,
  sessionId: string,
): ProviderRequest => {
  if (provider === "exa") {
    // The key goes in a header, not the URL (`?exaApiKey=`): URLs are logged, headers are not.
    return {
      url: EXA_URL,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: REQUEST_ID,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          // Exa's current `web_search_exa` schema requires `objective` next to `query`.
          arguments: {
            query: args.query,
            objective: truncateCodePoints(args.query, EXA_OBJECTIVE_MAX_CHARACTERS),
            numResults: args.numResults ?? DEFAULT_NUM_RESULTS,
          },
        },
      }),
    };
  }

  return {
    url: PARALLEL_URL,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "cloudpid-web-tools",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: REQUEST_ID,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { objective: args.query, search_queries: [args.query], session_id: sessionId },
      },
    }),
  };
};

/** The provider's explanation of a failed status: the HTTP cause, and the JSON-RPC error a small JSON body carried. */
const httpFailure = Effect.fn("web_search.httpFailure")(function* (
  response: Response,
  provider: SearchProvider,
  sanitize: Sanitize,
) {
  const cause = statusCause(response.status);

  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    yield* discardBody(response);

    return cause;
  }

  const body = yield* readBoundedBody(response, MAX_ERROR_BODY_BYTES).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.option,
  );

  const error = Option.flatMap(body, decodeMcpResponse).pipe(
    Option.flatMapNullishOr((parsed) => parsed.error),
  );

  return Option.match(error, {
    onNone: () => cause,
    onSome: (rpc) => withDetail(cause, describeJsonRpcError(provider, rpc, sanitize)),
  });
});

const searchProvider = Effect.fn("web_search.searchProvider")(function* (
  provider: SearchProvider,
  key: string,
  keys: readonly string[],
  args: SearchArguments,
  sessionId: string,
) {
  const transport = yield* WebTransport;
  const sanitize = providerTextSanitizer(keys);
  const request = providerRequest(provider, key, args, sessionId);
  const response = yield* transport.fetch({ ...request, method: "POST" });

  if (!response.ok) {
    return yield* WebToolError.make({ message: yield* httpFailure(response, provider, sanitize) });
  }

  const body = yield* readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES);
  const parsed = parseMcpResponse(new TextDecoder().decode(body), provider, sanitize);

  if ("failure" in parsed) return yield* WebToolError.make({ message: parsed.failure });

  return parsed.text;
});

/** `web_search`. */
export const WebSearch = defineEffectTool({
  name: "web_search",
  description: DESCRIPTION,
  parameters: WebSearchParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(WebSearchOutput).schema,
  execute: Effect.fnUntraced(function* (args, api: ToolExecutionApi) {
    const config = yield* WebConfig;

    const unable = (cause: string) =>
      WebToolError.make({ message: `Unable to search the web for ${args.query}: ${cause}` });

    if (args.query.trim() === "") {
      return yield* WebToolError.make({
        message:
          "Unable to search the web: query is empty (provide the text to search the web for)",
      });
    }

    const exa = Option.map(config.exaApiKey, Redacted.value);
    const parallel = Option.map(config.parallelApiKey, Redacted.value);
    const sessionId = String(api.conversationId);

    const provider = selectSearchProvider(
      { exa: Option.isSome(exa), parallel: Option.isSome(parallel) },
      sessionId,
    );

    if (provider === undefined) {
      return yield* WebToolError.make({
        message:
          "Web search is not configured: neither EXA_API_KEY nor PARALLEL_API_KEY is set on this deployment. Ask the owner to set one of them, or use web_fetch on a known URL.",
      });
    }

    const key = Option.getOrElse(provider === "exa" ? exa : parallel, () => "");
    const keys = Arr.getSomes([exa, parallel]);

    const search = yield* searchProvider(provider, key, keys, args, sessionId).pipe(
      Effect.timeoutOrElse({
        duration: WEB_SEARCH_TIMEOUT_MS,
        orElse: () => Effect.fail(WebToolError.make({ message: "timed out after 25 seconds" })),
      }),
      Effect.mapError((error) => unable(error.message)),
    );

    // Only real provider text is trimmed and cut; the no-results notice always reads in full.
    const numResults = args.numResults ?? DEFAULT_NUM_RESULTS;

    const text =
      search === undefined
        ? NO_SEARCH_RESULTS
        : limitSearchText(
            limitResultCount(provider, search, numResults),
            args.contextMaxCharacters,
          );

    const fitted = fitOutput(
      text,
      "Lower contextMaxCharacters or narrow the query to read less per search.",
    );

    return {
      output: [{ type: "text", text: fitted.content }],
      structuredOutput: { provider, content: text },
      details: { provider },
    };
  }),
});
