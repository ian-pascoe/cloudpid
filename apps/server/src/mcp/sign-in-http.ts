// The main Worker's three MCP sign-in routes (`docs/architecture/mcp-sign-in.md` → The client document and the callback outside
// Access, Starting and completing a sign-in; ADR-0035): the public client document and callback, and the start behind Access.
// What reaches the Registry is bounded and shaped here; what the owner's browser gets back is `sign-in-pages.ts`.
//
// The two public routes (`serveClientDocument`, `serveCallback`) never read identity: the callback's safety is the
// single-use `state`, the verifier only the Registry holds, the exact path and the `iss` check. `serveStart` is called only
// behind the Access guard; it also needs `Sec-Fetch-Site: same-origin` (a link, not an RPC, so the owner's click is what
// starts it), and its `POST` an `Origin` equal to the origin the start was made on. Nothing here logs a URL, a query or a
// body: a callback's address holds a single-use code.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off preferSchemaOverJson:off
import { boundedText } from "@cloudpid/mcp/oauth";
import {
  MCP_SIGN_IN_GLOBAL,
  type McpSignInStage,
  readMcpSignInCompleteAnswer,
  readMcpSignInConfirmAnswer,
  readMcpSignInStartAnswer,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  APP_ORIGIN_VAR,
  LOCAL_MODE_VAR,
  MCP_CLIENT_DOCUMENT_VAR,
  STAGE_LABEL_VAR,
} from "../deployment.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import {
  clientDocument,
  clientNameFor,
  safeReturnPath,
  WELL_FORMED_STATE,
} from "./sign-in-client.ts";
import { signInOrigin } from "./sign-in-origin.ts";
import {
  callbackPage,
  cancelledPage,
  interstitialPage,
  invalidCallbackPage,
  type Page,
  startProblemPage,
} from "./sign-in-pages.ts";

/** The Registry methods the routes call, on its object. */
export type SignInRegistry = Pick<
  RegistryMethods,
  "startMcpSignIn" | "confirmMcpSignIn" | "completeMcpSignIn"
>;

/**
 * What the Worker's raw environment holds of the sign-in vars, as the deploy sets them. Read raw, as the guard's are, not
 * through `Config`: alchemy's runtime may make a boolean of `"true"`.
 */
export type SignInEnv = {
  readonly [APP_ORIGIN_VAR]?: string;
  readonly [LOCAL_MODE_VAR]?: string | boolean;
  readonly [MCP_CLIENT_DOCUMENT_VAR]?: string | boolean;
  readonly [STAGE_LABEL_VAR]?: string;
};

const isOn = (value: string | boolean | undefined): boolean => value === true || value === "true";

/** The stage a request is served on: where a sign-in starts, its label, and whether the document is in the ladder. */
const stageOf = (env: SignInEnv, host: string | undefined): McpSignInStage | undefined => {
  const localMode = isOn(env[LOCAL_MODE_VAR]);
  const origin = signInOrigin({ deployedOrigin: env[APP_ORIGIN_VAR], localMode, host });

  if (origin === undefined) return undefined;

  const stage: Types.Mutable<McpSignInStage> = {
    origin,
    local: localMode,
    documentEnabled: !localMode && isOn(env[MCP_CLIENT_DOCUMENT_VAR]),
  };

  const label = env[STAGE_LABEL_VAR];

  if (label !== undefined && label !== "") stage.label = label;

  return stage;
};

const SECURITY_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

const respond = (page: Page): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.fromWeb(
    new Response(page.html, { status: page.status, headers: new Headers(page.headers) }),
  );

const notFound = HttpServerResponse.text("Not Found", {
  status: 404,
  headers: { "cache-control": "no-store" },
});

const methodNotAllowed = (allow: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("Method Not Allowed", {
    status: 405,
    headers: { allow, "cache-control": "no-store" },
  });

/** The query of a request's URL, whether it is absolute or a bare path. */
const queryOf = (url: string): URLSearchParams =>
  new URL(url, "https://cloudpid.invalid").searchParams;

// The client document (→ The document) --------------------------------------------------------------------------------

/** What the Worker's `request.cf` holds of the fetch: the ASN, for "never fetched" to be told apart from "fetched and got a 200". */
const decodeCf = Schema.decodeUnknownOption(
  Schema.Struct({ cf: Schema.optional(Schema.Struct({ asn: Schema.optional(Schema.Finite) })) }),
);

/**
 * `GET /oauth/mcp/client.json`: cloudpid's client document, public on every deployed stage and served with `Cache-Control:
 * public, max-age=3600` (authorization servers cache it, so keep it stable). A stage without an app origin (`alchemy dev`)
 * answers 404: an authorization server cannot fetch `localhost`. The route records each fetch as span attributes (user
 * agent, `request.cf.asn`, status), no cookies and no query.
 */
export const serveClientDocument = Effect.fn("mcp.oauth.client_document")(function* (
  env: SignInEnv,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const origin = isOn(env[LOCAL_MODE_VAR]) ? undefined : env[APP_ORIGIN_VAR];
  const status = origin === undefined || origin === "" ? 404 : 200;

  yield* Effect.annotateCurrentSpan({
    "http.user_agent": request.headers["user-agent"] ?? "",
    "cloudflare.asn": Option.getOrUndefined(decodeCf(request.source))?.cf?.asn,
    "http.status_code": status,
  });

  if (origin === undefined || origin === "") return notFound;

  const label = env[STAGE_LABEL_VAR];

  const document = clientDocument({
    origin,
    clientName: clientNameFor({ label: label === "" ? undefined : label, local: false }),
  });

  return HttpServerResponse.fromWeb(
    new Response(request.method === "HEAD" ? null : JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    }),
  );
});

// The callback (→ The callback) -----------------------------------------------------------------------------------------

/** The longest value of each callback parameter that is passed on: anything longer is no answer cloudpid asked for. */
const MAX_CODE_LENGTH = 4096;
const MAX_ISS_LENGTH = 2048;
const MAX_ERROR_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1024;

/** What the callback passes on, or undefined when its `state` is not one cloudpid makes (the Registry is then never called). */
const callbackInput = (path: string, query: URLSearchParams) => {
  const states = query.getAll("state");
  const state = states[0];

  if (states.length !== 1 || state === undefined || !WELL_FORMED_STATE.test(state))
    return undefined;

  const code = query.get("code") ?? undefined;
  const iss = query.get("iss") ?? undefined;
  const error = query.get("error") ?? undefined;
  const description = query.get("error_description") ?? undefined;

  if (
    (code?.length ?? 0) > MAX_CODE_LENGTH ||
    (iss?.length ?? 0) > MAX_ISS_LENGTH ||
    (error?.length ?? 0) > MAX_ERROR_LENGTH
  ) {
    return undefined;
  }

  return {
    state,
    path,
    code,
    iss,
    error,
    errorDescription: description?.slice(0, MAX_DESCRIPTION_LENGTH),
  };
};

/**
 * `GET /oauth/mcp/callback[/<hash>]`: the authorization server's answer, public and never reading identity. A `state` that
 * is not one cloudpid makes gets a static page and the Registry is never called; otherwise `completeMcpSignIn` decides, and
 * the page says what happened (→ Page outcomes). A Registry that cannot be reached is a page too, saying nothing was saved.
 * The route logs no address: it holds a single-use code.
 */
export const serveCallback = (registry: () => SignInRegistry, path: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.method !== "GET") return methodNotAllowed("GET");

    const input = callbackInput(path, queryOf(request.url));

    if (input === undefined) return respond(invalidCallbackPage());

    const answer = yield* registry()
      .completeMcpSignIn(input)
      .pipe(
        Effect.map(readMcpSignInCompleteAnswer),
        Effect.catchCause(() =>
          Effect.logWarning("The MCP sign-in callback could not reach the Registry").pipe(
            Effect.as(
              readMcpSignInCompleteAnswer({
                status: "unavailable",
                message: "cloudpid could not reach its store. Nothing was saved.",
              }),
            ),
          ),
        ),
      );

    return respond(callbackPage(answer));
  });

// The start (→ The link) -----------------------------------------------------------------------------------------------------

const redirectTo = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.fromWeb(
    new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, location } }),
  );

/** The longest name or id the start link carries. */
const MAX_LINK_PARAMETER_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const PLAIN_PARAMETER = /^[^\u0000-\u001f\u007f]+$/;

/** A start link's parameter, when it is present, bounded and free of control characters. */
const parameter = (query: URLSearchParams, name: string): string | undefined => {
  const value = query.get(name);

  return value !== null && value.length <= MAX_LINK_PARAMETER_LENGTH && PLAIN_PARAMETER.test(value)
    ? value
    : undefined;
};

const MAX_FORM_BYTES = 2048;

/**
 * `GET`/`POST /oauth/mcp/start`, behind Access: the owner's link starts a sign-in and answers in that tab with a 303 to the
 * authorization page, the issuer interstitial or an error page; the interstitial's Continue and Cancel are the `POST`. Both
 * need the origin the sign-in starts on (the stage's own, or one of `alchemy dev`'s two, from `Host`), a `GET` needs
 * `Sec-Fetch-Site: same-origin`, and a `POST` an `Origin` equal to that origin.
 */
export const serveStart = (registry: () => SignInRegistry, env: SignInEnv) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const stage = stageOf(env, request.headers.host);
    const query = queryOf(request.url);
    const back = safeReturnPath(query.get("return"));

    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");

    if (stage === undefined) {
      return respond(startProblemPage("This address cannot start a sign-in.", 400, undefined));
    }

    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return respond(
        startProblemPage(
          "Start a sign-in from the link in cloudpid, not from another site.",
          403,
          undefined,
        ),
      );
    }

    if (request.method === "POST") return yield* answerConfirmation(registry, request, stage);

    const environment = parameter(query, "environment");
    const server = parameter(query, "server");

    if (environment === undefined || server === undefined) {
      return respond(startProblemPage("The link names no server to sign in to.", 400, back));
    }

    const session = parameter(query, "session");
    const requested = parameter(query, "request");

    const answer = yield* registry()
      .startMcpSignIn({
        environment,
        server,
        stage,
        stepUp: query.get("step_up") === "1",
        requester:
          session !== undefined && requested !== undefined
            ? { session, request: requested }
            : undefined,
        returnPath: back,
      })
      .pipe(
        Effect.map(readMcpSignInStartAnswer),
        Effect.catchCause(() =>
          Effect.logWarning("The MCP sign-in start could not reach the Registry").pipe(
            Effect.as(
              readMcpSignInStartAnswer({
                status: "problem",
                message: "cloudpid could not reach its store. Try again.",
              }),
            ),
          ),
        ),
      );

    switch (answer.status) {
      case "redirect":
        return redirectTo(answer.url);
      case "confirm":
        return respond(interstitialPage(answer.confirmation));
      case "problem":
        return respond(startProblemPage(answer.message, 400, back));
    }
  });

/** The interstitial's `POST`: Continue sends the owner on, Cancel deletes the pending row. */
const answerConfirmation = (
  registry: () => SignInRegistry,
  request: HttpServerRequest.HttpServerRequest,
  stage: McpSignInStage,
) =>
  Effect.gen(function* () {
    if (request.headers.origin !== stage.origin) {
      return respond(
        startProblemPage("This answer did not come from cloudpid's own page.", 403, undefined),
      );
    }

    const isForm =
      request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") === true;

    // A request the Worker received is a Web request already: converting it cannot fail.
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));

    const text = isForm
      ? yield* Effect.promise(() => boundedText(new Response(web.body), MAX_FORM_BYTES))
      : undefined;

    const form = new URLSearchParams(text ?? "");
    const state = form.get("state") ?? "";
    const decision = form.get("decision") ?? "";

    if (text === undefined || !WELL_FORMED_STATE.test(state)) {
      return respond(
        startProblemPage("This answer is not one cloudpid asked for.", 400, undefined),
      );
    }

    const answer = yield* registry()
      .confirmMcpSignIn({ state, decision })
      .pipe(
        Effect.map(readMcpSignInConfirmAnswer),
        Effect.catchCause(() =>
          Effect.logWarning("The MCP sign-in confirmation could not reach the Registry").pipe(
            Effect.as(
              readMcpSignInConfirmAnswer({
                status: "problem",
                message: "cloudpid could not reach its store. Try again.",
              }),
            ),
          ),
        ),
      );

    switch (answer.status) {
      case "redirect":
        return redirectTo(answer.url);
      case "cancelled":
        return respond(cancelledPage());
      case "expired":
        return respond(
          startProblemPage(
            "This sign-in expired or was already used. Start it again.",
            400,
            undefined,
          ),
        );
      case "problem":
        return respond(startProblemPage(answer.message, 400, undefined));
    }
  });

/** Whether `environment` is Global's own (`environment=all` of the start link). */
export const isGlobalEnvironment = (environment: string): boolean =>
  environment === MCP_SIGN_IN_GLOBAL;
