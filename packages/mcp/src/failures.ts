/**
 * What a failed SDK call means, as an `McpError` (`docs/architecture/mcp.md` → Packages and objects; the probe's
 * outcome table: The MCP core #394 D2; `docs/architecture/mcp-connections.md` → Failures and cuts).
 *
 * | What failed                                 | `McpError`                                          |
 * | ------------------------------------------- | --------------------------------------------------- |
 * | 401                                         | `SignInRequired` (`rejected` when a token was sent) |
 * | 403 `insufficient_scope`                    | `StepUpRequired`                                    |
 * | any other 403, a redirect not followed      | `ServerError` with the status (the server `failed`) |
 * | 408, 429, 5xx, a network error              | `Unreachable` (the server `unavailable`)            |
 * | a 2xx that is not JSON-RPC                  | `ProtocolViolation` ("not an MCP server")           |
 * | no common protocol version                  | `Unsupported` ("supports only …")                   |
 * | no answer in time (202, an empty stream)    | `TimedOut`                                          |
 * | `-32002`, `-32602`                          | `NotFound`                                          |
 * | any other JSON-RPC error                    | `ServerError` with the code                         |
 */
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import {
  InsufficientScopeError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/client";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { VERDICT_KEY, type Verdicts } from "./tap.ts";
import {
  Cut,
  McpError,
  NotFound,
  ProtocolViolation,
  ServerError,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  Unreachable,
  Unsupported,
} from "./types.ts";

/** What the core knows about the request that failed. */
export interface FailedRequest {
  /** Whether a `tools/call` was sent, so a cut may have run it. */
  readonly mayHaveRun: boolean;
  /** Whether the last attempt carried an access token. */
  readonly tokenSent: boolean;
  readonly verdicts: Verdicts;
}

/** A failure as the core acts on it: the `McpError`, and the HTTP status or JSON-RPC code behind it. */
export interface Failure {
  readonly error: McpError;
  readonly status?: number;
  readonly code?: number;
}

const isMcpError = Schema.is(McpError);

const UNSUPPORTED_VERSION = "Server's protocol version is not supported:";

const VerdictData = Schema.Struct({ [VERDICT_KEY]: Schema.Finite });

const decodeVerdict = Schema.decodeUnknownOption(VerdictData);

/** A JSON-RPC error in an HTTP error's body, which the SDK reads only on a Modern exchange. */
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        code: Schema.Int,
        message: Schema.String,
        data: Schema.optionalKey(
          Schema.Struct({ supported: Schema.optionalKey(Schema.String.pipe(Schema.Array)) }),
        ),
      }),
    }),
  ),
);

const unsupportedVersions = (supported: ReadonlyArray<string>) =>
  Unsupported.make({ message: `The server supports only ${Arr.join(supported, ", ")}` });

/** `cause` and the causes it wraps, outermost first. */
const causes = (cause: unknown) => {
  const chain = [cause];

  for (let at = cause; at instanceof Error && at.cause !== undefined && chain.length < 8;) {
    at = at.cause;
    chain.push(at);
  }

  return chain;
};

const fromStatus = (status: number, message: string, request: FailedRequest): McpError => {
  if (status === 401) {
    return SignInRequired.make({
      message: request.tokenSent
        ? "The server refused the access token"
        : "The server requires signing in",
      rejected: request.tokenSent,
    });
  }

  if (status === 403) {
    return ServerError.make({ message: "The server denied access (HTTP 403)", status });
  }

  if (status >= 300 && status <= 399) {
    return ServerError.make({
      message: `The server redirects; not followed (HTTP ${status})`,
      status,
    });
  }

  if (status === 408 || status === 429 || status >= 500) {
    return Unreachable.make({ message: `The server is unavailable (HTTP ${status})`, status });
  }

  return ServerError.make({ message: `The server answered HTTP ${status}: ${message}`, status });
};

const fromCode = (code: number, message: string): McpError => {
  if (code === -32002 || code === -32602) {
    return NotFound.make({ message, code });
  }

  if (code === -32601) {
    return Unsupported.make({ message: `The server does not offer this: ${message}` });
  }

  return ServerError.make({ message, code });
};

const fromSdk = (error: SdkError, request: FailedRequest): McpError | undefined => {
  switch (error.code) {
    case SdkErrorCode.RequestTimeout:
      return TimedOut.make({ message: "The server did not answer in time" });
    case SdkErrorCode.ConnectionClosed:
      return Cut.make({
        message: "The connection closed before the answer arrived",
        mayHaveRun: request.mayHaveRun,
      });
    case SdkErrorCode.InvalidResult:
    case SdkErrorCode.ClientHttpUnexpectedContent:
      return ProtocolViolation.make({ message: `Not an MCP server: ${error.message}` });
    case SdkErrorCode.UnsupportedResultType:
    case SdkErrorCode.CapabilityNotSupported:
    case SdkErrorCode.MethodNotSupportedByProtocolVersion:
      return Unsupported.make({ message: error.message });
    default:
      return undefined;
  }
};

/** One link of a failure's cause chain, read as a failure if it says what failed. */
const fromCause = (cause: unknown, request: FailedRequest): Failure | undefined => {
  if (isMcpError(cause)) {
    return { error: cause };
  }

  if (cause instanceof InsufficientScopeError) {
    const message = "The server needs a token with more scope";

    return {
      error:
        cause.requiredScope === undefined
          ? StepUpRequired.make({ message })
          : StepUpRequired.make({ message, scope: cause.requiredScope }),
      status: 403,
    };
  }

  if (cause instanceof UnauthorizedError) {
    return { error: fromStatus(401, cause.message, request), status: 401 };
  }

  if (cause instanceof UnsupportedProtocolVersionError) {
    return { error: unsupportedVersions(cause.supported), code: cause.code };
  }

  if (cause instanceof ProtocolError) {
    const verdict = Option.flatMapNullishOr(decodeVerdict(cause.data), (data) =>
      request.verdicts.take(data[VERDICT_KEY]),
    );

    return Option.match(verdict, {
      onSome: (error) => ({ error }),
      onNone: () => ({ error: fromCode(cause.code, cause.message), code: cause.code }),
    });
  }

  if (cause instanceof SdkHttpError) {
    const body = decodeErrorBody(cause.data["text"]);

    const supported = Option.flatMapNullishOr(body, ({ error }) =>
      error.code === -32022 ? error.data?.supported : undefined,
    );

    return Option.match(supported, {
      onSome: (versions) => ({
        error: unsupportedVersions(versions),
        status: cause.status,
        code: -32022,
      }),
      onNone: () => ({
        error: fromStatus(cause.status, cause.message, request),
        status: cause.status,
      }),
    });
  }

  if (cause instanceof SdkError) {
    const error = fromSdk(cause, request);

    return error === undefined ? undefined : { error };
  }

  // The SDK's `initialize` throws a plain `Error` for a version outside `supportedProtocolVersions` (golden-tested).
  if (cause instanceof Error && cause.message.startsWith(UNSUPPORTED_VERSION)) {
    return {
      error: Unsupported.make({
        message: `The server supports only ${cause.message.slice(UNSUPPORTED_VERSION.length).trim()}`,
      }),
    };
  }

  if (cause instanceof SyntaxError) {
    return { error: ProtocolViolation.make({ message: `Not an MCP server: ${cause.message}` }) };
  }

  return undefined;
};

/** What `cause`, thrown by an SDK call, means. */
export const classify = (cause: unknown, request: FailedRequest): Failure => {
  for (const link of causes(cause)) {
    const failure = fromCause(link, request);

    if (failure !== undefined) {
      return failure;
    }
  }

  const message = cause instanceof Error ? cause.message : String(cause);

  return cause instanceof SdkError && cause.code === SdkErrorCode.EraNegotiationFailed
    ? { error: Unreachable.make({ message }) }
    : { error: ServerError.make({ message }) };
};
