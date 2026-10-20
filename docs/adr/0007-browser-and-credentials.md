# One shared Browser Run session; credentials are filled host-side

The agent browses with Cloudflare's `agents/browser` (`Browser`, `browserRun`, `browserTool`) on Browser Run. That gives the model arbitrary CDP code, rather than tools we would build and maintain. Each Session DO has one shared Browser Run session, with a tab per conversation. Separate guardrailed sessions per credential were rejected as overkill for a single user. Because the model's CDP access could read anything typed into a page, credentials never pass through the model. In v2, `fill_credential` resolves a 1Password item on the host, checks the page origin against the item's URLs, types the values over CDP, and returns only a status. The first use of each item asks the user. `browser_handoff` gives the user a Live View for steps the agent cannot do, and the URL is never shown to the model.

## Consequences

- Logins last only as long as the Browser Run session, and the agent signs in again when one expires.
- A page that injects prompts could still steer the model's CDP code to read cookies in the shared session. Origin checks and per-item approval limit what a fill exposes, but not what a session holds.
