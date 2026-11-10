---
status: accepted
---

# A GitHub trigger may take its own bot's deliveries once approved, and a webhook trigger pauses itself past its Fire rate

Every change an agent makes on GitHub (a label, an issue, a pull request, a review, a push, a merge) reaches GitHub as the App's one bot, `<slug>[bot]`: Containers use the installation's token, with no identity per Session ([ADR-0025](0025-github-access-through-a-github-app.md)). [#679](https://github.com/ian-pascoe/cloudpid/issues/679)'s bot-loop guard dropped every such delivery and had no switch, so no agent's work on GitHub could fire a Trigger, and the owner could not compose Triggers into an agent pipeline of their own design ([#724](https://github.com/ian-pascoe/cloudpid/issues/724)).

So a `github` Trigger may take Own-bot deliveries (`ownBot: "take"` on its webhook source). Taking them widens what the Trigger takes and waits for the owner's Approval; dropping them again, like any change to `match` that only narrows, applies at once. The default stays `drop`, and an own-bot delivery a Trigger drops is counted `bot_own`, not `filtered`, so the owner can see why a Trigger never fired. A webhook Trigger also has a Fire rate (30 Fires in an hour unless set otherwise, or off): one more pauses it and pushes a Notification. Schedules have none: they can't loop, and their Fires were on their Approval card.

cloudpid holds no opinion on how a pipeline is built. What a work item is, how stages hand work to one another (a Session can reach another through Self-use), how many rounds one item may take and where a person must act are the owner's, in their Trigger messages, `match`es, Instructions and skills. cloudpid can't tell which Session made a change on GitHub, so a gate it can enforce is only a person's own act there, matched by their `sender.login` on a Trigger that drops own-bot deliveries.

This amends [ADR-0047](0047-triggers-fire-from-a-durable-object-of-their-own-the-registry-keeps-their-definitions-and-making-or-widening-one-waits-for-approval.md): a change to `match` waits for Approval only when it widens, and its "no cap of cloudpid's own" now holds for Schedules only, since the Trigger fire limit it rejected for want of a constraint now has one, loops.

## Considered options

- **Causal markers** (a chain id and hop count stamped in a hidden comment, a trailer or a branch name): every skill and every `gh` call would have to stamp them; labels, merges, reviews and pushes carry no text to stamp; and anyone writing a comment or a pull request body can forge or strip them.
- **Telling agents apart by identity:** an App has one bot. User-to-server tokens would make agents act as the owner, a person no guard can tell apart.
- **Bounds and routing per work item in the harness** (a Subject read from each GitHub event, a count of bots' Fires per Subject, Fires sent to the Session working it, claims): each encodes one pipeline's shape (what a Subject is, when a link ends, who resets a count); they are the owner's to build.
- **Sender rules in `match` alone, with a default row excluding the own bot:** `match` has no negation, every Trigger would need the bot's login at creation, and the drops would be counted `filtered`.
- **No Fire rate:** each Session a loop starts gets its own Spend limit, which is off by default, and Containers are counted by none, so a loop through a Trigger that starts a Session per delivery would run until the owner noticed.

## Consequences

- A Trigger that takes own-bot deliveries for comment events hears its own Sessions' comments; its `match` or Trigger message must allow for it.
- `admitFire` counts each Trigger's admitted Fires for its Fire rate.
- A loop through a sender that looks like a person (the owner's PAT kept as a Secret) is bounded only by the Fire rate, as it was before by nothing.
