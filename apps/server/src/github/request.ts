// The one way the Worker asks GitHub's REST API as the GitHub App (ADR-0025): the headers, a token for the installation
// on the repo's owner else the app owner's (which reads any public repo), the one retry with a new token after a 401, and
// how a rate limit is told. `workspace/github-pulls.ts` (pull requests, branches) and `contents.ts` (a Skill's files)
// read through it and tell each failure in their own words.
// @effect-diagnostics asyncFunction:off globalFetch:off missingPipeableSignature:off -- GitHub is read with `fetch`, a Promise API.
import type { GitHubTokens } from "./app.ts";

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What is asked: GitHub's media type for the answer, and a request with a JSON body when there is one. */
export type GithubRequest = {
  readonly accept?: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
};

/** The message of a thrown value. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** `url` asked once, with `token` when there is one: the response, or why GitHub could not be reached. */
export const askGithub = async (
  fetch: GithubFetch,
  url: string,
  request: GithubRequest,
  token: string | undefined,
  timeoutMs: number,
): Promise<{ readonly response: Response } | { readonly unreachable: string }> => {
  const headers = new Headers({
    accept: request.accept ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "cloudpid",
  });

  if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);

  if (request.body !== undefined) headers.set("content-type", "application/json");

  const init: RequestInit = {
    method: request.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (request.body !== undefined) init.body = request.body;

  try {
    return { response: await fetch(url, init) };
  } catch (cause) {
    return { unreachable: messageOf(cause) };
  }
};

/** What asking as the app came to. `installed` says whether the token is the owner's installation's, not the app owner's. */
export type AppAnswer =
  | { readonly status: "answered"; readonly response: Response; readonly installed: boolean }
  | { readonly status: "no_token"; readonly message: string }
  | { readonly status: "unreachable"; readonly message: string };

/**
 * `url` asked with a token for the installation on `owner`, else the app owner's; when GitHub refuses the token with a
 * 401 it is invalidated and the request made once more with a new one.
 */
export const askAsApp = async (
  options: {
    readonly fetch: GithubFetch;
    readonly github: Pick<GitHubTokens, "token" | "invalidate">;
    readonly timeoutMs: number;
  },
  owner: string,
  url: string,
  request: GithubRequest = {},
): Promise<AppAnswer> => {
  const { github } = options;

  for (let attempt = 1; ; attempt++) {
    let token: string;
    let installed = true;

    try {
      token = await github.token(owner);
    } catch (cause) {
      installed = false;

      try {
        token = await github.token();
      } catch {
        return { status: "no_token", message: `No GitHub token: ${messageOf(cause)}` };
      }
    }

    const asked = await askGithub(options.fetch, url, request, token, options.timeoutMs);

    if ("unreachable" in asked) return { status: "unreachable", message: asked.unreachable };

    if (asked.response.status === 401 && attempt === 1) {
      github.invalidate(token);
      continue;
    }

    return { status: "answered", response: asked.response, installed };
  }
};

/**
 * Whether GitHub's answer is its rate limit, primary (no requests left) or secondary (a wait is asked, on a 403 or a
 * 429), and not a refusal of the token; with the seconds to wait, or the time it resets, when it says.
 */
export const rateLimitOf = (
  response: Response,
): { readonly retryAfterSeconds?: number; readonly resetsAt?: number } | undefined => {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const waits = Number.isFinite(retryAfter) && retryAfter > 0;

  if (
    response.status !== 429 &&
    !(response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || waits))
  ) {
    return undefined;
  }

  const resets = Number.isFinite(reset) && reset > 0;

  if (waits)
    return resets
      ? { retryAfterSeconds: retryAfter, resetsAt: reset * 1_000 }
      : { retryAfterSeconds: retryAfter };

  return resets ? { resetsAt: reset * 1_000 } : {};
};
