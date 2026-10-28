// The GitHub client the Registry fetches Skills with (ADR-0026, `docs/architecture/workspace.md` → _Installing from GitHub_): the GitHub App's
// tokens, read-only (contents), for the installation on the repo's owner, else the app owner's, which reads any public
// repo. The Registry DO is in the main Worker, which holds the app's key (ADR-0025); a Session DO or a Container never
// gets a token, it asks the Registry to install. The Worker itself builds the same reader (once, so one token) for the repo
// page's listing (`skill-repo.ts`), since a Durable Object has no Cache API to keep what it reads of each SKILL.md in.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
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
