---
status: accepted
---

# Triggers fire from a Durable Object of their own, the Registry keeps their definitions, and making or widening one waits for Approval

A Trigger ([#191](https://github.com/ian-pascoe/cloudpid/issues/191)) needs something that wakes on time, takes deliveries, and then calls out: to the Registry to start a Session, to a Session to send it a message, and to GitHub for its hook. The Registry never calls other objects (its callers, such as the main Worker for `session_start`, make those calls themselves), and it is the singleton every Session and the owner's UI wait on.

So each Trigger has a Durable Object of its own, `Trigger`, keyed `trigger:<id>`, in the `Server` Worker beside the Registry, the Sessions and `McpHost`. The truth is split by what it is about:

- **The Registry** keeps _what_ a Trigger is and _whether_ it may fire: its definition at a revision number, and its Agent changes. Its `admitFire` checks, in one transaction, that the Trigger is active, that the caller's revision is current (else it answers `stale` with the current definition), and the overlap; for an Environment or Workspace trigger it registers the Fire's Session (`createSession`) in the same transaction.
- **The Trigger object** keeps _how_ it is reached and _when_ it fires: its Trigger URL's token and its Signing secret (sealed with the vault, bound to its own id), its alarm, its GitHub hook, its pending Fires and its fire log. It plays the main Worker's part in `session_start`: `admitFire` first, then the Session's `fire`.

A Schedule coming due and an accepted delivery both become a pending Fire in the object's storage, which its alarm drains. A Fire's key (`<trigger>:<scheduled time>`, or the delivery's id) is its `requestId`, which the Registry and the Session already remember for 24 hours, so an alarm retried after a crash never starts a second Session. At each alarm the object reads its definition again and wipes itself or re-arms, so a lost message from a caller heals at its next touch. A Fire reaches a Session through a new method, `fire`, never a field on `submit`: a Session still on old code would drop an unknown field and take a payload as the owner's own words.

The agent manages Triggers through tools, as ADR-0019 said it would. Each change is an Agent change, recorded and revertible. **Making a Trigger, changing what it sends, when, or where (its Trigger message, Schedule, `match`, or its options `when_busy`, `base`, `model` and `thinking`), and resuming one wait for the owner's Approval; pausing and removing apply at once.** The owner's own edits never wait. A Trigger's kind and owner (its Environment, Workspace or Session) are fixed at creation; moving one is removing it and making another. A Trigger message is an owner-trusted prompt sent unasked, again and again, and starts paid work; it can fire before the Run's Notification is read, which is when ADR-0019 keeps Approval ("where after the fact is too late").

There is no cap of cloudpid's own on how much Triggers do: no daily fire limit, no cap on the Sessions they run at once, no minimum interval beyond cron's minute, no count per Session or Environment. The owner's Approval of each Trigger, the overlap rules, coalescing and the Spend limit (when the owner turns it on) bound it. Cloudflare's account limits on Containers (6 TiB of memory, 1,500 vCPU at once) are far above one owner's use.

## Considered options

- **The Registry's one alarm, multiplexed over every Schedule:** the Registry would have to call Sessions, and every Fire would run on the hottest object.
- **A Workers Cron Trigger every minute:** it wakes the Registry 1,440 times a day for nothing, is fixed at deploy, runs in UTC only, and every preview stage would get it too.
- **An object per Environment, as `McpHost` is:** multiplexing code, and Triggers coupled to one another for no gain.
- **The secrets sealed in the Registry, looked up per delivery:** every delivery, junk included, would reach the singleton, and a copy of a secret in two places can go stale after a rotation.
- **Recording only, with no Approval:** less friction, and defensible for Schedules whose first Fire is days away, but a GitHub trigger can fire within seconds.
- **A Trigger fire limit (a new Limit), a running cap and a minimum interval:** cautions with no constraint behind them; the owner rejected them.

## Consequences

- `Trigger` is the first object that does scheduled work, and its class name can't be renamed once deployed. Moving Trigger state to another object later would be costly.
- Each object wakes only when one of its Fires is due, so idle Triggers cost nothing. Alarms survive deploys and are at-least-once; their lateness is undocumented, so a Fire is not promised to the second.
- Every edge to and from the object is new and only gains: main Worker → Trigger, Session → Trigger, Trigger → Registry and Trigger → Session.
- Each Environment or Workspace trigger's Fire leaves a Session, and an Environment trigger's a Workspace too; tidying them is [#675](https://github.com/ian-pascoe/cloudpid/issues/675) and [#676](https://github.com/ian-pascoe/cloudpid/issues/676).
- `docs/architecture/triggers.md` has the detail.
