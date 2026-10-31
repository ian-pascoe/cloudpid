---
status: accepted
---

# A Modern MCP server's question is answered with a new request, possibly much later; a Legacy server's lives only as long as its call

An MCP server's question to cloudpid (an elicitation, a sampling request, or roots) comes in two shapes, and the MCP core handles each as its protocol era allows. A **Modern** server's question ends its request (`input_required`). The core answers roots itself, offers the rest to the host, and runs the retry itself when the host answers at once: a new id, `requestState` echoed byte for byte, at most 10 rounds, and nothing cached from a retried result. When the host defers, the core returns a resumable state of at most 1 MiB, which the host keeps in its durable request. Later, the host calls `resume` with the answers. The core holds nothing between the question and the resume. A **Legacy** server's question arrives live, inside its call. The core ties it to that call by watching the call's response stream. It is answered only while that stream is open, so "defer" becomes a cancel. If the call ends, or the host object is evicted, the question expires and a late answer is refused.

The SDK's default, which Cloudflare's `agents` also uses, answers every question inside a pending in-memory call. An eviction or a deploy would then lose the owner's question, and durable elicitation and sampling would be impossible.

## Considered options

- **The SDK's auto-fulfil**: simpler, but the call waits in memory for as long as the owner takes.
- **Holding a Legacy call open durably**: the spec gives no way to answer a Legacy question after its request's stream is gone.

## Consequences

- Only a Modern server's question can wait hours for the owner. A Legacy one has to be answered while its call waits, bounded by a wait the elicitation and sampling designs set.
- Questions that arrive outside any call (on a Legacy server's GET stream) or from a call with no conversation get roots, a cancel, or a refusal, never a question to the owner.
- Elicitation, sampling and MCP tasks build on this one shape. A task's `input_required` status uses the same question shape.
