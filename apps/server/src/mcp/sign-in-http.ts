// The main Worker's three MCP sign-in routes (`docs/architecture/mcp-sign-in.md` → The client document and the callback outside
// Access, Starting and completing a sign-in; ADR-0035): the public client document and callback, and the start behind Access.
// What reaches the Registry is bounded and shaped here; what the owner's browser gets back is `sign-in-pages.ts`.
//
// The two public routes (`serveClientDocument`, `serveCallback`) never read identity: the callback's safety is the
// single-use `state`, the verifier only the Registry holds, the exact path and the `iss` check. `serveStart` is called only
// behind the Access guard; a link from a tab of the app (`Sec-Fetch-Site: same-origin`) starts at once, any other `GET` gets a
// page whose Continue is a `POST` (the owner's own click), and a `POST` needs an `Origin` equal to the origin the start was
// made on and the same-origin header. Nothing here logs a URL, a query or a body: a callback's address holds a single-use
// code.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off preferSchemaOverJson:off
import { boundedText } from "@cloudpid/mcp/oauth";
import {
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
import { type McpSignInCarry, noSignInCarry } from "./sign-in-carry.ts";
import {
  callbackPage,
  cancelledPage,
  interstitialPage,
  invalidCallbackPage,
  type Page,
  startProblemPage,
  type StartLink,
  startPromptPage,
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

  // The document is public on a live stage and answers 404 under `alchemy dev`, where no `Host` is read.
  const stage = stageOf(env, undefined);
  const status = stage === undefined ? 404 : 200;

  yield* Effect.annotateCurrentSpan({
    "http.user_agent": request.headers["user-agent"] ?? "",
    "cloudflare.asn": Option.getOrUndefined(decodeCf(request.source))?.cf?.asn,
    "http.status_code": status,
  });

  if (stage === undefined) return notFound;

  const document = clientDocument({
    origin: stage.origin,
    clientName: clientNameFor({ label: stage.label, local: false }),
  });

  return HttpServerResponse.fromWeb(
    new Response(request.method === "HEAD" ? null : JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    }),
  );
});

/**
 * A call to the Registry and its answer as this build reads it. A Registry that cannot be reached (or dies on the call) is
 * logged without a word of the request, and answers `unreachable`, which the page then says.
 */
const askRegistry = <A, B, E>(
  call: Effect.Effect<A, E>,
  read: (answer: A) => B,
  unreachable: { readonly log: string; readonly answer: A },
): Effect.Effect<B> =>
  call.pipe(
    Effect.map(read),
    Effect.catchCause(() =>
      Effect.logWarning(unreachable.log).pipe(Effect.as(read(unreachable.answer))),
    ),
  );

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
 * `GET /oauth/mcp/callback[/<hash>]`: the authorization server's answer, public and never reading identity. A `state`
 * that is not one cloudpid makes gets a static page and the Registry is never called; otherwise `completeMcpSignIn`
 * decides, a completed sign-in is carried to the hosts that use it (`carry`), and the page says what happened (→ Page
 * outcomes). A Registry that cannot be reached is a page too, saying nothing was saved. The route logs no address: it
 * holds a single-use code.
 */
export const serveCallback = (
  registry: () => SignInRegistry,
  path: string,
  carry: McpSignInCarry = noSignInCarry,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.method !== "GET") return methodNotAllowed("GET");

    const input = callbackInput(path, queryOf(request.url));

    if (input === undefined) return respond(invalidCallbackPage());

    const answer = yield* askRegistry(
      registry().completeMcpSignIn(input),
      readMcpSignInCompleteAnswer,
      {
        log: "The MCP sign-in callback could not reach the Registry",
        answer: {
          status: "unavailable",
          message: "cloudpid could not reach its store. Nothing was saved.",
        },
      },
    );

    // The hosts that use the sign-in are told before the page says so, so the server is asked at once; a host that is
    // not reached heals at its next `windowOpened`.
    if (answer.status === "signed_in") {
      yield* carry.carry({
        change: "signed_in",
        server: answer.server,
        environments: answer.environments,
        revision: answer.revision,
      });
    }

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

/** The link a start is made from, in a query or a form, or undefined when it names no server. */
const startLinkOf = (source: URLSearchParams): StartLink | undefined => {
  const environment = parameter(source, "environment");
  const server = parameter(source, "server");

  if (environment === undefined || server === undefined) return undefined;

  const session = parameter(source, "session");
  const request = parameter(source, "request");

  return {
    environment,
    server,
    stepUp: source.get("step_up") === "1",
    requester: session !== undefined && request !== undefined ? { session, request } : undefined,
    back: safeReturnPath(source.get("return")),
  };
};

/** Starts the sign-in a link names, and answers in the owner's tab: a 303 to the authorization page, or a page. */
const startSignIn = (registry: () => SignInRegistry, stage: McpSignInStage, link: StartLink) =>
  Effect.gen(function* () {
    const answer = yield* askRegistry(
      registry().startMcpSignIn({
        environment: link.environment,
        server: link.server,
        stage,
        stepUp: link.stepUp,
        requester: link.requester,
        returnPath: link.back,
      }),
      readMcpSignInStartAnswer,
      {
        log: "The MCP sign-in start could not reach the Registry",
        answer: { status: "problem", message: "cloudpid could not reach its store. Try again." },
      },
    );

    switch (answer.status) {
      case "redirect":
        return redirectTo(answer.url);
      case "confirm":
        return respond(interstitialPage(answer.confirmation));
      case "problem":
        return respond(startProblemPage(answer.message, 400, link.back));
    }
  });

/**
 * `GET`/`POST /oauth/mcp/start`, behind Access. A link from a tab of the app (`Sec-Fetch-Site: same-origin`) starts the
 * sign-in and answers in that tab with a 303 to the authorization page, the issuer interstitial or an error page. Any other
 * `GET` (a typed address, or the navigation back from an Access login, which is cross-site) starts nothing: it shows a page
 * whose Continue is a `POST`, which is the owner's own click. A `POST` needs an `Origin` equal to the origin the start was
 * made on and `Sec-Fetch-Site: same-origin`, so a page of another site cannot make it. The origin is the stage's own, or one
 * of `alchemy dev`'s two, from `Host`. The `POST` is also the issuer interstitial's Continue and Cancel.
 */
export const serveStart = (registry: () => SignInRegistry, env: SignInEnv) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");

    const stage = stageOf(env, request.headers.host);

    if (stage === undefined) {
      return respond(startProblemPage("This address cannot start a sign-in.", 400, undefined));
    }

    if (request.method === "POST") return yield* answerForm(registry, request, stage);

    const query = queryOf(request.url);
    const link = startLinkOf(query);

    if (link === undefined) {
      return respond(
        startProblemPage(
          "The link names no server to sign in to.",
          400,
          safeReturnPath(query.get("return")),
        ),
      );
    }

    // Only a navigation from a tab of the app starts at once: a same-origin `<img>` or `fetch` must not.
    const fromApp =
      request.headers["sec-fetch-site"] === "same-origin" &&
      request.headers["sec-fetch-mode"] === "navigate";

    return fromApp ? yield* startSignIn(registry, stage, link) : respond(startPromptPage(link));
  });

/** The `POST`: the start a prompt page confirmed, or the issuer interstitial's Continue or Cancel. */
const answerForm = (
  registry: () => SignInRegistry,
  request: HttpServerRequest.HttpServerRequest,
  stage: McpSignInStage,
) =>
  Effect.gen(function* () {
    if (
      request.headers.origin !== stage.origin ||
      request.headers["sec-fetch-site"] !== "same-origin"
    ) {
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

    if (text === undefined) {
      return respond(
        startProblemPage("This answer is not one cloudpid asked for.", 400, undefined),
      );
    }

    if (!form.has("state")) {
      const link = startLinkOf(form);

      return link === undefined
        ? respond(startProblemPage("This answer is not one cloudpid asked for.", 400, undefined))
        : yield* startSignIn(registry, stage, link);
    }

    const state = form.get("state") ?? "";

    if (!WELL_FORMED_STATE.test(state)) {
      return respond(
        startProblemPage("This answer is not one cloudpid asked for.", 400, undefined),
      );
    }

    const answer = yield* askRegistry(
      registry().confirmMcpSignIn({ state, decision: form.get("decision") ?? "" }),
      readMcpSignInConfirmAnswer,
      {
        log: "The MCP sign-in confirmation could not reach the Registry",
        answer: { status: "problem", message: "cloudpid could not reach its store. Try again." },
      },
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
