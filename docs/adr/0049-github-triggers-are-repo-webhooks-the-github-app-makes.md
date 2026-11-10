---
status: accepted (what the Container tokens' list protects, while the App's key is reachable from a branch: amended by docs/development/infra.md → CI credentials)
---

# GitHub triggers are repo webhooks the GitHub App makes

The agent should be able to set up "when CI fails on `main`, fix it" with nothing for the owner to paste. ADR-0025 left the GitHub App's webhook off until Triggers needed it. They now use repo webhooks instead: for a Trigger whose source is a GitHub repo, the Trigger's object creates a webhook on that repo as the GitHub App, subscribed only to the Trigger's events, sending to the stage's own Trigger URL in the `github` format with the Trigger's Signing secret ([ADR-0048](0048-trigger-urls-sit-outside-access-behind-a-secret-token-and-a-required-signature.md)). It updates the hook when either value is replaced, and deletes it when the Trigger goes. Before it creates one in a repo, it deletes that repo's hooks that point at this stage's `/hooks/` path for a Trigger the Registry doesn't know.

The App gains the repository permission **Webhooks: write** (`repository_hooks`), which the owner adds in the App's settings and accepts once on each installation. The Trigger object's token asks for that permission alone. Container tokens are minted with an explicit list of permissions that leaves it out, so a prompt-injected `gh api` can't add a hook that sends a repo's events anywhere; that change deploys before the owner accepts the permission. The App's own webhook stays off.

## Considered options

- **Fanning out the App's one webhook:** it has one URL and one secret for the whole App, which breaks a secret per Trigger; it can point at one stage only (`prod`); every event of every installed repo would reach the Worker; and its event list is changed in the App's settings.
- **Only the owner pasting a Trigger URL into GitHub:** still possible with any Trigger in the `github` format, but the agent couldn't wire one up alone.
- **Organization hooks:** they need `organization_hooks` and an organization owner; later.
- **An App per stage,** which ADR-0025 suggested for previews: per-repo hooks give each stage its own without one.

## Consequences

- Each stage makes its own hooks, so previews and dev stages receive GitHub events, which ADR-0025 said the App's webhook could not give them. A destroyed preview's hooks fail harmlessly at GitHub until a later hook in the same repo sweeps them.
- GitHub filters events per hook, so noise is cut at the source.
- GitHub allows at most 20 hooks per event per repo; cloudpid shows GitHub's refusal plainly and sets no cap of its own.
- An installation that hasn't accepted the permission gets a plain message naming the step, not a failed Trigger with no reason.
- Any permission added to the App later reaches Containers only when it is added to their list, deliberately.
- The list holds only while the App's key stays out of the agent's reach. The `preview` environment holds the key, and a Container token can push a branch whose workflow runs there, so every job in `preview` waits for the owner's review, GitHub's deployment review ([CI credentials](../development/infra.md#ci-credentials)). A job the owner lets run runs with the key, and through it every App permission, `repository_hooks` included.
- A failed hook delete is retried, with backoff, for up to a day, then logged as a warning.
