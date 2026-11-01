---
status: accepted
---

# An MCP server's Elicitation request is answered only by the owner, its answer is never kept, and a form that asks for a credential is declined unseen

An MCP server may ask the owner something during a call (`elicitation/create`): a form to fill in, or a page to open. cloudpid declares elicitation, in both modes, on every request made in a conversation (the agent's calls, a prompt send, an App View's calls) and nowhere else, with no per-server switch, since a server that finds no elicitation may take that as consent. Only the owner answers, on a card cloudpid draws from the server's schema after checking it against the spec's subset; the agent has no tool or script method to answer, list or decline one. The answer goes only to the server. cloudpid keeps what was asked and how it ended, never a value: a Legacy answer passes straight to the waiting call, and a Modern one is sealed until the request is sent again, then deleted. A form with a free-text field whose name or title ends in a credential word (password, token, secret, API key) is declined without being shown, and so is a page that is not on HTTPS, is on a private or local host, or is on cloudpid's own; the call's card says so. Every value submitted is checked against the Session's Secrets before it leaves.

## Considered options

- **The agent answering when the owner is away**: most real elicitations are confirmation gates before a destructive or secret-revealing action, there to stop the agent; a server could also talk the agent into filling one. On a Modern server, waiting for the owner costs only time.
- **A per-server `elicitation` key**: there is no "allow" to grant, since only a person can answer, and an `off` would turn the servers' confirmation gates into consent (MongoDB's and Relativity's servers run the action when a client lacks elicitation).
- **Only warning on credential-shaped fields**: a tired owner clicks through the warning, which is the threat. The spec forbids servers to ask for credentials in a form, and cloudpid already has the channel for them: a Secret in the MCP server definition, or the server's own page in URL mode.
- **Keeping answers, redacted or sealed**: nothing needs them once the server has them, and redaction knows the owner's Secrets, not their address.
- **Declaring only in the root conversation**: a subagent's destructive calls would be auto-approved by the servers above.
- **A generic JSON-Schema form renderer**: it renders far beyond the spec's flat subset; one normalizer gives the subset check, the bounds and the credential check a single home and keeps the server's schema out of the web app.
- **Letting `http:` and local pages through**: URL mode exists for credentials and payments, the owner's browser can't reach a server's `localhost`, and a link to cloudpid's own host would pass its same-origin checks.

## Consequences

- A Modern question can wait for hours, in a `codemode` script as in a direct call. A Legacy question has 10 minutes.
- A `2025-11-25` `-32042` (URL elicitation required) has ended its call, so it waits durably, and the call is sent again only after the owner's Done, at most 10 times. It is the one case where a `tools/call` is sent again: the server refused it before running.
- A server that needs a credential must use URL mode or its MCP server definition.
- The owner can't see later what they entered.
