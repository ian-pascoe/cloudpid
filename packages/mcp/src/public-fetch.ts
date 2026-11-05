/**
 * A public read for cloudpid's MCP sign-in, sent from `McpWorker` (`docs/architecture/mcp-sign-in.md` → Code;
 * `docs/architecture/mcp-endpoint.md` → Self-use). The Registry reads an authorization server's metadata from the
 * Server Worker, whose `fetch` to one of cloudpid's own hosts never reaches Access there (Cloudflare refuses it, 1042, or
 * sends it to the origin past Access); `McpWorker` has `global_fetch_strictly_public`, so its `fetch` goes through the
 * front door as a client's would. `McpEngine.fetchPublic` makes the read, guarded here: an `https` GET with no credential
 * (no userinfo, no header but content negotiation), no redirect followed (the caller sees the 3xx and decides, as
 * `guardedFetch` does), the OAuth fetch's 15 s timeout and a body of at most 64 KiB. No SDK import: `./types` re-exports
 * the Schemas, and the root entry the function.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off missingPipeableSignature:off preferEffectArray:off -- the read is a Promise over `fetch`, its Schemas plain values.
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { boundedText, MAX_METADATA_BYTES, OAUTH_FETCH_TIMEOUT_MS } from "./oauth-http.ts";

/** The request headers a public read passes on: content negotiation alone, never a credential or a cookie. */
export const PUBLIC_FETCH_HEADERS: ReadonlyArray<string> = ["accept", "mcp-protocol-version"];

/** What the Registry asks `McpEngine.fetchPublic` for: a URL, and the headers to pass on (others are dropped). */
export const McpPublicFetchRequest = Schema.Struct({
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export type McpPublicFetchRequest = typeof McpPublicFetchRequest.Type;

/**
 * Its answer: the response (`code`, its headers and the whole body as text, which is a 3xx's too), or why it was not
 * read. The edge only gains: a caller reads an answer it cannot decode as a refusal.
 */
export const McpPublicFetchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("fetched"),
    code: Schema.Finite,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("refused"), message: Schema.String }),
]);

export type McpPublicFetchResult = typeof McpPublicFetchResult.Type;

const isRequest = Schema.is(McpPublicFetchRequest);

const refused = (message: string): McpPublicFetchResult => ({ status: "refused", message });

/** Why `url` is not read: not a URL, not `https`, or carrying credentials; undefined when it may be. */
export const publicFetchRefusal = (url: string): string | undefined => {
  if (!URL.canParse(url)) return "The URL is not a URL";

  const parsed = new URL(url);

  if (parsed.protocol !== "https:") return "The URL is not https";

  if (parsed.username !== "" || parsed.password !== "") return "The URL carries credentials";

  return undefined;
};

/** `headers` with only {@link PUBLIC_FETCH_HEADERS}, by lowercase name. */
const passedOn = (
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  const kept: Record<string, string> = {};

  for (const [name, value] of Record.toEntries(headers ?? {})) {
    const lower = name.toLowerCase();

    if (PUBLIC_FETCH_HEADERS.includes(lower)) kept[lower] = value;
  }

  return kept;
};

/** A status whose response may carry no body. */
const BODYLESS: ReadonlyArray<number> = [101, 204, 205, 304];

/**
 * Reads `input` with `fetch`, under the guards above. It came over RPC, so its shape is checked again. Never throws: a
 * malformed request, a refused URL, a failure, a timeout and a body over 64 KiB are each a `refused` answer.
 */
export const fetchPublic = async (
  input: McpPublicFetchRequest,
  fetch: typeof globalThis.fetch,
  timeoutMs: number = OAUTH_FETCH_TIMEOUT_MS,
): Promise<McpPublicFetchResult> => {
  if (!isRequest(input)) return refused("The request is malformed");

  const refusal = publicFetchRefusal(input.url);

  if (refusal !== undefined) return refused(refusal);

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: "GET",
      headers: passedOn(input.headers),
      redirect: "manual",
      signal,
    });

    const body = BODYLESS.includes(response.status)
      ? ""
      : await boundedText(response, MAX_METADATA_BYTES);

    if (body === undefined) {
      return refused(`The response is longer than ${MAX_METADATA_BYTES / 1024} KiB`);
    }

    const headers: Record<string, string> = {};

    response.headers.forEach((value, name) => {
      headers[name] = value;
    });

    return { status: "fetched", code: response.status, headers, body };
  } catch {
    return refused(signal.aborted ? "The request timed out" : "The request failed");
  }
};
