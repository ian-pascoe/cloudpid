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
import type * as Types from "effect/Types";
import { VERDICT_KEY, type Verdicts } from "./tap.ts";
import {
  Cut,
  MCP_TASKS_EXTENSION,
  type McpAuthChallenge,
  MCP_UNASKED_TASK_MESSAGE,
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

/**
 * The parameters of a `WWW-Authenticate` challenge as a report carries them, leaving out what the header did not have.
 */
export const authChallenge = (params: {
  readonly resourceMetadataUrl?: URL | undefined;
  readonly scope?: string | undefined;
  readonly error?: string | undefined;
  readonly errorDescription?: string | undefined;
}): McpAuthChallenge | undefined => {
  const challenge: Types.Mutable<McpAuthChallenge> = {};
  let found = false;

  if (params.resourceMetadataUrl !== undefined) {
    challenge.resourceMetadataUrl = params.resourceMetadataUrl.href;
    found = true;
  }

  if (params.scope !== undefined) {
    challenge.scope = params.scope;
    found = true;
  }

  if (params.error !== undefined) {
    challenge.error = params.error;
    found = true;
  }

  if (params.errorDescription !== undefined) {
    challenge.errorDescription = params.errorDescription;
    found = true;
  }

  return found ? challenge : undefined;
};

/** A 403's failure for more scope, with the scope and the challenge of its `WWW-Authenticate` when it had them. */
const stepUpRequired = (
  message: string,
  scope: string | undefined,
  challenge: McpAuthChallenge | undefined,
): StepUpRequired => {
  const fields: Types.Mutable<ConstructorParameters<typeof StepUpRequired>[0]> = { message };

  if (scope !== undefined) fields.scope = scope;

  if (challenge !== undefined) fields.challenge = challenge;

  return StepUpRequired.make(fields);
};

/** A 401's failure, with the challenge of its `WWW-Authenticate` when it had one. */
export const signInRequired = (
  message: string,
  rejected: boolean,
  challenge: McpAuthChallenge | undefined,
): SignInRequired =>
  challenge === undefined
    ? SignInRequired.make({ message, rejected })
    : SignInRequired.make({ message, rejected, challenge });

/** What the core knows about the request that failed. */
export interface FailedRequest {
  /** Whether a `tools/call` was sent, so a cut may have run it. */
  readonly mayHaveRun: boolean;
  /** Whether the last attempt carried an access token. */
  readonly tokenSent: boolean;
  /** The parameters of the last 401's `WWW-Authenticate`, when it had any (`authChallenge`). */
  readonly challenge?: McpAuthChallenge | undefined;
  readonly verdicts: Verdicts;
  /**
   * The server's configured name, for the one message that names it: a `-32021` that asks for the tasks extension, which
   * the request did not declare.
   */
  readonly serverName?: string | undefined;
  /** Whether the request declared the tasks extension (`ctx.allowTask` on a Modern server that advertises it). */
  readonly tasksDeclared?: boolean | undefined;
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
    const message = request.tokenSent
      ? "The server refused the access token"
      : "The server requires signing in";

    return signInRequired(message, request.tokenSent, request.challenge);
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

/** `-32021` (`MissingRequiredClientCapability`): the capabilities the server says the request needed. */
const MISSING_CAPABILITY = -32021;

const RequiredCapabilities = Schema.Struct({
  requiredCapabilities: Schema.Struct({
    extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
});

const decodeRequiredCapabilities = Schema.decodeUnknownOption(RequiredCapabilities);

type RequiredCapabilities = typeof RequiredCapabilities.Type;

/**
 * What a server that needs the request run as an MCP task says to one that did not declare the extension: `-32021` naming
 * `io.modelcontextprotocol/tasks`. cloudpid declares it only where it can wait for a task (`ctx.allowTask`, under the
 * caps), so this is the message for the call that could not be offered it (`docs/architecture/mcp-server-requests.md` →
 * MCP tasks, Declaration).
 */
const taskNeeded = (
  message: string,
  required: Option.Option<RequiredCapabilities>,
  request: FailedRequest,
): McpError | undefined =>
  request.tasksDeclared !== true &&
  Option.exists(
    required,
    ({ requiredCapabilities }) =>
      requiredCapabilities.extensions?.[MCP_TASKS_EXTENSION] !== undefined,
  )
    ? ServerError.make({
        message: `${request.serverName ?? "The server"} needs to run this as an MCP task, which cloudpid couldn't offer here: ${message}`,
        code: MISSING_CAPABILITY,
      })
    : undefined;

const fromCode = (
  code: number,
  message: string,
  required?: Option.Option<RequiredCapabilities>,
  request?: FailedRequest,
): McpError => {
  if (code === MISSING_CAPABILITY && required !== undefined && request !== undefined) {
    const needed = taskNeeded(message, required, request);

    if (needed !== undefined) return needed;
  }

  if (code === -32002 || code === -32602) {
    return NotFound.make({ message, code });
  }

  if (code === -32601) {
    return Unsupported.make({ message: `The server does not offer this: ${message}` });
  }

  return ServerError.make({ message, code });
};

const decodeResultType = Schema.decodeUnknownOption(Schema.Struct({ resultType: Schema.String }));

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
      // A task the request did not declare the extension for: the server broke the protocol (as the host reads it).
      return Option.exists(decodeResultType(error.data), ({ resultType }) => resultType === "task")
        ? ProtocolViolation.make({ message: MCP_UNASKED_TASK_MESSAGE })
        : Unsupported.make({ message: error.message });
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

    const challenge = authChallenge({
      resourceMetadataUrl: cause.resourceMetadataUrl,
      scope: cause.requiredScope,
      error: "insufficient_scope",
      errorDescription: cause.errorDescription,
    });

    return { error: stepUpRequired(message, cause.requiredScope, challenge), status: 403 };
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
      onNone: () => ({
        error: fromCode(cause.code, cause.message, decodeRequiredCapabilities(cause.data), request),
        code: cause.code,
      }),
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
