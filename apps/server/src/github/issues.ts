// The GitHub calls of a cloudpid report (`docs/architecture/agent-capabilities.md` → cloudpid reports, ADR-0051): the
// Registry posts to cloudpid's own repo as the GitHub App, with a token for the installation on its owner that asks only
// for `issues: write` on that one repo. Each call is asked once, never retried (a post GitHub may have made is never made
// again), and its answer read into what the Registry acts on: the label's precheck, the issue's creation (with the labels
// GitHub kept), and the one call that adds a label GitHub dropped. A rate limit is told with when to ask again.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off missingPipeableSignature:off preferEffectArray:off -- GitHub is asked with `fetch`, a Promise API, over native arrays.
import type { GitHubPermissions } from "@cloudpid/config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CLOUDPID_REPO } from "../deployment.ts";
import { GitHubApp, GitHubNotInstalled } from "./app.ts";
import type { GitHubAppSecrets } from "./config.ts";
import { askGithub, type GithubFetch, messageOf, rateLimitOf } from "./request.ts";

/** The one permission a report's token asks for (ADR-0051). */
export const CLOUDPID_REPORT_PERMISSIONS = { issues: "write" } as const satisfies GitHubPermissions;

const API = "https://api.github.com";

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** cloudpid's repo's owner and name, from `owner/name`. */
const [REPO_OWNER = "", REPO_NAME = ""] = CLOUDPID_REPO.split("/");

/** The account whose installation a report's token is minted for: the owner of cloudpid's repo. */
export const CLOUDPID_REPO_OWNER = REPO_OWNER;

/** A token for the installation on cloudpid's repo's owner, and how to tell a refused one. */
export type CloudpidReportTokens = {
  readonly token: () => Promise<string>;
  readonly invalidate: (token: string) => void;
};

/**
 * The GitHub App's tokens for reports: `issues: write` on cloudpid's repo alone, for the installation on its owner. Made
 * once per Registry object, so its token is shared by its reports.
 */
export const cloudpidReportTokens = (secrets: GitHubAppSecrets): CloudpidReportTokens => {
  const app = new GitHubApp({
    appId: Redacted.value(secrets.appId),
    privateKey: Redacted.value(secrets.privateKey),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    permissions: CLOUDPID_REPORT_PERMISSIONS,
    repositories: [REPO_NAME],
  });

  return {
    token: () => app.token(CLOUDPID_REPO_OWNER),
    invalidate: (token) => app.invalidate(token),
  };
};

/** Why no token could be had: the App not installed on the repo's owner (which the owner fixes), or anything else. */
export type TokenProblem = { readonly notInstalled: boolean; readonly message: string };

/** A token, or why none could be had. */
export const cloudpidReportToken = async (
  tokens: CloudpidReportTokens,
): Promise<{ readonly token: string } | { readonly problem: TokenProblem }> => {
  try {
    return { token: await tokens.token() };
  } catch (cause) {
    return {
      problem: { notInstalled: cause instanceof GitHubNotInstalled, message: messageOf(cause) },
    };
  }
};

/** What GitHub answered a call, as the Registry acts on it. */
export type IssueCallFailure =
  /** GitHub asked to wait until `until` (ms) before asking again. */
  | { readonly kind: "rate_limited"; readonly until: number; readonly message: string }
  /** GitHub refused the token (a 401): it is not handed out again. */
  | { readonly kind: "refused_token"; readonly message: string }
  /** Any other refusal, with GitHub's own words, or a GitHub that could not be reached or answered 5xx. */
  | { readonly kind: "failed"; readonly status?: number | undefined; readonly message: string };

const GitHubError = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.Array(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String),
      field: Schema.optionalKey(Schema.String),
    }),
  ).pipe(Schema.optionalKey),
});

const Labels = Schema.Array(Schema.Struct({ name: Schema.String }));

const CreatedIssue = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  labels: Schema.optionalKey(Labels),
});

const decodeError = Schema.decodeUnknownOption(GitHubError);
const decodeCreated = Schema.decodeUnknownOption(CreatedIssue);
const decodeLabels = Schema.decodeUnknownOption(Labels);

/** GitHub's own words of a refusal: its message, then each error it lists. */
const githubWords = async (response: Response): Promise<string> => {
  const said = Option.getOrUndefined(decodeError(await response.json().catch(() => null)));

  const details = (said?.errors ?? []).flatMap(({ message, code, field }) =>
    message !== undefined
      ? [message]
      : code !== undefined
        ? [field === undefined ? code : `${field} ${code}`]
        : [],
  );

  return [said?.message ?? response.statusText, ...details]
    .filter((part) => part !== "")
    .join(": ");
};

/** What a refusal is, by its status and the rate limit's headers, at `now`. */
const failureOf = async (response: Response, now: number): Promise<IssueCallFailure> => {
  const limit = rateLimitOf(response);
  const words = await githubWords(response);
  const said = `GitHub answered ${String(response.status)}${words === "" ? "" : `: ${words}`}`;

  if (limit !== undefined) {
    const until =
      limit.retryAfterSeconds !== undefined
        ? now + limit.retryAfterSeconds * 1000
        : (limit.resetsAt ?? now + 60_000);

    return { kind: "rate_limited", until, message: said };
  }

  if (response.status === 401) return { kind: "refused_token", message: said };

  return { kind: "failed", status: response.status, message: said };
};

/** What the calls are made with. */
export type IssueCalls = { readonly fetch: GithubFetch; readonly now: () => number };

/** The repo's label `label`: there, missing (a 404), or a failure. */
export const labelExists = async (
  calls: IssueCalls,
  token: string,
  label: string,
): Promise<"exists" | "missing" | IssueCallFailure> => {
  const asked = await askGithub(
    calls.fetch,
    `${API}/repos/${CLOUDPID_REPO}/labels/${encodeURIComponent(label)}`,
    {},
    token,
    REQUEST_TIMEOUT_MS,
  );

  if ("unreachable" in asked) {
    return { kind: "failed", message: `GitHub could not be reached: ${asked.unreachable}` };
  }

  if (asked.response.ok) return "exists";

  if (asked.response.status === 404) return "missing";

  return failureOf(asked.response, calls.now());
};

/** A created issue: its number, its page, and the labels GitHub kept on it. */
export type CreatedIssue = {
  readonly number: number;
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
};

/**
 * Create the issue. `sent` is a request GitHub may have received and never answered (or answered with what is not an
 * issue): it may have been made, so it is never asked again.
 */
export const createIssue = async (
  calls: IssueCalls,
  token: string,
  issue: {
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
  },
): Promise<
  | { readonly created: CreatedIssue }
  | { readonly sent: string }
  | { readonly refused: IssueCallFailure }
> => {
  const asked = await askGithub(
    calls.fetch,
    `${API}/repos/${CLOUDPID_REPO}/issues`,
    { method: "POST", body: JSON.stringify(issue) },
    token,
    REQUEST_TIMEOUT_MS,
  );

  if ("unreachable" in asked) return { sent: asked.unreachable };

  const { response } = asked;

  if (response.status === 201) {
    const decoded = Option.getOrUndefined(decodeCreated(await response.json().catch(() => null)));

    return decoded === undefined
      ? { sent: "GitHub's answer was not an issue" }
      : {
          created: {
            number: decoded.number,
            url: decoded.html_url,
            labels: (decoded.labels ?? []).map(({ name }) => name),
          },
        };
  }

  // A 5xx may come after GitHub made the issue, but GitHub says the request failed: it is told as a failure.
  return { refused: await failureOf(response, calls.now()) };
};

/** Add `labels` to issue `number`: the labels it has after, or a failure. */
export const addLabels = async (
  calls: IssueCalls,
  token: string,
  number: number,
  labels: ReadonlyArray<string>,
): Promise<{ readonly labels: ReadonlyArray<string> } | IssueCallFailure> => {
  const asked = await askGithub(
    calls.fetch,
    `${API}/repos/${CLOUDPID_REPO}/issues/${String(number)}/labels`,
    { method: "POST", body: JSON.stringify({ labels }) },
    token,
    REQUEST_TIMEOUT_MS,
  );

  if ("unreachable" in asked) {
    return { kind: "failed", message: `GitHub could not be reached: ${asked.unreachable}` };
  }

  if (!asked.response.ok) return failureOf(asked.response, calls.now());

  const decoded = Option.getOrUndefined(
    decodeLabels(await asked.response.json().catch(() => null)),
  );

  return { labels: (decoded ?? []).map(({ name }) => name) };
};
