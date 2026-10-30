---
status: accepted
---

# A Resource watch belongs to a conversation, is held only while it runs, is checked by re-reading after every gap, and never starts a Run

An agent watches an MCP resource by reading it with `read_mcp_resource { watch: true }`; the watch belongs to that conversation, and the Environment's MCP host object holds the server side: one `resources/subscribe` (`2025-11-25`) or one `subscriptions/listen` (`2026-07-28`) per server, shared by every watch on it, and replaced by opening the new listen before closing the old, since a listen's filter cannot change in place. The host never calls a Session: each request start of a conversation asks it what changed, together with the MCP inventory's version, and the answer reaches the model as one `Resource watches` notice (a `write` submission) that names URIs, never their contents, and never starts a Run. The host holds a server's stream only while a watching conversation has made a request in the last 15 minutes, so watches keep it in memory no longer than a Run and 15 minutes after. Any span without the stream (between Runs, a deploy, an eviction, a new HTTP session) is a gap, after which the host re-reads each watched resource the agent's last read still describes and reports it changed when its SHA-256 differs. A watch on a stdio server ends with the server process, which it never keeps running, and a server that cannot push (a `2025-11-25` server refusing the GET stream) is not watched.

## Considered options

- **The host calling Sessions with updates**: wakes idle Sessions and needs delivery that survives eviction, while the model sees a notice only at a request anyway.
- **Streams held around the clock, reopened by alarms**: a pending outbound fetch keeps a Durable Object in memory and is billed as duration, and a deploy or runtime update still cuts the stream, so the gap check is needed either way.
- **A "may have changed" notice after every gap**: a notice every time work resumes, true or not.
- **Polling every watched resource at each request**: one read per watch per round.
- **The owner pinning resources in the UI**: more surface for what asking the agent to watch already does.
- **Resuming a stdio watch on the server's next spawn**: a spawn happens only when something calls that server, so a lapsed watch would look alive indefinitely.

## Consequences

- An update that only touched a sub-resource during a gap is missed; the hash covers the watched resource's own content.
- What a gap check finds reaches the model one request late, so the request that started the check never waits for it.
- A resource whose content differs on every read is reported changed after every gap.
- Watches end after 7 days without a request in their conversation, checked at its next request; nothing expires them by alarm.
- Starting a Run on a resource change is left to later trigger work, and only adds to this.
