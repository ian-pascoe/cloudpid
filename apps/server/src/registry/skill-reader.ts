// The GitHub client the Registry fetches Skills with (ADR-0026, `docs/spec.md` → _Installing from GitHub_): the GitHub App's
// tokens, read-only (contents), for the installation on the repo's owner, else the app owner's, which reads any public
// repo. The Registry DO is in the main Worker, which holds the app's key (ADR-0025); a Session DO or a Container never
// gets a token, it asks the Registry to install.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off
import * as Redacted from "effect/Redacted";
import { GitHubApp } from "../github/app.ts";
import type { GitHubAppSecrets } from "../github/config.ts";
import { githubContents, SKILL_FETCH_PERMISSIONS } from "../github/contents.ts";
import type { RepoReader } from "../github/skill-fetch.ts";

/** A `RepoReader` over GitHub as the GitHub App `secrets`, made once per object so its token is shared. */
export const githubSkillReader = (secrets: GitHubAppSecrets): RepoReader =>
  githubContents({
    fetch: (url, init) => fetch(url, init),
    github: new GitHubApp({
      appId: Redacted.value(secrets.appId),
      privateKey: Redacted.value(secrets.privateKey),
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      permissions: SKILL_FETCH_PERMISSIONS,
    }),
  });
