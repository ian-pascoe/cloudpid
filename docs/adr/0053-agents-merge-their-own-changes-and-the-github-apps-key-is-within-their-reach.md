---
status: accepted
---

# Agents merge their own changes, and the GitHub App's key is within their reach

cloudpid is the owner's software factory: an agent opens a pull request, waits for `Check` and merges it, and the deploy that follows goes out without anyone reading the change. The owner owns the GitHub App, the repos it is installed on, and the Cloudflare account.

That leaves the App's key within an agent's reach. Container tokens have `contents`, `pull_requests` and `workflows` write on every repo of the installation, this one included ([ADR-0025](0025-github-access-through-a-github-app.md)). A merge to `main` deploys with the `production` environment's secrets, which hold the App's private key and a Cloudflare token that writes every Worker on the account (`docs/development/infra.md` → CI credentials). So an agent steered by injected content could reach the key, and with it every App permission on every installation, `repository_hooks` included, which [ADR-0049](0049-github-triggers-are-repo-webhooks-the-github-app-makes.md) keeps out of Container tokens. It could also change what `prod` runs.

The owner accepts this. `main` does not wait for a person when the agent merges: its ruleset requires a pull request, `Check` and one approving review (of the latest push), but the `cloudpid` App may bypass the ruleset, its review and `Check` included, when it merges a pull request (as may repo maintainers; admins may at any time).

Previews and dev stages use a GitHub App of their own, `cloudpid-dev`, installed only on the repos they work on. Any branch may use the `preview` environment, so a branch's workflow can run with its secrets, and no review guards it either; but those hold only `cloudpid-dev`'s key, which reaches only those repos.

## Considered options

- **A required reviewer on `preview`** (#746, reverted before `ci:setup` applied it): with agents merging to `main`, `production` holds the main key anyway, so it adds a click to every preview deploy and destroy and closes nothing. A bypass for the agent's App would gate the owner's own pull requests and exempt the agent's, which are the ones it is for; GitHub offers none for an environment's reviewers anyway.
- **A required pull request review on `main` that the App cannot bypass:** it stops agents merging their own changes, which is what the factory is for.
- **One App for every stage** (ADR-0025 before this): the branch-workflow path then reaches the main key too, with no merge needed. `cloudpid-dev` closes that path at the cost of a second App to set up and install.

## Consequences

- The Container tokens' explicit list of permissions (ADR-0049) still stops a prompt-injected `gh api` adding a hook directly. It does not stop an agent whose merge deploys `prod`, or whose workflow runs in `preview` with `cloudpid-dev`'s key on the repos that App is installed on.
- `cloudpid-dev` is made with `bun run --cwd infra github-app:setup --name cloudpid-dev --environment preview`, which writes its key into `preview` and `~/.config/cloudpid/dev.env` and never into `production`. Installed on more repos, it reaches more.
- A preview or dev stage reaches only the repos `cloudpid-dev` is installed on: its tokens reach no other private repo, and on an account it is not installed on a stage gets the token of the App's own account's installation, which reads public repos only.
- An audit should not report these paths as findings. Reopen this when the factory runs code the owner does not trust, or when someone else gets access to the Apps, the repos or the account.
