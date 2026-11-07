# Triggers

Settled in [#191](https://github.com/ian-pascoe/cloudpid/issues/191); not built yet. Each section says which slice builds it ([_Slices_](#slices)).

A **Trigger** sends a message on its own when something happens: its Schedule comes due, or its Trigger URL gets a delivery. The owner sets one up, or the agent does for the owner. Triggers fire from a Durable Object of their own, the Registry keeps their definitions, and making or widening one waits for Approval ([ADR-0047](../adr/0047-triggers-fire-from-a-durable-object-of-their-own-the-registry-keeps-their-definitions-and-making-or-widening-one-waits-for-approval.md)). Trigger URLs sit outside Access behind a secret token and a required signature ([ADR-0048](../adr/0048-trigger-urls-sit-outside-access-behind-a-secret-token-and-a-required-signature.md)). GitHub triggers are repo webhooks the GitHub App makes ([ADR-0049](../adr/0049-github-triggers-are-repo-webhooks-the-github-app-makes.md)). The platform facts behind the design (GitHub's deliveries, Durable Object alarms, Access bypass, cron libraries, size limits) are in [`docs/research/triggers.md`](../research/triggers.md).

- **In #191:** Schedules and webhooks as sources; the three kinds of Trigger; the `github` and `standard` formats; repo hooks the GitHub App makes; the agent's tools; the Settings page's Triggers section; fire records and Notifications.
- **Later, separate issues:** a Slack format (it signs `v0:<timestamp>:<body>` and needs a `url_verification` handshake and a 3 s answer), a Linear format (`Linear-Signature`), one-off and delayed Schedules ("in 2 h, check CI") on Session triggers, a Resource watch as a source (ADR-0032 left starting a Run to Triggers), organization hooks, a per-Trigger switch for Notifications, and the trigger tools on the MCP endpoint. Archiving idle Sessions is [#675](https://github.com/ian-pascoe/cloudpid/issues/675), and releasing idle Workspaces whose work is pushed is [#676](https://github.com/ian-pascoe/cloudpid/issues/676).

## Kinds and what a Fire delivers to

A Trigger is one of three kinds, by what keeps it. Its kind fixes what each Fire does.

| Kind                    | Kept by        | Each Fire                                                                           | Goes when                                    | Slice |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- | ----- |
| **Environment trigger** | an Environment | starts a new Session in a new Workspace of it (the spare Workspace when current)    | its Environment is deleted                   | S1    |
| **Workspace trigger**   | one Workspace  | starts a new Session in that Workspace, on its files, branch and Container          | its Workspace is removed, or its Environment | S3    |
| **Session trigger**     | one Session    | sends its Trigger message to that Session's root conversation, on its active branch | its Session is deleted                       | S4    |

- **Environment trigger.** The Fire's Session is registered as `session_start` registers one (`createSession` with `workspace: "new"`), so it takes the Environment's spare Workspace and counts as its use, which keeps the spare being made again. The branch is always `createSession`'s default, `cloudpid/<workspace id>`: a fixed name would make every second Fire fail with `branch-taken`. A Trigger may hold a `base` (else each Repo's default branch), a `model` and a `thinking` level (else the Environment's Settings at the time of the Fire); it holds no Role, which is for delegating. The Default Environment may hold one, with Repos or none ("every morning, summarize X"). An Environment trigger never reuses a Session; that is a Session trigger's job. `environment_delete`'s Approval card counts the Environment's Triggers.
- **Workspace trigger.** The Fire's Session is registered with `workspace: <id>`, so it works on the Workspace's branch; the Trigger holds a `model` and `thinking`, and no `base` and no Role. **It keeps its Workspace:** the Registry deletes a Workspace record only while no Session and no Workspace trigger is bound to it. Deleting the last Session of a Workspace that has a Workspace trigger leaves the Workspace (the confirm dialog says "The Workspace stays: trigger `<name>` keeps it"), and the Settings page's Workspaces section lists it with no Session. The owner's **Remove** of the Workspace removes its Triggers too, the confirm naming them, and so does deleting its Environment. A Subagent Workspace (it lasts as long as its subagent, and subagents have no trigger tools) and a spare Workspace (bound to nothing) can't hold one; the Registry refuses both. This rule also settles a contradiction: `workspace.md` → Workspaces says a deleted Session leaves its Workspace until the owner removes it, while `client-and-protocol.md` → Delete and GLOSSARY → Deleted Session say the last Session's delete removes the Workspace. The second is the rule; S3 fixes `workspace.md` and adds the Trigger exception to all three.
- **Session trigger.** The Fire's message goes to the root conversation's active branch, as `session_send`'s does, and the conversation carries on with its history; a move in the Session tree doesn't end the Trigger. While the Session is archived each Fire is skipped and recorded `archived`, and while a Session import is in progress `importing`; nothing needs resuming afterwards. A Fork or Clone doesn't copy the Session's Triggers (two Sessions would answer every Fire); the messages already sent stay in the copy's history. A Session trigger never outlives its Session, and so never keeps a Workspace.
- **Who may hold one.** Only the root conversation's agent makes Triggers; subagents can't ([_Agent tools and Approval_](#agent-tools-and-approval)). A Session trigger always sends to the root conversation.
- **The Session a Fire starts** (Environment and Workspace triggers) is titled by cloudpid, "`<trigger name>` · `<event>` · `<date, time>`", the time in the Trigger's zone and the event for webhooks only. The title is never generated (the payload would drive the title call, and Fires would get near-identical titles anyway); the owner can rename it.
- **Spending.** A Session a Trigger started is held to `spendLimit.perSession` like any other. A Session trigger's Fires add up in its one Session, so once that Session is at its Spend limit each Fire fails at no cost and pushes `failed`.

## Schedules

_Built in S1._

- **Syntax:** 5-field cron with names (`MON`, `JAN`) and the `@hourly`, `@daily` and `@weekly` shortcuts. 6- and 7-field forms are refused, as are the `L`, `W` and `#` extensions. There are no one-off or interval Schedules in #191.
- **Time zone:** each Schedule has a required IANA zone. The tool has no default; its description tells the agent to ask the owner, or to use a zone the Instructions name, since the agent can't know the owner's zone ("named, never assumed": [_Agent changes_](agent-changes.md)). The owner's form pre-fills the browser's zone. Defaulting to UTC was rejected: it would fire "Monday 9am" at the wrong hour without a word.
- **Daylight saving time:** croner's rules, as they are, with nothing wrapped around them. For a fixed-time expression (a single value in its minute and hour fields, such as `30 2 * * *`), a time skipped when clocks go forward fires once, at the first valid moment after it, and a time repeated when they go back fires once, at its first occurrence. For an interval expression (a wildcard, step, range or list in its minute or hour field, such as `*/15 * * * *`), a repeated time fires on both occurrences and a skipped time is skipped, as Vixie cron does.
- **Library:** croner (no dependencies, IANA zones, explicit DST rules) is the choice, provided a workerd test shows it loads and fires there; `cron-schedule`, already in `bun.lock`, has no zones, and `cron-parser` pulls in Luxon.
- **Interval:** no minimum beyond cron's own minute. Overlap, `wait` and coalescing bound what each Fire starts ([_Overlap_](#overlap)).
- **Missed Fires** (an outage, alarms that came late): one catch-up Fire, for the latest missed time, however late; any other missed times are recorded `missed`. The Fire's header shows the scheduled and the actual time. A Paused trigger never catches up on resume.
- **The alarm** is armed for the next Fire after each one. Alarms are at-least-once and their lateness is undocumented, so a Fire is not promised to the second; S6 measures it on a deployed stage.

## Webhooks

_Built in S2._

### The Trigger URL

- **Shape:** `<origin>/hooks/<trigger id>/<token>`, the id a UUIDv7 and the token 256 random bits as 43 base64url characters. The origin is the stage's, as the client document's is ([ADR-0035](../adr/0035-cloudpid-identifies-itself-with-a-public-client-document-and-takes-authorization-responses-outside-access.md)).
- **Routing:** the main Worker's exact-shape router matches the path before the Access guard, as `serveSignInPaths` does for the sign-in paths, and hands the request straight to `trigger:<id>`; every other form under `/hooks` (another shape, a trailing slash, other capitalisation) answers 404. Its constants live in a light module, as `mcp/sign-in-origin.ts` does for the sign-in paths, so the startup budget is kept ([`workers.md`](../development/workers.md)).
- **An unknown id** reaches an object with no storage, which answers 404 and writes nothing. A Trigger object's constructor is light, unlike a Session's, so this is cheap.

### Formats

Each webhook Trigger names one format. Every delivery must be signed; there is no unsigned mode.

- **`github`:** `X-Hub-Signature-256`, `sha256=` and the HMAC-SHA256 hex digest of the body, keyed with the Signing secret. The event is `X-GitHub-Event` (and the body's `action`); repeats are deduped by `X-GitHub-Delivery`. A `ping` is answered and shown on the Trigger's page as "GitHub reached this trigger"; it never fires.
- **`standard`:** [Standard Webhooks](https://www.standardwebhooks.com/)' `webhook-id`, `webhook-timestamp` and `webhook-signature`, with the spec's 5-minute timestamp window; repeats are deduped by `webhook-id`.

### Checks and answers

The Trigger object checks, in order, on the whole body in memory:

1. the token, by comparing its SHA-256 hash with the kept one in constant time;
2. the signature, an HMAC over the bytes received, before anything is parsed (and, for `standard`, the timestamp window);
3. the size and content type;
4. the `match` filter ([_Filters_](#filters)) and, for `github`, the bot-loop guard.

| Case                                                                          | Answer | Kept                                           |
| ----------------------------------------------------------------------------- | ------ | ---------------------------------------------- |
| unknown id, malformed path, wrong token                                       | 404    | counted per day (an unknown id writes nothing) |
| missing or bad signature, stale `standard` timestamp                          | 401    | counted per day                                |
| body over 25 MiB                                                              | 413    | counted per day                                |
| content type other than JSON, `application/x-www-form-urlencoded` or `text/*` | 415    | counted per day                                |
| GitHub `ping`                                                                 | 2xx    | its time, on the page                          |
| filtered out (by `match`, or the bot-loop guard)                              | 2xx    | counted per day                                |
| accepted                                                                      | 2xx    | a pending Fire, once it is stored              |

- **25 MiB** is GitHub's own payload cap, so cloudpid never refuses a GitHub delivery for its size, and it fits one RPC call to the object (32 MiB).
- **The answer comes once the pending Fire is stored**, never after the Fire's Session starts: GitHub gives a delivery 10 s and does not redeliver on its own.
- **Refused and filtered deliveries are only counted per day**, never kept as rows, since anyone can make them; the counts are kept for 30 days. Only an accepted, matching delivery reaches the Registry, through `admitFire`.

### Secrets

- **Made by the Trigger object**, at creation: the token and the Signing secret, 256 bits each. They are sealed with the vault bound to the object's own id (as the Workspace DO seals its Secrets) and kept **only in the Trigger object**; the token is also kept as its SHA-256 hash, which is what a delivery is compared with.
- **The agent never sees either**, as with Secrets. A tool result about a webhook Trigger points the owner to its page.
- **The owner reveals them** on the Trigger's page at any time (a pasted hook may need pasting again), and copies them.
- **Rotation:** the owner's **New URL** and **New signing secret** each apply at once; the old value stops working at that moment, with no window where both work. A hook cloudpid made on GitHub is updated in the same action ([_GitHub-managed hooks_](#github-managed-hooks)).
- **A reverted removal** brings the definition back with a new Trigger URL and Signing secret, and its Agent change says so. A GitHub-managed hook is made again on its own; a pasted URL must be pasted again, accepted because removal is a narrowing, as a kept Secret's deletion is.

### Access

- **`Server/Hooks`**, a fourth Access application on each deployed stage, has the one destination `<host>/hooks/*` and a Bypass/Everyone policy, with `domain` set to it and `adopt: true`, declared only while the Worker is live, as `Server/Bypass` is ([`infra.md`](../development/infra.md) → _Stages and Access_). ADR-0035's application stays as recorded.
- **Bare `/hooks`** stays behind Access (a `/hooks/*` path doesn't cover it), which is fine since nothing is served there.
- **`alchemy dev`** serves the route with no Access, so it can be tested with curl.
- **Previews:** CI's preview cleanup already deletes it, since its destination is a public one on the PR's host.

### Logs

- **The token is in the path**, so it lands in the owner's own Workers Logs (kept 7 days, readable only from the owner's account). GitHub's hooks can't send a custom header and a query string is logged too, so there is no better place; the HMAC is the real proof, and the Signing secret is never in a URL.
- **cloudpid's own spans and logs** record only the route template, `/hooks/:id/:token`, never the path.
- **Access logs nothing** on a bypassed path, so cloudpid's spans and the per-day counts are the only record of deliveries.
- **Rotation is the remedy** for a leaked URL.

## Payload and untrusted content

_The message's parts: S1 (header and Trigger message) and S2 (the body). GitHub trimming: S5._

A Fire's message has four parts, in order:

1. **The Trigger message, as written:** the owner's words (or the agent's, approved by the owner), never filled in from a payload. It may be as long as any input (1,900,000 bytes, `input_too_large`: [`mcp-endpoint.md`](mcp-endpoint.md) → Limits).
2. **A header cloudpid writes:** the Trigger's name and the Fire's time; for a Schedule, the scheduled and the actual time; for a webhook, the format, the event (`X-GitHub-Event` and `action`) and the delivery id; for a Workspace trigger's Fire that waited, how many more deliveries arrived meanwhile and to check the current state ([_Overlap_](#overlap)).
3. **The body, as untrusted content:** fenced after the owner's words, as an Attached resource's content is, and shown as a chip in the transcript. At most 16 KiB of it is inline, a bound on each Fire's context cost.
4. **The whole body, as a file:** the Session saves it to `.cloudpid/triggers/<fire id>.json` in its Workspace and names the path inside the fence, so the agent can run `jq` on it.

- **Bodies up to 1 MiB are kept** whole, each pending Fire's in its own SQLite row (a Durable Object's row holds at most 2 MB). A larger body (up to 25 MiB) still makes a Fire, but its body isn't kept: the message says so, with its size, the event and the delivery id, and the agent reads the event through `gh` instead. Chunking and R2 were rejected for a rare case, and refusing with 413 would drop a real GitHub event, which GitHub doesn't send again.
- **The last delivered body** (at most 1 MiB) is kept apart, for **Fire again** ([_The owner's UI_](#the-owners-ui)).
- **GitHub trimming** (S5, for the `github` format): `*_url` API links are dropped, except `html_url`, and the `repository`, `sender`, `organization` and `installation` objects shrink to their names. GitHub's payloads are mostly links.
- **Rejected:** the whole body inline (it blows up the context and gives injected text the most room), and field templates in the Trigger message (they mix the payload into the trusted part, which is the injection hole).

## Filters

_Built in S2._

- **`match`:** a webhook Trigger may hold a `match`, a map from dotted paths in the body to lists of allowed values. Paths are ANDed; the values of one path are ORed. The event's name is the path `event`. For example: `{ event: ["workflow_run"], action: ["completed"], "workflow_run.conclusion": ["failure"], "workflow_run.head_branch": ["main"] }`.
- **A delivery that doesn't match** is answered 2xx, counted as `filtered` for the day, and never becomes a Fire. A Fire costs a Session and a Container, so filtering is not left to the agent; a generic dotted-path match covers GitHub, Linear and the rest without code for each. JSONPath and CEL were rejected as more than this needs.
- **The bot-loop guard:** in the `github` format, a delivery whose `sender` is the GitHub App's own bot is always dropped, so "on an issue comment" can't be answered by the agent's own comment, again and again. It has no switch; one could be added later.
- **The cached definition:** the object checks `match` against the definition it caches at a revision number, and `admitFire` refuses a stale revision (`stale`) and answers the current definition, which the object checks again. A cached `match` is never acted on wrongly.

## Overlap

_Each kind's in its slice: S1, S3, S4._

What a Fire does when the last one's work is still going on is the Trigger's `when_busy`:

| Kind                | `when_busy`              | Default                                      | Busy means                                                                                   |
| ------------------- | ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Environment trigger | `skip`, `start`          | `skip` for a Schedule, `start` for a webhook | the last Fire's Session is still running or waiting for the owner                            |
| Workspace trigger   | `wait`, `skip`, `start`  | `wait`                                       | any Session in the Workspace isn't idle, by the Registry's status (the owner's own included) |
| Session trigger     | `queue`, `steer`, `skip` | `queue`                                      | the Session's Run is going on                                                                |

- **`skip`** records the Fire `skipped: overlap`.
- **`start`** starts the Fire's Session anyway. For an Environment trigger's webhooks it is the default, since each delivery is its own event (one issue each).
- **`wait`** (Workspace trigger) keeps the Fire pending in the Trigger object: `admitFire` answers `busy`, and the object arms its alarm to try again a minute later. Two agents editing one tree at once is the hazard `wait` avoids; `skip` would lose webhook events, which GitHub won't redeliver.
- **`queue` and `steer`** (Session trigger) are `session_send`'s: `queue` waits behind the Run, `steer` joins it at its next boundary. A Run waiting for the owner (an Approval, an Elicitation request) is still going on, so `queue` waits behind it and `steer` joins after the owner answers; either is recorded `sent (queued)` or `sent (steered)`.
- **Coalescing.** A Workspace trigger holds at most one waiting Fire; a later one is recorded `coalesced`, and the Session that finally starts is told how many more deliveries arrived while it waited, and to check the current state. A Session trigger sends no Fire while an earlier one of its own is still queued in the Session; the later one is recorded `coalesced`. Its Trigger message should say to check the current state. Merging queued messages was rejected: pi-durable's follow-up queue can't edit them.

## The Trigger object and the Registry

_Built in S1, with the hook in S5._

### Where it lives

- **`Trigger`**, keyed `trigger:<id>`, is in the `Server` Worker beside Session, Registry and `McpHost` (`SERVER_DURABLE_OBJECTS`, `worker-init.ts`'s `durableObjects`, and its code in the lazily loaded graph). Its class name can't be renamed once deployed.
- **It binds** the Registry and Session namespaces (same script), `GitHubAppConfig`, `SecretsConfig` (the vault) and telemetry. The Session (for the tools) and the main Worker (for deliveries and the owner's UI) bind the Trigger namespace. A Worker of its own was rejected: it would duplicate the App's key and the vault, and add a step to the deploy order.
- **It follows `workers.md`:** its own migration manifest and shipped-migration test; tests with `refusingStorage` for a replaced instance; and an alarm that catches its own errors and re-arms, since the platform gives up after 6 retries.
- **Every edge only gains** ([`workers.md`](../development/workers.md) → _Deploys and Durable Object code updates_): main Worker → Trigger, Session → Trigger, Trigger → Registry (`admitFire`, `triggerDefinition`, `knownTriggers`) and Trigger → Session (`fire`) are all new.

### Division of truth

| The Registry: _what_ a Trigger is and _whether_ it may fire                                                                                  | The Trigger object: _how_ it is reached and _when_ it fires     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| its definition (kind, owner, name, Trigger message, source, `match`, `when_busy`, `base`, `model`, `thinking`, paused), at a revision number | its token and Signing secret, sealed                            |
| its Agent changes                                                                                                                            | its alarm and its pending Fires                                 |
| the status of the Sessions overlap depends on                                                                                                | its fire log and per-day counts                                 |
| the cascades of Session, Workspace and Environment deletion                                                                                  | its GitHub hook (S5) and the cached definition, at its revision |

### `admitFire`

The Registry's `admitFire` is the one place a Fire is let through. In one transaction it checks that the Trigger exists and isn't paused, that the caller's revision is current (else `stale`, with the current definition), and the overlap, which only the Registry can judge (the Sessions' statuses). For an Environment or Workspace trigger it also registers the Fire's Session (`createSession`) in the same transaction, so two Fires can't both pass an overlap check together. It answers the Session to send to (a new one, or the Session trigger's own), `busy` (a Workspace trigger's `wait`), or why the Fire is skipped. It counts nothing and caps nothing: there is no Trigger fire limit, no cap on trigger-started Sessions running at once, and no count of Triggers per Session or Environment.

### Pending Fires

- **One path for both sources.** A Schedule coming due and an accepted delivery both become a pending Fire in the object's storage, which its alarm drains: `admitFire`, then the Session's `fire`. There is no cap on pending Fires; coalescing bounds what waits, and `start` drains at once.
- **The Fire's key** is `<trigger>:<scheduled time>` for a Schedule, or the delivery's id, and is the `requestId` of `createSession` and of `fire`. `createSession` remembers a `requestId` for 24 hours (`REQUEST_MEMORY_MS`) and the Session dedupes its `fire`, so a retried alarm never starts a second Session or sends twice. A redelivery GitHub is asked for a day later fires again, which is right.
- **`fire`** is a new Session method, never an optional field on `submit`: a Session still on old code (for up to 300 s after a deploy) drops fields it doesn't know and would take a payload as the owner's own words, unfenced. With a new method an old Session fails loudly, and the alarm retries until the new code is there.

### Self-healing

At each alarm the object reads its definition again (`triggerDefinition`). A Trigger that was removed wipes the object (its hook deleted first, S5); one paused disarms it; a changed Schedule re-arms it. So a lost "re-arm" from a caller heals at the object's next touch, as the `McpHost` sync does. A delivery to a Trigger the Registry no longer knows heals the object the same way.

### Cascades

- **Deleting a Session, removing a Workspace or deleting an Environment:** the Registry deletes the Triggers it holds (a Session's Session triggers; a Workspace's Workspace triggers; an Environment's all three kinds, through its Workspaces and Sessions) in the same transaction, and returns their ids. The caller (the main Worker's `deleteSession` and `removals`, which `environment_delete` runs too) then calls each object's `remove()`, which deletes its GitHub hook, its alarm and its storage.
- **A failed hook delete** re-arms the alarm, with backoff, for up to a day, then logs a warning.
- **A lost `remove()`** heals at the object's next touch ([_Self-healing_](#self-healing)).
- **A removal the agent made** keeps the definition in the Registry, as removed, while its Agent change is in the Scope's 200-entry history, so a revert brings it back (with a new URL and secret: [_Secrets_](#secrets)).

## GitHub-managed hooks

_Built in S5, after S0 is deployed and S2; the owner's accept is S6's._

- **The hook.** For a webhook Trigger in the `github` format whose source is a GitHub repo and a list of events, the Trigger object creates a repo webhook as the GitHub App, with a token asking only `{ repository_hooks: write }`, minted for the installation on the repo's owner: subscribed only to the Trigger's events, sending to the stage's own Trigger URL, signed with the Trigger's Signing secret. It updates the hook when the owner replaces either value, and deletes it when the Trigger goes. A reverted removal makes it again. The agent wires up "when CI fails on `main`, fix it" with nothing for the owner to paste.
- **The orphan sweep.** Before it creates a hook in a repo, the object lists that repo's hooks and deletes those that point at this stage's `/hooks/<id>/` and whose id the Registry doesn't know (`knownTriggers(ids)`). A destroyed preview's hooks point at a dead host and fail harmlessly at GitHub until then; there is no CI sweep, and S6 removes its own Triggers.
- **GitHub's limits.** At most 20 hooks per event per repo: GitHub's refusal is shown plainly, and cloudpid sets no cap of its own.
- **The permission.** The App gains the repository permission Webhooks: write (`repository_hooks`). `GITHUB_APP_PERMISSIONS`, the App's list, gains it for new registrations; for the existing App the owner adds it in the App's settings and accepts it on each installation. An installation that hasn't accepted it gets a clear message naming that step, in the tool's result and on the Trigger's page.
- **Container tokens** (S0, built) are minted with an explicit list of permissions, the Containers' list (`CONTAINER_GITHUB_PERMISSIONS`), kept in `@cloudpid/config` beside the App's list (`GITHUB_APP_PERMISSIONS`), which `infra` and `server` share: the Workspace DO's `GitHubApp` (`apps/server/src/workspace/Workspace.ts`) always passes it, so every GitHub token request carries `permissions`. Before S0 it asked for none, which GitHub reads as all of the installation's. The two lists are separate and hold the same values until S5, which adds `repository_hooks` to the App's list only; it is never in the Containers' list (a test fails if it is). Without the list, a prompt-injected `gh api` could add a hook that sends a repo's events anywhere. S0 deploys before the owner accepts the permission; tokens minted before it expire within the hour. Any permission the App gains later reaches Containers only when it is added to their list, deliberately.
- **The App's own webhook** stays off ([ADR-0049](../adr/0049-github-triggers-are-repo-webhooks-the-github-app-makes.md)).

## Agent tools and Approval

_Built in S1; the owners `workspace` and `session` in S3 and S4, and the webhook arguments in S2 and S5._

- **Tools,** one purpose each ([ADR-0019](../adr/0019-the-agent-manages-its-environments-and-settings.md)): `trigger_list`, `trigger_get`, `trigger_create`, `trigger_message_set`, `trigger_schedule_set`, `trigger_match_set`, `trigger_options_set`, `trigger_pause`, `trigger_resume` and `trigger_remove`. They are deferred and the root conversation's only (`trigger_` joins `PARENT_ONLY_TOOL_PREFIXES`). Each change tool takes a required `reason` and the Trigger's id.
- **`trigger_create`** names the Trigger's owner explicitly: an Environment's id, `workspace` (this Session's Workspace; the agent has no tool that lists other Workspaces, so it can only mean "here", and taking a Workspace id later is additive) or `session` (this Session). It takes the name, the Trigger message, the source (a Schedule with its zone, or a webhook format; for a GitHub-managed hook, the repo and events), and optionally `match`, `when_busy`, `base` (Environment triggers), `model` and `thinking`. The Registry refuses a Subagent Workspace and a spare.
- **`trigger_options_set`** changes `when_busy`, `base`, `model` and `thinking`, each where the Trigger's kind takes it (`base` for Environment triggers only, `model` and `thinking` for Environment and Workspace triggers, `when_busy` with its kind's values: [_Overlap_](#overlap)).
- **Kind and owner are fixed** at creation: a Trigger's kind and its Environment, Workspace or Session never change. To move one, remove it and create another.
- **No secrets in results.** A webhook Trigger's result never holds its URL or Signing secret; it points the owner to the Trigger's page.
- **No fire-now tool.** The agent can't start Sessions at will today (`environment_create`'s result says so), and an approved Trigger must not become a way to.
- **Agent changes.** Every Trigger change is an Agent change, recorded and revertible, under the Environment's Scope with the field `triggers.<id>`. A Workspace trigger's and a Session trigger's are recorded under their Environment's Scope, naming the Workspace by its branch or the Session.
- **Approval** ([ADR-0047](../adr/0047-triggers-fire-from-a-durable-object-of-their-own-the-registry-keeps-their-definitions-and-making-or-widening-one-waits-for-approval.md)): `trigger_create`, any change to the Trigger message, Schedule, `match` or options (`trigger_message_set`, `trigger_schedule_set`, `trigger_match_set`, `trigger_options_set`), and `trigger_resume` wait for the owner's Approval. `trigger_pause` and `trigger_remove` apply at once: they only narrow, as for MCP server changes. The owner's own edits never wait.
- **The only gate on how much Triggers do** is the owner's Approval of each Trigger, plus the Spend limit when the owner turns it on. There is no Trigger fire limit and no `settings_trigger_fires_set`.

## The owner's UI

_The Settings section: S1, with the webhook parts in S2 and the Workspace row's button in S3. Session details: S4._

- **The Settings page**, not a page of its own (it is "the one page where the owner configures cloudpid"). A **Triggers** section at both Scopes: at an Environment, its Environment triggers, its Workspace triggers (listed under their Workspace, by branch) and its Sessions' Session triggers; at Global, all of them, grouped by Environment. Each Trigger shows its last and next Fire, then its fire log.
- **Create:**
  - an **Environment trigger**, from the Triggers section's form;
  - a **Workspace trigger**, from **New trigger** on a Workspace's row in the Workspaces section;
  - a **Session trigger** only by asking the agent: being made by the agent is the point of one, and it saves a form in Session details.
- **The form:** a name (1 to 80 characters) and the Trigger message; the source, **Schedule** (cron, the zone pre-filled from the browser, and a preview of the next 5 Fires) or **Webhook** (format GitHub or Standard; for a GitHub-managed hook, the repo and events); `match` as rows of a path and its values; `when_busy`; and `base`, `model` and `thinking` where the kind takes them.
- **Edit** any field but the kind and the owner, which are fixed at creation. The owner's edits never wait for Approval.
- **Reveal and copy** the Trigger URL and Signing secret, with **New URL** and **New signing secret** buttons.
- **Pause, Resume, Remove,** with a confirm on Remove.
- **Fire log:** the last 1,000 Fires, each with its outcome and a link to its Session; the per-day counts of refused and `filtered` deliveries over the last 30 days; the last delivery's time; and "GitHub reached this trigger" from its ping.
- **Fire now** on a Schedule Trigger, and **Fire again with the last delivery** on a webhook Trigger; both are recorded with the source `manual`. A "Send test delivery" was rejected: a delivery cloudpid signs itself proves nothing about the sender, GitHub has its own Redeliver, and curl works for any other sender.
- **Session details:** a **Triggers** section for the Session's Session triggers, each with pause and a ✕, as _Watched resources_ has.
- **Workspaces section:** a Workspace kept only by a Workspace trigger is listed with no Session; the Delete and Remove confirms say what a Workspace trigger keeps or loses ([_Kinds_](#kinds-and-what-a-fire-delivers-to)).
- **Session list:** no filter for trigger-started Sessions yet (later, additive).

## Fire records, origin marks and notifications

_Built in S1, the delivery counts in S2._

- **The fire log** is a row per Fire in its Trigger object: when, the source (the scheduled time; the delivery id and event; or `manual`), and the outcome: `started <session>`, `sent (queued)`, `sent (steered)`, `skipped: overlap | coalesced | archived | importing | missed`, or `failed: <reason>`. The last 1,000 Fires are kept, and the per-day counts of refused and filtered deliveries for 30 days; both go with the Trigger.
- **Origin marks.** `MarkedOrigin`'s `auth` gains the member `trigger`, holding the Trigger's id and name; an older reader decodes it as `unknown` rather than failing. A Session a Trigger started shows the chip "Trigger · `<name>`", and each input a Trigger sent shows "via `<name>` (Trigger)".
- **Notifications.** A Run a Trigger started pushes `finished` or `failed` at its end, as the owner's submissions do: `fire` records its submission in `notify-submissions`, as MCP task follow-ups are. A Fire that fails pushes. Overlap and coalesced skips, filtered deliveries and refused ones never push. `client-and-protocol.md` → Notifications' **Triggers** bullet is renamed **When they go out**, so the word means one thing.

## Observability

_Each span with the slice that builds its code._

Attributes are fixed values and counts only: never the token, the Signing secret, the body, or a header's value other than the event's name and the delivery id. Paths are recorded as the route template, `/hooks/:id/:token`.

- **`trigger.delivery`:** format, outcome (`accepted`, `filtered`, `unauthorized`, `too_large`, `unsupported`, `not_found`, `ping`), byte count, event.
- **`trigger.fire`:** Trigger id, kind (`environment`, `workspace` or `session`), source (`schedule`, `webhook`, `manual`), outcome (`started`, `sent`, `skipped:<why>`, `failed`), lag behind the scheduled time in ms, the alarm's retry count.
- **`trigger.alarm`.**
- **`trigger.github_hook`:** `create`, `update`, `delete` or `sweep`, its outcome and HTTP status.
- **Telemetry names:** `trigger.*`. The `mcp.trigger` span attribute and "Other triggers (D7.2)" in `mcp-connections.md` are internal or prose, and stay.

## Testing

Following [`AGENTS.md`](../../AGENTS.md)'s conventions.

- **Node tests:** cron parsing and DST (pure); the `match` evaluator; the GitHub trimmer; rendering the message's header; the exact-shape `/hooks` router.
- **workerd tests** (`*.workerd.test.ts`):
  - **The Trigger object:** the alarm fires when due and re-arms for the next Fire (which also proves croner loads under workerd); a `fire` that throws is retried without a second Session; the catch-up rule for missed Fires; a removed or paused definition found at the alarm wipes or disarms the object; the stale-revision refresh; signatures in both formats (bad, missing, a stale `standard` timestamp); a 404 for an unknown id writes no storage; bodies at the 1 MiB edge, kept or not; a replaced instance mid-Fire (`refusingStorage`).
  - **The Registry's `admitFire`:** overlap for each kind, over real storage, with concurrent admits; the Workspace record kept by a Workspace trigger; the cascades.
  - **The Session's `fire`:** fenced untrusted content, the file in the Workspace, the chip; the `notify-submissions` entry; `queue`, `steer` and `skip`, and coalescing.
  - **The tools:** the Approval flows, over the existing approvals fixtures.
  - **Migration manifests** for the Registry and the Trigger object.
- **A deployed stage** (S6), on a preview and then on `prod`: see [_Slices_](#slices).

## Slices

#191 is the parent issue; each slice is a sub-issue, shipped in order. S3 and S4 can run in parallel.

| Slice | Issue                                                     | Builds                                                                                                                                                                                                                                                         | Depends on | Label           |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------- |
| S0    | [#677](https://github.com/ian-pascoe/cloudpid/issues/677) | Container GitHub tokens minted with an explicit list of permissions                                                                                                                                                                                            | –          | ready-for-agent |
| S1    | [#678](https://github.com/ian-pascoe/cloudpid/issues/678) | Environment triggers with Schedules: the Trigger object, the Registry's definitions and `admitFire`, the `trigger` origin mark and chips, the Session's `fire`, the trigger tools with Approval, the Settings page's Triggers section, Fire now, Notifications | –          | ready-for-agent |
| S2    | [#679](https://github.com/ian-pascoe/cloudpid/issues/679) | Webhook sources: `/hooks/<id>/<token>` and `Server/Hooks`, the `github` and `standard` formats, secrets in the Trigger object, reveal and rotate, `match`, the bot-loop guard, ping, the fenced payload and its file, Fire again                               | S1         | ready-for-agent |
| S3    | [#680](https://github.com/ian-pascoe/cloudpid/issues/680) | Workspace triggers: the lifetime rule, `wait`, New trigger on a Workspace's row, and the fix of `workspace.md`'s line on a Session's delete                                                                                                                    | S1         | ready-for-agent |
| S4    | [#681](https://github.com/ian-pascoe/cloudpid/issues/681) | Session triggers: `fire` into the root conversation's active branch, `queue`/`steer`/`skip` and coalescing, Fork and Clone, archived and importing Sessions, the Session details section                                                                       | S1         | ready-for-agent |
| S5    | [#682](https://github.com/ian-pascoe/cloudpid/issues/682) | GitHub-managed repo hooks: create, update, delete and sweep, the GitHub trimmer, the missing-permission message, `repository_hooks: write` in `GITHUB_APP_PERMISSIONS`                                                                                         | S0, S2     | ready-for-agent |
| S6    | [#683](https://github.com/ian-pascoe/cloudpid/issues/683) | Verification on a deployed stage, and the owner's accept of Webhooks: write                                                                                                                                                                                    | S2, S5     | ready-for-human |

S6 checks, on a preview and then on `prod`:

1. an unauthenticated POST to `/hooks/<id>/<token>` reaches the Worker (401 or 404, not Access's 302), while bare `/hooks` and other paths still get the 302;
2. a real repo hook reaches the stage, its ping is shown, and a signed event fires;
3. Webhooks: write is accepted on each installation, and Container tokens don't carry it;
4. how late an alarm fires, watched over a day;
5. Workers Logs shows the Trigger URL, as [_Logs_](#logs) expects.
