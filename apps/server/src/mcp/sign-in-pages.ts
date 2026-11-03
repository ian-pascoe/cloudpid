// The pages of an MCP sign-in (`docs/architecture/mcp-sign-in.md` → Starting and completing a sign-in, Page outcomes; ADR-0035):
// the callback's outcome pages, the start's problem page and the issuer interstitial. Pure: a page is a string and its
// headers, so the security of it is tested without a Worker.
//
// The callback is public and its URL carries a single-use code, so its page must not leak it: `Referrer-Policy:
// no-referrer`, `Cache-Control: no-store`, a CSP that allows only its own inline script and style **by hash** (Cloudflare's
// injected scripts copy a nonce, so a nonce would let them run) and no other source, and `history.replaceState` as the first
// thing its script does. The page holds no token, code, `state` or authorization URL; what an authorization server said is
// escaped and at most 300 characters. The message it posts on `BroadcastChannel("cloudpid:mcp-sign-in")` is the outcome and
// nothing else. No page ever redirects on its own: on the installed iOS PWA the sign-in opens in an in-app sheet.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { sha256Hex } from "@cloudpid/config";
import type {
  McpSignInConfirmation,
  McpSignInFailure,
  McpSignInKnownCompleteAnswer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";

/** The channel the callback page tells Settings (any open tab of the app) on. */
export const SIGN_IN_CHANNEL = "cloudpid:mcp-sign-in";

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
export const cspHash = (text: string): string => {
  const hex = sha256Hex(text);
  const bytes = Arr.makeBy(32, (index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));

  return `'sha256-${btoa(String.fromCharCode(...bytes))}'`;
};

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

const headersOf = (csp: string): Page["headers"] => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
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
    `form-action ${body.formAction ? "'self'" : "'none'"}`,
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
    `<meta name="referrer" content="no-referrer"><title>${escapeHtml(body.title)}</title>` +
    `<style>${PAGE_STYLE}</style></head><body${attribute}><main><h1>${escapeHtml(body.title)}</h1>` +
    `${lines}${fields}${body.actions}${script}</main></body></html>`;

  return { status, html, headers: headersOf(csp) };
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

/** What a page says of a failed callback. */
type FailureText = { readonly title: string; readonly lines: ReadonlyArray<string> };

/** The title and lines of a failed callback. */
const failureText = (failure: McpSignInFailure): FailureText => {
  const detail = failure.message === undefined ? [] : [failure.message];

  switch (failure.status) {
    case "expired":
      return {
        title: "This sign-in link has expired",
        lines: [
          "It was already used, replaced by a newer sign-in, or older than 10 minutes. Nothing was saved.",
        ],
      };
    case "declined":
      return {
        title: "Sign-in declined",
        lines: ["You declined at the server's page. Nothing changed."],
      };
    case "provider_error":
      return {
        title: "The server could not sign you in",
        lines: [
          failure.code === undefined ? "Its error:" : `Its error code: ${failure.code}.`,
          ...detail,
        ],
      };
    case "missing_code":
      return {
        title: "The answer was incomplete",
        lines: ["It carried no code. Nothing was saved."],
      };
    case "iss_mismatch":
      return {
        title: "The answer came from another server",
        lines: [
          "It was not from the authorization server the sign-in started at. Nothing was saved.",
        ],
      };
    case "path_mismatch":
      return {
        title: "The answer came to the wrong address",
        lines: ["Nothing was saved."],
      };
    case "unconfirmed":
      return { title: "The issuer was not confirmed", lines: ["Nothing was saved."] };
    case "exchange_failed":
      return {
        title: "The server refused the sign-in",
        lines: [
          failure.code === undefined
            ? "Exchanging the code failed. The old sign-in is unchanged."
            : `Exchanging the code failed (${failure.code}). The old sign-in is unchanged.`,
          ...detail,
        ],
      };
    default:
      return {
        title: "The sign-in could not be completed",
        lines: ["Nothing was saved.", ...detail],
      };
  }
};

/** The HTTP status of each failed outcome's page: a decline is no error, and an unreadable store is the server's. */
const FAILURE_STATUS: Readonly<Record<McpSignInFailure["status"], number>> = {
  expired: 400,
  declined: 200,
  provider_error: 400,
  missing_code: 400,
  iss_mismatch: 400,
  exchange_failed: 400,
  path_mismatch: 400,
  unconfirmed: 400,
  unavailable: 503,
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
      actions: exits(answer.returnPath, undefined),
      formAction: false,
    });
  }

  const { title, lines } = failureText(answer);

  return render(FAILURE_STATUS[answer.status], {
    title,
    outcome: answer.status,
    lines,
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
