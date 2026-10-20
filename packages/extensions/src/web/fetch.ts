// `web_fetch`: one HTTP(S) URL as text, Markdown, or HTML, with line paging. Ported from pi-web-tools'
// `src/web-fetch.ts` (see ../../NOTICE.md); every request goes through the SSRF guard (`guarded-fetch.ts`).
import { defineEffectTool } from "@cloudpid/effect-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convertContent, type WebFetchFormat } from "./content.ts";
import { WebToolError } from "./errors.ts";
import { guardedFetch } from "./guarded-fetch.ts";
import { boundStructuredText, fitWindowedOutput, selectLines } from "./output.ts";
import { discardBody, readBoundedBody, statusCause } from "./response.ts";

/** Largest response body accepted. */
export const WEB_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Default total request budget, in seconds, and the most a call may ask for. */
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30;
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const HONEST_USER_AGENT = "cloudpid-web-tools";

const WebFetchParameters = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute HTTP or HTTPS URL to fetch" }),
  format: Schema.optional(
    Schema.Literals(["text", "markdown", "html"]).annotate({
      description: "Returned format (default: markdown)",
    }),
  ),
  timeout: Schema.optional(
    Schema.Finite.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(WEB_FETCH_MAX_TIMEOUT_SECONDS),
    ).annotate({
      description: `Total timeout in seconds (default: ${WEB_FETCH_DEFAULT_TIMEOUT_SECONDS}, maximum: ${WEB_FETCH_MAX_TIMEOUT_SECONDS})`,
    }),
  ),
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "Line to start reading from (1-indexed), counted in the returned format after conversion",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "Maximum number of lines to return; the result says how many lines remain and the offset to continue from",
    }),
  ),
});

/**
 * What programs (code mode) receive instead of the model-facing text. `content` is the converted text of the
 * `offset`/`limit` window, up to 1 MiB, without the continuation note. Two cuts are reported separately:
 * `truncated` means the model-visible text was cut at 50 KiB / 2,000 lines, `structured_truncated` that `content`
 * itself was cut at 1 MiB. `total_lines` and `next_offset` let a program page; they are present only when `offset` or
 * `limit` was passed (`next_offset` also only while lines remain and `content` is whole).
 */
export const WebFetchOutput = Schema.Struct({
  url: Schema.String.annotate({ description: "Final URL after redirects, without credentials" }),
  content_type: Schema.String.annotate({ description: "Response Content-Type header" }),
  format: Schema.Literals(["text", "markdown", "html"]),
  content: Schema.String.annotate({
    description: "Fetched text in the requested format, limited to the offset/limit window",
  }),
  truncated: Schema.Boolean.annotate({
    description: "The model-visible output was cut at 50 KiB or 2,000 lines",
  }),
  structured_truncated: Schema.Boolean.annotate({ description: "content itself was cut at 1 MiB" }),
  total_lines: Schema.optional(
    Schema.Int.annotate({
      description: "Lines in the whole converted text; present when offset or limit was passed",
    }),
  ),
  next_offset: Schema.optional(
    Schema.Int.annotate({
      description:
        "Offset of the first line after the offset/limit window; present when lines remain after it",
    }),
  ),
});

const DESCRIPTION =
  "Fetch one HTTP or HTTPS URL as text, Markdown, or HTML. HTML pages are converted to their main content, with the page title, when text or Markdown is requested; HTML format returns the page unchanged. JSON responses are re-indented in text and Markdown formats so long documents can be paged. Model-visible output is truncated to 50 KiB or 2,000 lines, and the result then says which lines remain and the offset to continue from. Use offset and limit (lines, like the read tool) to page through a long result. Private, loopback, link-local, and cloud-metadata addresses are refused, also after redirects.";

/** Remove URL user information before a value reaches an error or a result. */
export const redactUserinfo = (input: string): string => {
  try {
    const url = new URL(input);

    url.username = "";
    url.password = "";

    return url.toString();
  } catch {
    return input.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1");
  }
};

const acceptHeader = (format: WebFetchFormat): string => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
};

const normalizedMime = (contentType: string): string =>
  contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const truncatedMime = (mime: string): string =>
  mime.length > 100 ? `${mime.slice(0, 100)}…` : mime;

const isTextualMime = (mime: string): boolean =>
  mime.length === 0 ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript";

type Fetched = {
  readonly content: string;
  readonly contentType: string;
  readonly finalUrl: string;
};

/** GET `url` through the guard and convert what comes back. */
const fetchText = Effect.fn("web_fetch.fetchText")(function* (url: string, format: WebFetchFormat) {
  const send = (userAgent: string) =>
    guardedFetch({
      url,
      headers: {
        accept: acceptHeader(format),
        "accept-language": "en-US,en;q=0.9",
        "user-agent": userAgent,
      },
    });

  let reply = yield* send(BROWSER_USER_AGENT);

  // A Cloudflare challenge is aimed at browsers; the honest agent is allowed through by sites that expect tools.
  if (reply.response.status === 403 && reply.response.headers.get("cf-mitigated") === "challenge") {
    yield* discardBody(reply.response);
    reply = yield* send(HONEST_USER_AGENT);
  }

  const { response } = reply;

  if (!response.ok) {
    yield* discardBody(response);

    return yield* WebToolError.make({ message: statusCause(response.status) });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = normalizedMime(contentType);

  if (!isTextualMime(mime)) {
    yield* discardBody(response);

    return yield* WebToolError.make({
      message: `unsupported content type ${truncatedMime(mime)} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
    });
  }

  const body = yield* readBoundedBody(response, WEB_FETCH_MAX_RESPONSE_BYTES);

  const content = yield* Effect.try({
    try: () => convertContent(new TextDecoder().decode(body), mime, format),
    catch: () =>
      WebToolError.make({
        message:
          "the page could not be converted (it is nested too deeply or is too large to convert); use format: html to read it as it came",
      }),
  });

  return {
    content,
    contentType,
    finalUrl: redactUserinfo(reply.url.toString()),
  } satisfies Fetched;
});

/** `web_fetch`. */
export const WebFetch = defineEffectTool({
  name: "web_fetch",
  description: DESCRIPTION,
  parameters: WebFetchParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(WebFetchOutput).schema,
  execute: Effect.fnUntraced(function* (args) {
    const safeUrl = redactUserinfo(args.url);
    const format = args.format ?? "markdown";
    const seconds = args.timeout ?? WEB_FETCH_DEFAULT_TIMEOUT_SECONDS;

    const unable = (cause: string) =>
      WebToolError.make({ message: `Unable to fetch ${safeUrl}: ${cause}` });

    const fetched = yield* fetchText(args.url, format).pipe(
      Effect.timeoutOrElse({
        duration: Math.ceil(seconds * 1000),
        orElse: () =>
          Effect.fail(
            WebToolError.make({
              message: `timed out after ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
            }),
          ),
      }),
      Effect.mapError((error) => unable(error.message)),
    );

    const selected = selectLines(fetched.content, args.offset, args.limit);

    if (selected === undefined) {
      return yield* unable(
        `Offset ${args.offset} is beyond end of content (${fetched.content.split("\n").length} lines total)`,
      );
    }

    const fitted = fitWindowedOutput(selected.text, selected.window);
    const structured = boundStructuredText(selected.text);
    const requested = args.offset !== undefined || args.limit !== undefined;
    const { totalLines } = selected.window;

    // A cut `content` ends inside the window, so the line after the window would skip lines.
    const paging = !requested
      ? {}
      : structured.truncated || selected.lastLine >= totalLines
        ? { total_lines: totalLines }
        : { total_lines: totalLines, next_offset: selected.lastLine + 1 };

    return {
      output: [{ type: "text", text: fitted.content }],
      structuredOutput: {
        url: fetched.finalUrl,
        content_type: fetched.contentType,
        format,
        content: structured.content,
        truncated: fitted.truncated,
        structured_truncated: structured.truncated,
        ...paging,
      },
      details: { url: fetched.finalUrl, contentType: fetched.contentType, format },
    };
  }),
});
