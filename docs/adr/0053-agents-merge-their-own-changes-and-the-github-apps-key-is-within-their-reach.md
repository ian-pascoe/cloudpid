---
status: accepted
---

# Agents merge their own changes, and the GitHub App's key is within their reach

cloudpid is the owner's software factory: an agent opens a pull request, waits for `Check`, and merges it, and the deploy that follows goes out without anyone reading the change. The owner owns the GitHub App, the repos it is installed on, and the Cloudflare account.

That leaves the App's key within an agent's reach. Container tokens have `contents`, `pull_requests` and `workflows` write on every repo of the installation, this one included ([ADR-0025](0025-github-access-through-a-github-app.md)). A branch's workflow can run with the `preview` environment's secrets, since any branch may use it, and a merge to `main` deploys with `production`'s. Both hold the App's private key and a Cloudflare token that writes every Worker on the account (`docs/development/infra.md` → CI credentials). So an agent steered by injected content could reach the key, and with it every App permission on every installation, `repository_hooks` included, which [ADR-0049](0049-github-triggers-are-repo-webhooks-the-github-app-makes.md) keeps out of Container tokens. It could also change what `prod` runs.

The owner accepts this. Neither `main` nor `preview` waits for a person: the `main` ruleset requires a pull request and `Check`, with no pull request review, and `preview` has no required reviewer.

## Considered options

- **A required reviewer on `preview`** (#746, reverted before `ci:setup` applied it): it closes the branch-workflow path to the key only while `main` waits for a review too, since `production` holds the same key. With agents merging to `main`, it adds a click to every preview deploy and destroy and closes nothing.
- **A required pull request review on `main` for the App's pull requests:** it stops agents merging their own changes, which is what the factory is for.
- **A GitHub App of its own for previews,** with only what a preview needs: it keeps the main App's key out of `preview`, but `production` still holds it, and a merge reaches it.

## Consequences

- The Container tokens' explicit list of permissions (ADR-0049) still stops a prompt-injected `gh api` adding a hook directly. It does not stop an agent whose workflow runs in `preview`, or whose merge deploys `prod`.
- An audit should not report these paths as findings. Reopen this when the factory runs code the owner does not trust, or when someone else gets access to the App, the repos or the account.
