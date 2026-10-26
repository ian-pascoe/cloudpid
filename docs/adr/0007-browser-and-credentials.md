# One shared Browser Run session; credentials are filled host-side

The agent browses with Cloudflare's `agents/browser` (`Browser`, `browserRun`, `browserTool`) on Browser Run. That gives the model arbitrary CDP code, rather than tools we would build and maintain. Each Session DO has one shared Browser Run session, with a tab per conversation. Separate guardrailed sessions per credential were rejected as overkill for a single user. Because the model's CDP access could read anything typed into a page, credentials never pass through the model. In v2, `fill_credential` resolves a 1Password item on the host, checks the page origin against the item's URLs, types the values over CDP, and returns only a status. The first use of each item asks the user. `browser_handoff` gives the user a Live View for steps the agent cannot do, and the URL is never shown to the model.

Beside the conversations' tabs, the shared browser holds the owner's **Owner tabs**, which the owner opens and uses in the Browser Pane (ADR-0013's amendment): each is an `agents/browser` scope of its own (`owner-tab:<id>`), apart from the conversations' tabs but sharing their cookies and logins, and the browser host keeps their list and the one the Pane shows. Opening the Pane starts the browser when none runs (a use of the browser, so the Session's idle close covers it); an Owner tab lasts as long as the browser it is in, or until it is closed.

The browser is hosted by a Durable Object of its own, one per Session, in a plain `Browsers` Worker rather than in the Session DO: `agents/browser`'s tool needs the hosting Worker to export a facet class (`CodemodeRuntime`), which the Server Worker, an alchemy Effect Worker, cannot do. The Session DO's `browser` tool calls it over RPC.

## Consequences

- Logins last only as long as the Browser Run session, and the agent signs in again when one expires.
- A page that injects prompts could still steer the model's CDP code to read cookies in the shared session. Origin checks and per-item approval limit what a fill exposes, but not what a session holds.
