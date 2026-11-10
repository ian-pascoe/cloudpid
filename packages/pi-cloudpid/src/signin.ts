// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off asyncFunction:off nodeBuiltinImport:off newPromise:off globalTimers:off globalDate:off tryCatchInEffectGen:off -- native array methods over plain values (the extension carries no Effect runtime); native object methods over plain values; plain functions over values, called directly; plain Promises, as pi's extension API and child processes give them; runs on node, on the owner's machine; wraps a callback API (a server, a child process, a timer); the time the tokens were obtained.
/**
 * Signing in (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The connection): the authorization-code
 * flow with PKCE against Access, run by the SDK's `auth()`. The redirect is `http://127.0.0.1:<ephemeral port>/callback`,
 * served here by a loopback server that takes exactly one request with the matching `state` and gives up after five
 * minutes; a redirect URL pasted into pi's input (a laptop reached over SSH has no browser to reach the port) completes
 * it just as well. Opening the browser is a seam (`openBrowser`).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  auth,
  type AuthOptions,
  createFetchWithInit,
  type FetchLike,
} from "@modelcontextprotocol/client";
import * as Predicate from "effect/Predicate";
import { type Config, endpointKey } from "./config.ts";
import type { AuthStore } from "./auth-store.ts";
import { Refusal } from "./errors.ts";
import type { SignInResult, Ui } from "./flow.ts";
import { captureSdkWarnings, CloudpidOAuthProvider, probeSignIn } from "./oauth.ts";

/** What of pi's UI signing in uses. */
export type SignInUi = Pick<Ui, "notify" | "input">;

export interface SignInDeps {
  readonly store: AuthStore;
  /** The `fetch` for every request signing in makes; tests give the stub's. */
  readonly fetch?: FetchLike;
  /** Opens a URL in the owner's browser. */
  readonly openBrowser: (url: string) => Promise<void>;
  /** The `X-Cloudpid-Client` value. */
  readonly client: string;
  /** How long to wait for the redirect; five minutes. */
  readonly timeoutMs?: number;
  readonly now?: (() => number) | undefined;
}

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** What the authorization server sent the redirect URL with. */
export interface Callback {
  readonly code: string;
  /** RFC 9207's `iss`, when the server sent it. */
  readonly iss: string | undefined;
}

/**
 * The code in a redirect URL (what the loopback server received, or what the owner pasted: the whole URL, or just its
 * query). A {@link Refusal} when the server reports an error, the `state` is not the one this sign-in sent, or there is
 * no code.
 */
export const parseRedirect = (raw: string, state: string): Callback => {
  const text = raw.trim();
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query.replace(/#.*$/, ""));

  const error = params.get("error");

  if (error !== null && params.get("state") === state) {
    const detail = params.get("error_description");

    throw new Refusal(
      `sign-in was not completed: ${error}${detail === null ? "" : ` (${detail})`}.`,
    );
  }

  if (params.get("state") !== state) {
    throw new Refusal(
      "that redirect is not for this sign-in (its state does not match): paste the URL your browser ended up at after signing in.",
    );
  }

  const code = params.get("code");

  if (code === null || code === "") {
    throw new Refusal("that redirect has no authorization code: paste the whole URL.");
  }

  return { code, iss: params.get("iss") ?? undefined };
};

export interface CallbackServer {
  /** `http://127.0.0.1:<port>/callback`. */
  readonly redirectUrl: string;
  /** The code of the one request that carried the expected `state`; rejects when the timeout passes. */
  readonly result: Promise<Callback>;
  readonly close: () => void;
}

/** `text` as HTML text: the page echoes what the authorization server sent (`error_description`), which is not ours. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>cloudpid</title><p>${escapeHtml(message)}</p>`;

/** The loopback server of one sign-in: a request with another `state` is refused and the wait goes on. */
export const startCallbackServer = async (
  state: string,
  timeoutMs: number,
): Promise<CallbackServer> => {
  let finish: (
    outcome: { readonly callback: Callback } | { readonly failure: Error },
  ) => void = () => undefined;

  const result = new Promise<Callback>((resolve, reject) => {
    finish = (outcome) =>
      "callback" in outcome ? resolve(outcome.callback) : reject(outcome.failure);
  });

  // Whoever awaits `result` sees a rejection; a sign-in that ended some other way must not leave it unhandled.
  result.catch(() => undefined);

  let settled = false;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    const reply = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE(message));
    };

    if (url.pathname !== "/callback" || settled) {
      reply(404, "Not found.");

      return;
    }

    if (url.searchParams.get("state") !== state) {
      reply(400, "This is not the sign-in cloudpid is waiting for.");

      return;
    }

    settled = true;

    try {
      finish({ callback: parseRedirect(url.search, state) });
      reply(200, "Signed in to cloudpid. You can close this tab and go back to pi.");
    } catch (error) {
      finish({ failure: error instanceof Error ? error : new Error("sign-in failed") });
      reply(400, error instanceof Error ? error.message : "Sign-in failed.");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!Predicate.isObject(address)) {
    server.close();

    throw new Refusal("could not listen on the loopback interface for the sign-in redirect.");
  }

  const timer = setTimeout(() => {
    settled = true;
    finish({
      failure: new Refusal(
        `no sign-in arrived in ${String(Math.round(timeoutMs / 60_000))} minutes: run /cloudpid login again.`,
      ),
    });
  }, timeoutMs);

  return {
    redirectUrl: `http://127.0.0.1:${String(address.port)}/callback`,
    result,
    close: () => {
      clearTimeout(timer);
      settled = true;
      server.close();
      server.closeAllConnections();
    },
  };
};

/** Asks for a pasted redirect URL until one is for this sign-in; cancelling the dialog cancels the sign-in. */
const pasted = async (
  ui: SignInUi,
  state: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Callback> => {
  for (;;) {
    const text = await ui.input(
      "Sign in to cloudpid",
      "Waiting for your browser. If it cannot reach this machine (SSH), paste the URL it ends up at, http://127.0.0.1:…/callback?code=…",
      { signal, timeout: timeoutMs },
    );

    if (text === undefined) throw new Refusal("sign-in cancelled.");

    try {
      return parseRedirect(text, state);
    } catch (error) {
      if (signal.aborted) throw error;

      ui.notify(error instanceof Error ? error.message : "that is not a redirect URL.", "warning");
    }
  }
};

/** The command that opens `url` on this platform, and how to run it. */
const opener = (url: string) => {
  if (process.platform === "darwin") return { command: "open", args: [url], verbatim: false };

  // `start` is a cmd built-in; the URL is quoted for it (an `&` in a URL would end the command).
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true };
  }

  return { command: "xdg-open", args: [url], verbatim: false };
};

/** `openBrowser` in production: the platform's own opener, detached. */
export const openInBrowser = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const { command, args, verbatim } = opener(url);

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: verbatim,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/**
 * Signs in to the endpoint: discovery from the 401's `resource_metadata`, a fresh Dynamic Client Registration, the
 * browser (or a pasted redirect URL), the code exchange, and the entry stored for the endpoint, replacing the old one
 * only once the new tokens are in. The SDK's own warnings go to `ui` as warnings, not to the console.
 */
export const signIn = async (
  config: Config,
  ui: SignInUi,
  deps: SignInDeps,
): Promise<SignInResult> => {
  const raw = deps.fetch ?? fetch;
  const headers = { "X-Cloudpid-Client": deps.client };
  const fetchFn = createFetchWithInit(raw, { headers, redirect: "manual" });
  const timeoutMs = deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS;

  const probe = await probeSignIn(config.url, raw, headers);

  if (!probe.needed) return "not-required";

  const state = randomBytes(32).toString("base64url");
  const callback = await startCallbackServer(state, timeoutMs);
  const waiting = new AbortController();

  const releaseWarnings = captureSdkWarnings((message) =>
    ui.notify(`cloudpid: ${message}`, "warning"),
  );

  try {
    const provider = new CloudpidOAuthProvider({
      store: deps.store,
      endpoint: endpointKey(config),
      redirectUrl: callback.redirectUrl,
      state,
      fresh: true,
      now: deps.now,
      onRedirect: (url) => {
        ui.notify(
          `Opening your browser to sign in to cloudpid. If it does not open, visit:\n${url.href}`,
          "info",
        );

        deps.openBrowser(url.href).catch((error: Error) => {
          ui.notify(
            `could not open a browser (${error.message}): visit the URL above, or paste the redirect URL when asked.`,
            "warning",
          );
        });
      },
    });

    const options: AuthOptions = { serverUrl: config.url, fetchFn };

    if (probe.resourceMetadataUrl !== undefined) {
      options.resourceMetadataUrl = probe.resourceMetadataUrl;
    }

    if (probe.scope !== undefined) options.scope = probe.scope;

    if ((await auth(provider, options)) !== "REDIRECT") {
      throw new Refusal("the sign-in server did not ask for a sign-in.");
    }

    const received = await Promise.race([
      callback.result,
      pasted(ui, state, waiting.signal, timeoutMs),
    ]);

    waiting.abort();

    const exchange: AuthOptions = { ...options, authorizationCode: received.code };

    if (received.iss !== undefined) exchange.iss = received.iss;

    await auth(provider, exchange);

    return "signed-in";
  } catch (error) {
    if (error instanceof Refusal) throw error;

    throw new Refusal(
      `sign-in failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    releaseWarnings();
    waiting.abort();
    callback.close();
  }
};
