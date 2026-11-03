// The pages of an MCP sign-in (`docs/architecture/mcp-sign-in.md` → Starting and completing a sign-in, Page outcomes; ADR-0035):
// the callback's outcome pages, the start's problem page, the page a start asks on (a link that did not come from a tab of
// the app) and the issuer interstitial. Pure: a page is a string and its
// headers, so the security of it is tested without a Worker.
//
// The callback is public and its URL carries a single-use code, so its page must not leak it: `Referrer-Policy:
// no-referrer`, `Cache-Control: no-store`, a CSP that allows only its own inline script and style **by hash** (Cloudflare's
// injected scripts copy a nonce, so a nonce would let them run) and no other source, and `history.replaceState` as the first
// thing its script does. The page holds no token, code, `state` or authorization URL; what an authorization server said is
// escaped and at most 300 characters. The message it posts on `BroadcastChannel("cloudpid:mcp-sign-in")` is the outcome and
// nothing else. No page ever redirects on its own: on the installed iOS PWA the sign-in opens in an in-app sheet. The two
// pages with a form (the prompt and the interstitial) send `Referrer-Policy: same-origin` instead: under `no-referrer` a
// browser's form POST carries `Origin: null`, which the Worker refuses.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import type {
  McpSignInConfirmation,
  McpSignInFailure,
  McpSignInKnownCompleteAnswer,
} from "@cloudpid/mcp/types";
import { MCP_SIGN_IN_GLOBAL } from "@cloudpid/mcp/types";
import { SIGN_IN_CHANNEL } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { sha256Bytes } from "./sign-in-client.ts";

/**
 * The callback page's one script: it takes the code out of the address bar, then tells the channel the outcome. It is
 * constant, so its hash is, and the page's outcome is in `data-outcome`. The message is `{ outcome }`: no server, no
 * Environment, no secret.
 */
export const CALLBACK_SCRIPT =
  `history.replaceState(null,"",location.pathname);` +
  `try{var c=new BroadcastChannel("${SIGN_IN_CHANNEL}");` +
  `c.postMessage({outcome:document.body.dataset.outcome});c.close()}catch(e){}`;

/** The page's styles: constant, and allowed by hash. */
export const PAGE_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1.25rem;color:#1c1c1e;background:#fff}" +
  "main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .75rem}" +
  "dl{margin:1rem 0}dt{font-weight:600;margin-top:.5rem}dd{margin:0;overflow-wrap:anywhere}" +
  "a,button{font:inherit;display:inline-block;margin:.75rem .5rem 0 0;padding:.5rem 1rem;border:1px solid #1c1c1e;" +
  "border-radius:.5rem;color:#1c1c1e;background:#fff;text-decoration:none;cursor:pointer}" +
  "button.primary{background:#1c1c1e;color:#fff}.note{color:#555}" +
  "@media(prefers-color-scheme:dark){body{color:#f2f2f7;background:#000}a,button{color:#f2f2f7;background:#000;border-color:#f2f2f7}" +
  "button.primary{background:#f2f2f7;color:#000}.note{color:#aaa}}";

/** `'sha256-…'` for `text`, as a CSP source expression. */
export const cspHash = (text: string): string =>
  `'sha256-${btoa(String.fromCharCode(...sha256Bytes(text)))}'`;

/** `text` safe in HTML text and in a double-quoted attribute. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** A page and how to send it. */
export type Page = {
  readonly status: number;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
};

type Fields = ReadonlyArray<readonly [string, string]>;

type Body = {
  readonly title: string;
  /** What the callback script tells the channel; absent for a page that has none. */
  readonly outcome: string | undefined;
  readonly lines: ReadonlyArray<string>;
  readonly fields: Fields;
  /** The links and form of the page, as HTML built here from escaped parts. */
  readonly actions: string;
  readonly formAction: boolean;
};

/**
 * The referrer policy of a page. `no-referrer` everywhere a page has no form (the callback's address holds a code). A form
 * page sends `same-origin` instead: under `no-referrer` a browser's form POST carries `Origin: null` (Fetch's origin
 * serialization), and the Worker takes a POST only from its own origin, so every Continue and Cancel would be refused.
 * `same-origin` leaves `Origin` as the page's own and sends nothing to another site.
 */
const referrerPolicyOf = (formAction: boolean): string =>
  formAction ? "same-origin" : "no-referrer";

const headersOf = (csp: string, referrerPolicy: string): Page["headers"] => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": referrerPolicy,
  "content-security-policy": csp,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

/** The page around `body`: its CSP allows its own style, its own script when it has one, and a form to this origin when it has one. */
const render = (status: number, body: Body): Page => {
  const script = body.outcome === undefined ? "" : `<script>${CALLBACK_SCRIPT}</script>`;

  const csp = [
    "default-src 'none'",
    `style-src ${cspHash(PAGE_STYLE)}`,
    `script-src ${body.outcome === undefined ? "'none'" : cspHash(CALLBACK_SCRIPT)}`,
    "base-uri 'none'",
    // A form page has no `form-action`: browsers apply it to every redirect after the submission too, so `'self'` blocks the
    // 303 to the authorization server (whose origin is not known when the page renders, so it cannot be listed). The POST's
    // safety is the Worker's own (`Origin` and `Sec-Fetch-Site`), and the page cannot be framed or run a script.
    ...(body.formAction ? [] : ["form-action 'none'"]),
    "frame-ancestors 'none'",
  ].join("; ");

  const lines = Arr.map(body.lines, (line) => `<p>${escapeHtml(line)}</p>`).join("");

  const fields =
    body.fields.length === 0
      ? ""
      : `<dl>${Arr.map(
          body.fields,
          ([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`,
        ).join("")}</dl>`;

  const attribute = body.outcome === undefined ? "" : ` data-outcome="${escapeHtml(body.outcome)}"`;

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="${referrerPolicyOf(body.formAction)}"><title>${escapeHtml(body.title)}</title>` +
    `<style>${PAGE_STYLE}</style></head><body${attribute}><main><h1>${escapeHtml(body.title)}</h1>` +
    `${lines}${fields}${body.actions}${script}</main></body></html>`;

  return { status, html, headers: headersOf(csp, referrerPolicyOf(body.formAction)) };
};

const link = (href: string, text: string): string =>
  `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;

/** Where Start again goes: the start link of the server, back to where the owner was. */
const startAgainHref = (retry: { environment: string; server: string }, back: string): string =>
  `/oauth/mcp/start?${new URLSearchParams({ environment: retry.environment, server: retry.server, return: back }).toString()}`;

type Retry = { readonly environment: string; readonly server: string };

/** Back and Start again, after "You can close this tab". */
const exits = (back: string | undefined, retry: Retry | undefined): string => {
  const to = back ?? "/";

  return (
    `<p class="note">You can close this tab.</p>` +
    link(to, "Back") +
    (retry === undefined ? "" : link(startAgainHref(retry, to), "Start again"))
  );
};

/** The names of the Environments a sign-in serves, as a sentence. */
const environmentsLine = (names: ReadonlyArray<string>): string =>
  names.length === 0
    ? "No Environment uses this sign-in yet."
    : `Used by ${Arr.join(names, ", ")}.`;

/** What a failed callback's page says and answers: its HTTP status (a decline is no error, an unreadable store is the server's), title and lines. */
type FailureEntry = {
  readonly status: number;
  readonly title: string;
  readonly lines: (failure: McpSignInFailure) => ReadonlyArray<string>;
};

const detailOf = (failure: McpSignInFailure): ReadonlyArray<string> =>
  failure.message === undefined ? [] : [failure.message];

/** Every failed outcome of a callback (→ Page outcomes), keyed by its status so none can be left out. */
const FAILURES: Readonly<Record<McpSignInFailure["status"], FailureEntry>> = {
  expired: {
    status: 400,
    title: "This sign-in link has expired",
    lines: () => [
      "It was already used, replaced by a newer sign-in, or older than 10 minutes. Nothing was saved.",
    ],
  },
  declined: {
    status: 200,
    title: "Sign-in declined",
    lines: () => ["You declined at the server's page. Nothing changed."],
  },
  provider_error: {
    status: 400,
    title: "The server could not sign you in",
    lines: (failure) => [
      failure.code === undefined ? "Its error:" : `Its error code: ${failure.code}.`,
      ...detailOf(failure),
    ],
  },
  missing_code: {
    status: 400,
    title: "The answer was incomplete",
    lines: () => ["It carried no code. Nothing was saved."],
  },
  iss_mismatch: {
    status: 400,
    title: "The answer came from another server",
    lines: () => [
      "It was not from the authorization server the sign-in started at. Nothing was saved.",
    ],
  },
  exchange_failed: {
    status: 400,
    title: "The server refused the sign-in",
    lines: (failure) => [
      failure.code === undefined
        ? "Exchanging the code failed. The old sign-in is unchanged."
        : `Exchanging the code failed (${failure.code}). The old sign-in is unchanged.`,
      ...detailOf(failure),
    ],
  },
  path_mismatch: {
    status: 400,
    title: "The answer came to the wrong address",
    lines: () => ["Nothing was saved."],
  },
  unconfirmed: {
    status: 400,
    title: "The issuer was not confirmed",
    lines: () => ["Nothing was saved."],
  },
  unavailable: {
    status: 503,
    title: "The sign-in could not be completed",
    lines: (failure) => ["Nothing was saved.", ...detailOf(failure)],
  },
};

/** The page of a callback's outcome (→ Page outcomes); every one says it can be closed and offers Back and Start again. */
export const callbackPage = (answer: McpSignInKnownCompleteAnswer): Page => {
  if (answer.status === "signed_in") {
    return render(200, {
      title: "Signed in",
      outcome: "signed_in",
      lines: [
        `cloudpid signed in to ${answer.server}.`,
        environmentsLine(Arr.map(answer.environments, ({ name }) => name)),
      ],
      fields: [],
      actions: exits(answer.returnPath, answer.retry),
      formAction: false,
    });
  }

  const failure = FAILURES[answer.status];

  return render(failure.status, {
    title: failure.title,
    outcome: answer.status,
    lines: failure.lines(answer),
    fields: [],
    actions: exits(answer.returnPath, answer.retry),
    formAction: false,
  });
};

/** The page for a callback whose `state` is not one cloudpid makes: static, and the Registry is never called. */
export const invalidCallbackPage = (): Page =>
  render(400, {
    title: "This is not a sign-in answer",
    outcome: "invalid",
    lines: ["The address has no valid sign-in in it. Nothing was saved."],
    fields: [],
    actions: exits(undefined, undefined),
    formAction: false,
  });

/** The page of a start that went no further: the reason is the owner's to read, never a secret. */
export const startProblemPage = (message: string, status: number, back: string | undefined): Page =>
  render(status, {
    title: "Can't start this sign-in",
    outcome: undefined,
    lines: [message],
    fields: [],
    actions: `<p class="note">You can close this tab.</p>${link(back ?? "/", "Back")}`,
    formAction: false,
  });

/** What a start link, or the form of its confirmation, names. */
export type StartLink = {
  readonly environment: string;
  readonly server: string;
  readonly stepUp: boolean;
  readonly requester: { readonly session: string; readonly request: string } | undefined;
  readonly back: string | undefined;
};

/**
 * The page of a start link that did not come from a tab of the app (typed in, or the navigation back from an Access
 * login): nothing starts until its Continue, a `POST` the Worker takes only from its own origin.
 */
export const startPromptPage = (prompt: StartLink): Page => {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

  const form =
    `<form method="post" action="/oauth/mcp/start">` +
    hidden("environment", prompt.environment) +
    hidden("server", prompt.server) +
    (prompt.stepUp ? hidden("step_up", "1") : "") +
    (prompt.requester === undefined
      ? ""
      : hidden("session", prompt.requester.session) + hidden("request", prompt.requester.request)) +
    (prompt.back === undefined ? "" : hidden("return", prompt.back)) +
    `<button class="primary" type="submit">Continue</button></form>` +
    link(prompt.back ?? "/", "Back");

  return render(200, {
    title: prompt.stepUp ? "Allow more access?" : "Sign in?",
    outcome: undefined,
    lines: [
      "cloudpid will open the server's own page to sign in. Continue only if you asked for this.",
    ],
    fields: [
      ["Server", prompt.server],
      [
        "Environment",
        prompt.environment === MCP_SIGN_IN_GLOBAL ? "All Environments" : prompt.environment,
      ],
    ],
    actions: form,
    formAction: true,
  });
};

/** What Cancel says: the pending row is deleted and nothing changed. */
export const cancelledPage = (): Page =>
  render(200, {
    title: "Sign-in cancelled",
    outcome: undefined,
    lines: ["Nothing changed."],
    fields: [],
    actions: exits(undefined, undefined),
    formAction: false,
  });

/** The issuer interstitial (→ Issuer binding): what is about to be trusted, and Continue or Cancel as one `POST`. */
export const interstitialPage = (confirmation: McpSignInConfirmation): Page => {
  const fields: Array<readonly [string, string]> = [
    ["Server", confirmation.server],
    ["Source", confirmation.source === "owner" ? "Your own entry" : confirmation.source],
    ["URL", confirmation.url],
    ["Authorization server", confirmation.issuer],
    ["Client ID", confirmation.clientId],
  ];

  if (confirmation.previousIssuer !== undefined) {
    fields.push(["Signed in before at", confirmation.previousIssuer]);
  }

  if (confirmation.secret !== undefined) {
    fields.push([
      "Client secret",
      `\${${confirmation.secret.name}}, from your ${confirmation.secret.scope === "secret" ? "Secrets" : "Variables"}`,
    ]);
  }

  const form =
    `<form method="post" action="/oauth/mcp/start">` +
    `<input type="hidden" name="state" value="${escapeHtml(confirmation.state)}">` +
    `<button class="primary" type="submit" name="decision" value="continue">Continue</button>` +
    `<button type="submit" name="decision" value="cancel">Cancel</button></form>`;

  return render(200, {
    title: "Confirm the authorization server",
    outcome: undefined,
    lines: [
      confirmation.previousIssuer === undefined
        ? "This client has not signed in at this authorization server before. Continue only if you expect it."
        : "This client signed in at another authorization server before. Continue only if you expect the change.",
    ],
    fields,
    actions: form,
    formAction: true,
  });
};
