// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off missingPipeableSignature:off newPromise:off globalTimers:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain Promises, as pi's extension API and child processes give them; plain functions over values, called directly; wraps a callback API (a child process, a timer); the wait between retries.
/**
 * The MCP endpoint as `/cloudpid` calls it (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The connection,
 * Compatibility): one connection with the owner's OAuth sign-in (`oauth.ts`, the SDK's `authProvider`), the tools it needs
 * checked in `tools/list`, and `environments_list` and the four `session_import_*` tools as typed calls. A domain failure
 * is an {@link ApiFailure}; a sign-in that is missing or no longer accepted is {@link SignInRequired}, and an older
 * endpoint a {@link Refusal}.
 */
import {
  Client,
  createFetchWithInit,
  type FetchLike,
  type JsonSchemaValidator,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { SessionImportBeginInput } from "@cloudpid/protocol/mcp-tools";
import type { AuthStore } from "./auth-store.ts";
import { type Config, clientName, endpointKey } from "./config.ts";
import { REQUIRED_TOOLS } from "./constants.ts";
import { ApiFailure, NOT_SIGNED_IN, Refusal, SIGN_IN_REJECTED, SignInRequired } from "./errors.ts";
import {
  integerField,
  isJson,
  type JsonObject,
  objectField,
  objectsField,
  stringField,
  stringsField,
  toObject,
} from "./json.ts";
import {
  bearerFetch,
  CONNECTION_REDIRECT,
  CloudpidOAuthProvider,
  probeSignIn,
  singleFlightRefresh,
  captureSdkWarnings,
  isRedirect,
} from "./oauth.ts";

export const ENDPOINT_OLDER = "the endpoint is older than this extension";

/** An Environment as `environments_list` gives it. */
export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<{ readonly name: string; readonly url: string }>;
}

export type BeginInput = SessionImportBeginInput;

export interface BeginResult {
  readonly importId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly received: number;
  readonly maxSliceBytes: number;
  readonly carryRef: string;
}

export interface FinishResult {
  readonly sessionId: string;
  /** `importing` while the translation still runs. */
  readonly status: string;
  readonly url: string;
  readonly summary: ImportSummary | undefined;
  readonly warnings: ReadonlyArray<string>;
}

/** What the translation cut, dropped (by kind) and closed. */
export interface ImportSummary {
  readonly cut: number;
  readonly dropped: ReadonlyArray<readonly [kind: string, count: number]>;
  readonly closed: number;
}

/** Another Workspace holds the branch (`branch_taken`'s `details`). */
export interface BranchTaken {
  readonly sessions: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly status: string;
  }>;
}

export interface Endpoint {
  readonly environments: () => Promise<ReadonlyArray<Environment>>;
  readonly begin: (input: BeginInput) => Promise<BeginResult>;
  /** The bytes the endpoint holds after the slice. An `offset_mismatch` is an {@link ApiFailure} with `receivedOf`. */
  readonly append: (importId: string, offset: number, data: string) => Promise<number>;
  /**
   * `changesCarried` (whether a carry commit was pushed) goes only to an endpoint whose `session_import_finish` declares
   * it: an older one may refuse a property it does not know.
   */
  readonly finish: (
    importId: string,
    sha256: string,
    changesCarried: boolean,
  ) => Promise<FinishResult>;
  readonly cancel: (importId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface EndpointOptions {
  /** Where the sign-in is kept. */
  readonly store: AuthStore;
  /** The `fetch` the transport uses; tests give the stub endpoint's. */
  readonly fetch?: FetchLike;
  /** The `X-Cloudpid-Client` value. */
  readonly client?: string;
  /** Waits `ms` before a retry. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Where the SDK's own warnings about OAuth (a refresh that fell back, credentials dropped) go; they never reach the console. */
  readonly onWarning?: ((message: string) => void) | undefined;
  /** The time, for when the access token expires. */
  readonly now?: (() => number) | undefined;
}

/** The HTTP status behind a failed call, from the error or the errors it wraps. */
const statusOf = (error: Error): number | undefined => {
  for (let at: Error | undefined = error, depth = 0; at !== undefined && depth < 8; depth += 1) {
    if (at instanceof SdkHttpError) return at.status;

    if (at instanceof UnauthorizedError) return 401;

    at = at.cause instanceof Error ? at.cause : undefined;
  }

  return undefined;
};

/** A caller Access did not let in: a 401 or 403, or the redirect to its login page (never followed). */
const isRejected = (status: number | undefined): boolean =>
  status === 401 || status === 403 || (status !== undefined && isRedirect(status));

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The most a retry waits, and how many times a retryable failure is retried. */
const MAX_WAIT_MS = 60_000;

const MAX_RETRIES = 3;

/** `retry_after_s` of a `rate_limited` failure, else a short wait that grows with the attempt. */
const waitFor = (failure: ApiFailure, attempt: number): number => {
  const given =
    failure.details === undefined ? undefined : integerField(failure.details, "retry_after_s");

  return Math.min(MAX_WAIT_MS, given === undefined ? 1000 * attempt : given * 1000);
};

const failureOf = (name: string, text: string, structured: JsonObject | undefined): ApiFailure => {
  const error = structured === undefined ? undefined : objectField(structured, "error");

  if (error === undefined) {
    return new ApiFailure("unavailable", text === "" ? `${name} failed.` : text, true);
  }

  const details = objectField(error, "details");

  return new ApiFailure(
    stringField(error, "code") ?? "unavailable",
    stringField(error, "message") ?? text,
    error["retryable"] === true,
    details,
  );
};

/** The `received` of an `offset_mismatch` (and of nothing else). */
export const receivedOf = (failure: ApiFailure): number | undefined =>
  failure.code === "offset_mismatch" && failure.details !== undefined
    ? integerField(failure.details, "received")
    : undefined;

/** `branch_taken`'s Sessions: what is in the Workspace that holds the branch. */
export const branchTakenOf = (failure: ApiFailure): BranchTaken | undefined => {
  if (failure.code !== "branch_taken" || failure.details === undefined) return undefined;

  return {
    sessions: objectsField(failure.details, "sessions").map((session) => ({
      id: stringField(session, "id") ?? "",
      url: stringField(session, "url") ?? "",
      title: stringField(session, "title") ?? "",
      status: stringField(session, "status") ?? "",
    })),
  };
};

const malformed = (tool: string): ApiFailure =>
  new ApiFailure("unavailable", `${tool} answered something this extension cannot read.`, false);

const summaryOf = (fields: JsonObject | undefined): ImportSummary | undefined => {
  if (fields === undefined) return undefined;

  const dropped = objectField(fields, "dropped") ?? {};

  return {
    cut: integerField(fields, "cut") ?? 0,
    closed: integerField(fields, "closed") ?? 0,
    dropped: Object.keys(dropped).flatMap((kind) => {
      const count = integerField(dropped, kind);

      return count === undefined ? [] : [[kind, count] as const];
    }),
  };
};

/** The SDK builds no validator of its own (Ajv would go into the bundle) and runs none: every field is read where it is used. */
const noValidation = {
  getValidator:
    <T>(): JsonSchemaValidator<T> =>
    (input) => ({
      valid: true,
      // SAFETY: no validation is the point; the endpoint's results are read field by field.
      data: input as T,
      errorMessage: undefined,
    }),
};

/** Connects, checks the endpoint has the tools this extension calls, and returns the typed calls. */
export const connectEndpoint = async (
  config: Config,
  options: EndpointOptions,
): Promise<Endpoint> => {
  const sleep = options.sleep ?? sleepFor;
  const name = options.client ?? clientName();
  const raw: FetchLike = options.fetch ?? fetch;

  const requestInit: RequestInit = {
    headers: { "X-Cloudpid-Client": name },
    // The token goes to the URL the owner configured and nowhere else.
    redirect: "manual",
  };

  const fetchFn = createFetchWithInit(raw, requestInit);

  const provider = new CloudpidOAuthProvider({
    store: options.store,
    endpoint: endpointKey(config),
    redirectUrl: CONNECTION_REDIRECT,
    // A new sign-in is the owner's to agree to (`SignInRequired`), never started here.
    onRedirect: () => undefined,
    refresh: singleFlightRefresh(config.url, fetchFn),
    signInRequired: () => new SignInRequired(SIGN_IN_REJECTED),
    now: options.now,
  });

  await provider.load();

  // Nothing stored: ask the endpoint whether it wants a sign-in before the SDK registers a client to start one.
  if (!provider.signedIn) {
    const probe = await probeSignIn(config.url, raw, { "X-Cloudpid-Client": name });

    if (probe.needed) throw new SignInRequired(NOT_SIGNED_IN);
  }

  const transportOptions: StreamableHTTPClientTransportOptions = {
    requestInit,
    authProvider: provider,
    fetch: bearerFetch(raw, provider),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  };

  const transport = new StreamableHTTPClientTransport(config.url, transportOptions);

  const client = new Client(
    { name: "pi-cloudpid", version: name.slice("pi-cloudpid/".length) },
    {
      // The endpoint's results are read field by field below; the SDK's own validation (Ajv) stays out of the bundle.
      jsonSchemaValidator: noValidation,
    },
  );

  /** A transport failure as the owner reads it: a sign-in that is no longer accepted, else the SDK's own sentence. */
  const transportFailure = (error: Error): Error =>
    isRejected(statusOf(error)) ? new SignInRequired(SIGN_IN_REJECTED) : error;

  let finishTakesChangesCarried = false;

  // The SDK's warnings stay off pi's screen for as long as the connection lives.
  const releaseWarnings = captureSdkWarnings(options.onWarning ?? (() => undefined));

  try {
    await client.connect(transport);

    const names = new Set<string>();

    for (let cursor: string | undefined; ;) {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });

      for (const tool of page.tools) {
        names.add(tool.name);

        if (tool.name === "session_import_finish") {
          finishTakesChangesCarried =
            tool.inputSchema.properties?.["changes_carried"] !== undefined;
        }
      }

      cursor = page.nextCursor;

      if (cursor === undefined) break;
    }

    if (REQUIRED_TOOLS.some((tool) => !names.has(tool))) {
      throw new Refusal(
        `${ENDPOINT_OLDER}: it does not serve ${REQUIRED_TOOLS.filter((tool) => !names.has(tool)).join(", ")}. Deploy cloudpid, or run \`pi update\` only after its deploy.`,
      );
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    releaseWarnings();

    if (error instanceof Refusal) throw error;

    throw error instanceof Error ? transportFailure(error) : error;
  }

  const call = async (tool: string, args: JsonObject): Promise<JsonObject> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await client.callTool({ name: tool, arguments: { ...args } });

        const structured = toObject(
          isJson(result.structuredContent) ? result.structuredContent : undefined,
        );

        if (result.isError === true) {
          const text = result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");

          throw failureOf(tool, text, structured);
        }

        if (structured === undefined) throw malformed(tool);

        return structured;
      } catch (error) {
        if (error instanceof ApiFailure) {
          if (error.retryable && attempt <= MAX_RETRIES && isRetryable(tool)) {
            await sleep(waitFor(error, attempt));

            continue;
          }

          throw error;
        }

        throw error instanceof Error ? transportFailure(error) : error;
      }
    }
  };

  return {
    environments: async () => {
      const result = await call("environments_list", {});

      return objectsField(result, "environments").flatMap((environment) => {
        const id = stringField(environment, "id");
        const environmentName = stringField(environment, "name");

        if (id === undefined || environmentName === undefined) return [];

        return [
          {
            id,
            name: environmentName,
            repos: objectsField(environment, "repos").flatMap((repo) => {
              const url = stringField(repo, "url");

              return url === undefined ? [] : [{ name: stringField(repo, "name") ?? "", url }];
            }),
          },
        ];
      });
    },

    begin: async (input) => {
      const result = await call("session_import_begin", { ...input });
      const importId = stringField(result, "import_id");
      const url = stringField(result, "url");
      const carryRef = stringField(result, "carry_ref");

      if (importId === undefined || url === undefined || carryRef === undefined) {
        throw malformed("session_import_begin");
      }

      return {
        importId,
        sessionId: stringField(result, "session_id") ?? importId,
        url,
        received: integerField(result, "received") ?? 0,
        maxSliceBytes: integerField(result, "max_slice_bytes") ?? 0,
        carryRef,
      };
    },

    append: async (importId, offset, data) => {
      const result = await call("session_import_append", { import_id: importId, offset, data });
      const received = integerField(result, "received");

      if (received === undefined) throw malformed("session_import_append");

      return received;
    },

    finish: async (importId, sha256, changesCarried) => {
      const args = { import_id: importId, sha256 };

      const result = await call(
        "session_import_finish",
        finishTakesChangesCarried ? { ...args, changes_carried: changesCarried } : args,
      );

      const url = stringField(result, "url");
      const status = stringField(result, "status");

      if (url === undefined || status === undefined) throw malformed("session_import_finish");

      return {
        sessionId: stringField(result, "session_id") ?? importId,
        status,
        url,
        summary: summaryOf(objectField(result, "summary")),
        warnings: stringsField(result, "warnings"),
      };
    },

    cancel: async (importId) => {
      await call("session_import_cancel", { import_id: importId });
    },

    close: () => client.close().finally(releaseWarnings),
  };
};

/** `session_import_begin` is not retried here: its failures are the owner's to decide (`branch_taken`, a cap). */
const isRetryable = (tool: string): boolean => tool !== "session_import_begin";
