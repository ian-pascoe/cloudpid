---
status: accepted
---

# The Session socket streams pi's conversation view and its operations, not agent events

pi-durable 1.5 replaced its event watch (`watchEvents`: a snapshot, then `AgentEvent` batches) with a conversation view (`Conversation.watch`): a window over the transcript and the conversation's documents (`pi.live`, `pi.inbox`, `pi.agent`), then chord's operations that change it. Cloudflare's `agents` pi example, whose message shapes the socket carries ([ADR-0009](0009-session-socket-messages-over-alchemy-rpc.md)), moved the same way (edf1b527, 9e88bbf5). So `watch` now answers with a `view` message and then `ops` messages, as pi sends them but for their bounded screenshots; a watch may start `from` the entry after the client's newest, so a reconnect gets only what it missed. The client applies the operations to its copy and merges each view into pi-durable's `ConversationTranscript`, which keeps every entry it has seen beyond the window; earlier entries, and the entries a reconnect skipped (a gap), load with `entries`, pi's `Page` of the History in a range, in place of `history`. The client fills a gap itself at once, a page at a time, rather than show it. A UI's view is a pure projection of the transcript and the documents (`projectView`), the only code that reads pi's view.

## Considered options

- **Keep `events`, re-deriving them on the Session from the view's operations**, as pi 1.4's `watchEvents` did from its commits: the web reducer and every client test stay as they are, but the Session owns a translation pi no longer has, which must follow each change to pi's documents, and the `history` paging stays ours too.
- **Gap rows, as the example shows them**: the owner would click to load what a reconnect missed, a choice nobody wants to make; the client loads it instead.
- **Sending the merged transcript from the Session**: the Session would hold one per socket, and the window would no longer bound a message.

## Consequences

- A Session of this build and a client of an earlier one do not understand each other's watch. The Session and the web app deploy together, so no compatibility is kept for `events` or `history`: a tab left open across that deploy shows its conversation again once it is reloaded.
- Only App tools' calls keep their streamed arguments in the live message: the projection shows every other call with none until its message is committed. The operations still carry them.
- A woken Session restarts each watch with a new view of the default window, which the client merges into what it holds (a gap, filled, when it missed more).
- `ConversationMirror` lives at `@cloudpid/protocol/mirror`, apart from the package's index, so the Session's code that imports the index does not take pi-durable's transcript with it.
