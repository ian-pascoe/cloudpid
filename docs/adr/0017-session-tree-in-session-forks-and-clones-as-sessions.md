---
status: accepted
---

# The Session tree stays in its Session; Forks and Clones are new Sessions

We follow local pi's three ways to try another approach. `/tree` moves between Session branches inside one Session; `/fork` and `/clone` make a new Session. pi-durable has no entry tree inside a conversation: its transcripts are append-only, and its only branching primitive is `fork(at)`, which makes a new conversation in the same pi-durable Session (one Session DO, ADR-0001). So each Session branch is a pi-durable fork of the root conversation inside the Session DO, and the Session keeps which one is the active branch. Every place that assumes the root conversation (`ROOT_CONVERSATION_ID`) must therefore follow the active branch instead. A Fork or Clone lives in another Session DO, which pi-durable's fork cannot reach, so it is seeded by copying from the source Session.

## Considered Options

- **Every alternative is a new Session, and `/tree` navigates the Sessions' lineage.** One mechanism, and the root conversation stays fixed. Rejected because related alternatives would scatter across the Session list, unlike pi, where `/tree` keeps them in one session.
- **Every alternative is a branch inside the Session.** pi-durable's native, atomic fork for all three. Rejected because `/fork` and `/clone` would lose their meaning of separate work.
- **A new Session record pointing at the same Session DO and another conversation.** Native fork with a Session-list entry of its own. Rejected: it breaks one Session per DO, deleting the source would take its Forks along, and Session-wide state (Usage, the Spend limit, held Secrets) would be shared.
- **Rewinding the root conversation in place with a head marker into the past.** pi-durable rejects such a write as stale, and mounted views go out of date (its spec's _API footguns_).
