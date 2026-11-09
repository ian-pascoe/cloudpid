---
status: accepted
---

# An Approval asked through the MCP endpoint is kept by the Registry and applied by the owner's Approve

The MCP endpoint serves the Environment and Settings tools a Session's agent has (#684). An Agent change that waits for Approval in a Session waits for it over the endpoint too: the caller is authenticated as the owner but is a model (ADR-0041).

There is no Session to hold such a request, so the Registry keeps it, holding:

- the tool, its decoded arguments, the card and `expected`;
- the caller's `via`;
- an expiry of 7 days.

The tool answers at once, `pending` with an `approval_id`, and sends the owner an `input` Notification. The caller can only follow the request (`approval_wait`) or withdraw it (`approval_withdraw`). The owner answers on the same card as in a Session, shown on the Scope's Settings page.

The owner's Approve applies the change. The main Worker runs the tool's own `apply` against the values the card showed, so an approved change never depends on the caller coming back. The decision is recorded before `apply` runs, and an `apply` cut off part-way resumes from the card's _Try again_, the caller's next `approval_wait` (except a long apply, such as deleting an Environment), or the owner's next visit to the web app. There is no Registry alarm, because the Registry can't reach the Workspaces and Sessions a delete removes.

This amends ADR-0019, under which an Approval is always a card in a Session. Session-held Approvals don't change. The two kinds share the request shape, the card, and one `prepare`/`apply` per tool. The design is in [`docs/architecture/mcp-endpoint.md`](../architecture/mcp-endpoint.md#approvals-with-no-session).

## Considered options

- **Holding the call open until the owner answers**: a call can wait at most 300 s, so it would still end in a handle, which makes two mechanisms.
- **Refusing Approval-gated tools over the endpoint**: this leaves Limits, Instructions, MCP server definitions and deletes to the web app, which defeats the endpoint managing what the agent manages.
- **The caller's next call applies the approved change**: an approved change would then sit unapplied whenever the caller never returns.
- **Moving Session-held Approvals to the Registry too, for one mechanism**: in a Session an Approval belongs to its call. Stop withdraws it, a rerun after eviction waits for the same request, and its card is in the transcript. Moving it adds a path from the Registry back to the Session, with nothing the owner would notice.

## Consequences

- The Registry gains a table of Approval requests (expiry, a cap per identity, dedupe), and the approve/decline route applies a change on the main Worker, so it carries each tool's `apply` and the after-steps a Session carries today.
- Resuming a cut-off apply has no timer: it depends on _Try again_, the caller's `approval_wait` or the owner's next visit. An Approval nobody returns to, such as a long delete, can sit approved and unfinished until one of those.
- Every edge between the Workers only gains (an optional `describe().harness`, new operations, new columns and tables), so a deploy that is half done shows fewer tools and never a broken one; the Registry's feature probe makes the tools refuse, rather than skip a Secret check, while it is on older code.
- Approvals asked through the endpoint use the owner's Notifications and the Scope's Settings page, so those carry a request that has no Session.

## Amendment: when a cut apply resumes (#685 L4, #688)

The owner's next visit is the web app's poll, not a page of its own: the main Worker resumes every approved request no run is applying (`resumeStale`) in `background`, behind `listSessions`, which every page polls, and behind `listApprovals`, which the Settings page polls. With _Try again_ (the owner's `retryApproval`, inline like Approve) and the caller's `approval_wait` (which never runs a long apply), these are the only triggers: there is still no Registry alarm, because the Registry has none and cannot run `removals`. Each run claims the request under a 60 s lease, so a resume and a Try again never apply it twice at once, and every step is safe to repeat, since the request's `change_requests` claim (`approval:<id>`, whose attempt is the request's own id) is read first: an answer kept finishes it, changes recorded with no answer finish it with an answer built from them, and only no claim at all runs `apply`.
