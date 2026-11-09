// A Trigger's GitHub-managed hook at GitHub (`docs/architecture/triggers.md` → GitHub-managed hooks, ADR-0049): the
// repo webhook its object makes, updates and deletes as the GitHub App, with a token that asks only for
// `repository_hooks: write`, minted for the installation on the repo's owner (never the App owner's, as a read falls back
// to). What GitHub refuses is told as a `GitHubHookFailed` with a code the object and the owner act on: `permission` (the
// installation hasn't accepted Webhooks: write), `not_installed`, `refused` (GitHub's own words, its 20 hooks per event
// among them) and `unreachable` (tried again). Each call is a `trigger.github_hook` span with its op, outcome and HTTP
// status; the orphan sweep's choice of hooks (`orphanHooks`) is pure.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- GitHub is asked with `fetch`, a Promise API, over native arrays.
import type { GitHubPermissions } from "@cloudpid/config";
import { GitHubHookProblemCode } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GitHubApp, GitHubNotInstalled, GitHubRefused, type GitHubTokens } from "../github/app.ts";
import { askGithub, type GithubFetch, type GithubRequest, rateLimitOf } from "../github/request.ts";

/** The one permission a Trigger object's token asks for (ADR-0049). */
export const TRIGGER_HOOK_PERMISSIONS = {
  repository_hooks: "write",
} as const satisfies GitHubPermissions;

/** GitHub would not make, change, list or delete a hook: why (`code`), in words, and GitHub's status when it answered. */
export class GitHubHookFailed extends Schema.TaggedError<
  GitHubHookFailed,
  { readonly brand: unique symbol }
>()("GitHubHookFailed", {
  code: GitHubHookProblemCode,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

/** A hook on a repo, as the sweep reads it: its id and the URL it sends to (absent for a hook that has none). */
export type RepoHook = { readonly id: number; readonly url: string | undefined };

/** What a hook is set with: where it sends, its Signing secret, and the events it is sent. */
export type HookConfig = {
  readonly url: string;
  readonly secret: string;
  readonly events: ReadonlyArray<string>;
};

/** The hooks of a repo (`owner/name`) as the App reaches them. */
export type RepoHooks = {
  readonly list: (repo: string) => Effect.Effect<ReadonlyArray<RepoHook>, GitHubHookFailed>;
  /** Make a hook: its id at GitHub. */
  readonly create: (repo: string, config: HookConfig) => Effect.Effect<number, GitHubHookFailed>;
  /** Point hook `id` at `config`'s URL and secret, with its events: `gone` when GitHub no longer has it. */
  readonly update: (
    repo: string,
    id: number,
    config: HookConfig,
  ) => Effect.Effect<"updated" | "gone", GitHubHookFailed>;
  /** Delete hook `id`; one GitHub no longer has is deleted already. */
  readonly delete: (repo: string, id: number) => Effect.Effect<void, GitHubHookFailed>;
};

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

const API = "https://api.github.com";

const HookList = Schema.Array(
  Schema.Struct({
    id: Schema.Int,
    config: Schema.optionalKey(Schema.Struct({ url: Schema.optionalKey(Schema.String) })),
  }),
);

const MadeHook = Schema.Struct({ id: Schema.Int });

const GitHubError = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.String) })).pipe(
    Schema.optionalKey,
  ),
});

const decodeList = Schema.decodeUnknownOption(HookList);
const decodeMade = Schema.decodeUnknownOption(MadeHook);
const decodeError = Schema.decodeUnknownOption(GitHubError);

/** A repo's owner, from `owner/name`. */
const ownerOf = (repo: string): string => repo.split("/")[0] ?? repo;

/** What is told of an installation that hasn't accepted Webhooks: write: the two steps that give it. */
export const permissionMissing = (owner: string): string =>
  `The GitHub App's installation on ${owner} can't make webhooks: it hasn't accepted the Webhooks: write permission. ` +
  `Add the repository permission Webhooks (Read and write) in the GitHub App's settings, then accept it on the ` +
  `installation on ${owner} (Settings → GitHub Apps → Configure, on GitHub). The hook is tried again within the hour, ` +
  `or at once when the Trigger is paused and resumed.`;

/** GitHub's own words of a refusal: its message, and each error it lists (its 20 hooks per event, say). */
const githubWords = async (response: Response): Promise<string> => {
  const said = Option.getOrUndefined(decodeError(await response.json().catch(() => null)));

  const details = (said?.errors ?? []).flatMap(({ message }) =>
    message === undefined ? [] : [message],
  );

  return [said?.message ?? response.statusText, ...details]
    .filter((part) => part !== "")
    .join(": ");
};

const failed = (code: GitHubHookProblemCode, message: string, status?: number): GitHubHookFailed =>
  status === undefined
    ? GitHubHookFailed.make({ code, message })
    : GitHubHookFailed.make({ code, message, status });

/** What GitHub's refusal to `what` on `repo` is, by its status and words. */
const refusalOf = async (
  response: Response,
  repo: string,
  what: string,
): Promise<GitHubHookFailed> => {
  const words = await githubWords(response);
  const { status } = response;

  if (rateLimitOf(response) !== undefined || status >= 500) {
    return failed(
      "unreachable",
      `GitHub could not ${what} on ${repo} for now (${String(status)}: ${words})`,
      status,
    );
  }

  // A token without the permission (the installation never accepted it) is refused as no integration's.
  if (status === 403 && /not accessible by integration/iu.test(words)) {
    return failed("permission", permissionMissing(ownerOf(repo)), status);
  }

  return failed(
    "refused",
    `GitHub refused to ${what} on ${repo} (${String(status)}: ${words})`,
    status,
  );
};

/** Why no token could be had for `repo`'s owner. */
const tokenFailure = (repo: string, cause: unknown): GitHubHookFailed => {
  if (cause instanceof GitHubNotInstalled) {
    return failed("not_installed", `${cause.message}, so it can make ${repo}'s webhook`);
  }

  // A token asked with a permission the installation hasn't accepted is refused at the mint.
  if (cause instanceof GitHubRefused && cause.status === 422) {
    return failed("permission", permissionMissing(ownerOf(repo)), cause.status);
  }

  const message = cause instanceof Error ? cause.message : String(cause);

  return cause instanceof GitHubRefused && cause.status !== 401
    ? failed("refused", message, cause.status)
    : failed("unreachable", message);
};

/** A hook as GitHub takes it: JSON, signed with the secret, sent only `events`. */
const hookBody = (config: HookConfig): string =>
  JSON.stringify({
    name: "web",
    active: true,
    events: config.events,
    config: { url: config.url, content_type: "json", secret: config.secret, insecure_ssl: "0" },
  });

/**
 * A repo's hooks over GitHub's API, as the App `github` (its tokens minted with `TRIGGER_HOOK_PERMISSIONS`): every call
 * uses the installation on the repo's owner, and a 401 drops the token and asks once more with a new one.
 */
export const githubRepoHooks = (options: {
  readonly github: Pick<GitHubTokens, "token" | "invalidate">;
  readonly fetch: GithubFetch;
}): RepoHooks => {
  /** `path` of `repo`'s hooks asked as the App: GitHub's answer, or throws why it could not be asked. */
  const ask = async (repo: string, path: string, request: GithubRequest): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      let token: string;

      try {
        token = await options.github.token(ownerOf(repo));
      } catch (cause) {
        throw tokenFailure(repo, cause);
      }

      const asked = await askGithub(
        options.fetch,
        `${API}/repos/${repo}/hooks${path}`,
        request,
        token,
        REQUEST_TIMEOUT_MS,
      );

      if ("unreachable" in asked) {
        throw failed("unreachable", `GitHub could not be reached: ${asked.unreachable}`);
      }

      if (asked.response.status !== 401 || attempt > 1) return asked.response;

      options.github.invalidate(token);
    }
  };

  /** `run` as the `trigger.github_hook` span of `op`, its outcome and HTTP status on it. */
  const call = <A>(
    op: "list" | "create" | "update" | "delete",
    run: () => Promise<{ readonly value: A; readonly status: number }>,
  ): Effect.Effect<A, GitHubHookFailed> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        Schema.is(GitHubHookFailed)(cause)
          ? cause
          : failed("unreachable", cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.tap(({ status }) =>
        Effect.annotateCurrentSpan({ "trigger.outcome": "ok", "http.status": status }),
      ),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(
          error.status === undefined
            ? { "trigger.outcome": error.code }
            : { "trigger.outcome": error.code, "http.status": error.status },
        ),
      ),
      Effect.map(({ value }) => value),
      Effect.withSpan("trigger.github_hook", { attributes: { "trigger.github_hook.op": op } }),
    );

  return {
    list: (repo) =>
      call("list", async () => {
        const response = await ask(repo, "?per_page=100", { method: "GET" });

        if (!response.ok) throw await refusalOf(response, repo, "list the webhooks");

        const listed = decodeList(await response.json().catch(() => null));

        if (Option.isNone(listed)) {
          throw failed("unreachable", `GitHub's list of ${repo}'s webhooks did not read`);
        }

        return {
          status: response.status,
          value: listed.value.map(({ id, config }) => ({ id, url: config?.url })),
        };
      }),
    create: (repo, config) =>
      call("create", async () => {
        const response = await ask(repo, "", { method: "POST", body: hookBody(config) });

        if (!response.ok) throw await refusalOf(response, repo, "make the webhook");

        const made = decodeMade(await response.json().catch(() => null));

        if (Option.isNone(made)) {
          throw failed(
            "unreachable",
            `GitHub's answer to the webhook made on ${repo} did not read`,
          );
        }

        return { status: response.status, value: made.value.id };
      }),
    update: (repo, id, config) =>
      call("update", async () => {
        const response = await ask(repo, `/${String(id)}`, {
          method: "PATCH",
          body: hookBody(config),
        });

        if (response.status === 404) return { status: 404, value: "gone" as const };

        if (!response.ok) throw await refusalOf(response, repo, "update the webhook");

        return { status: response.status, value: "updated" as const };
      }),
    delete: (repo, id) =>
      call("delete", async () => {
        const response = await ask(repo, `/${String(id)}`, { method: "DELETE" });

        // A hook GitHub no longer has is deleted already.
        if (!response.ok && response.status !== 404) {
          throw await refusalOf(response, repo, "delete the webhook");
        }

        return { status: response.status, value: undefined };
      }),
  };
};

/** A Trigger object's GitHub: the App, and its repos' hooks. */
export type TriggerGitHub = { readonly app: GitHubApp; readonly hooks: RepoHooks };

/**
 * A Trigger object's GitHub: the App (`app`, whose bot login the bot-loop guard reads) with its tokens minted with
 * `TRIGGER_HOOK_PERMISSIONS` alone, and its repos' hooks over them.
 */
export const triggerGitHub = (options: {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch: GithubFetch;
  readonly now: () => number;
}): TriggerGitHub => {
  const app = new GitHubApp({ ...options, permissions: TRIGGER_HOOK_PERMISSIONS });

  return { app, hooks: githubRepoHooks({ github: app, fetch: options.fetch }) };
};

/** The Trigger id a hook's URL names under `origin`'s `/hooks/`, or undefined for a URL of another stage or service. */
const triggerOfHook = (origin: string, url: string | undefined): string | undefined => {
  const prefix = `${origin}/hooks/`;

  if (url === undefined || !url.startsWith(prefix)) return undefined;

  const [id = "", token, ...rest] = url.slice(prefix.length).split("/");

  return id !== "" && token !== undefined && rest.length === 0 ? id : undefined;
};

/** The Trigger ids `hooks` send to under `origin`'s `/hooks/`, for the Registry's `knownTriggers`. */
export const hookTriggers = (
  hooks: ReadonlyArray<RepoHook>,
  origin: string,
): ReadonlyArray<string> =>
  hooks.flatMap((hook) => {
    const trigger = triggerOfHook(origin, hook.url);

    return trigger === undefined ? [] : [trigger];
  });

/**
 * The hooks the orphan sweep deletes before Trigger `own` makes its hook: those that send to this stage's
 * `<origin>/hooks/<id>/` for an id that is `own` (one it made before and lost: it has none now) or not among `known`.
 * Hooks of other stages and other services are never touched.
 */
export const orphanHooks = (
  hooks: ReadonlyArray<RepoHook>,
  options: { readonly origin: string; readonly own: string; readonly known: ReadonlySet<string> },
): ReadonlyArray<RepoHook> =>
  hooks.filter((hook) => {
    const trigger = triggerOfHook(options.origin, hook.url);

    return trigger !== undefined && (trigger === options.own || !options.known.has(trigger));
  });
