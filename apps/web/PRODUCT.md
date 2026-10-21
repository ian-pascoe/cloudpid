# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One user: the owner, the only person allowed past Cloudflare Access. They use the app in two settings:

- **Phone, as the installed PWA.** A push says a Run ended, failed, or needs input. They open the Session to check where it stands, answer a Secret request or a Browser Handoff, and steer or stop the agent.
- **Desk.** They start Sessions, set up Workspaces and clone repos, read long transcripts and subagent threads, and change Settings.

Which of the two is primary is not decided; both must work fully.

## Product Purpose

The owner's local pi coding agent, running all the time in the cloud. Sessions keep working while the owner's laptop is closed, and the owner checks on them from anywhere. Success means the owner can hand off coding work and trust what state it is in at a glance from their phone.

## Positioning

It is the owner's own pi harness (same tools, skills, roles, and conversation model), not a hosted product: durable Sessions in Durable Objects working on Workspaces held in the cloud, reachable from any device.

## Operating Context

- Notifications arrive by Web Push; a tap opens the Session. On iOS a push needs the installed app.
- A Session can run for a long time, with subagents, background tasks, a Todo List, and usage against a Spend limit, all shown live.
- Some steps need the owner: a Secret entered in a masked form, a Browser Handoff in a Live View link.
- Several Sessions share one Workspace's files.

## Capabilities and Constraints

- Terms follow the repo's `GLOSSARY.md` (Session, Workspace, Run, Subagent, Secret, Browser Handoff, Archived Session, Workspace name, and the rest). UI copy uses them in plain, sentence-case wording ("New session").
- Light and dark themes follow the system setting.
- Single owner: no sign-in UI, accounts, tenants, or sharing.
- Secrets and Live View links are credentials: never shown again once used, never put anywhere they could leak.

## Brand Commitments

- The app's name in the manifest and page title is "Pi on Cloudflare" (short name "Pi"); "cloudpid" is the repository's name. Whether the product's name should change is not decided.
- Voice: plain, precise, unhurried sentences, no marketing tone.

## Evidence on Hand

- Icons in `apps/web/public/` (`icon.svg`, PNG sizes, maskable icon).
- No users other than the owner, no testimonials, no metrics: none to be invented.

## Product Principles

1. State at a glance: where a Session stands (running, waiting on the owner, done, failed) is clear without reading the transcript.
2. The owner is interrupted only when needed, and every interruption leads straight to the thing to act on.
3. Nothing destructive happens by accident: deleting is explicit and says what will be lost.
4. Phone and desk are equals: every task can be done on either.
5. Credentials never leak through the UI.

## Accessibility & Inclusion

The usual baseline: full keyboard use, visible focus, WCAG AA contrast in both themes, and respect for reduced motion. No further needs established.
