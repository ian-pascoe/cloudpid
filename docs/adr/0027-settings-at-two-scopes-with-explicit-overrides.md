---
status: accepted
---

# Settings at two Scopes, with explicit Overrides

The Settings (model, Roles, offered tools, spend limit, …) were kept once, for every Session. The Container settings (size, idle time, scripts, Toolchains, …) were kept only per Environment. Only Variables, Secrets and Skills existed at both levels. The owner wants one Settings page with a Scope picked at its top (Global, or one Environment), so that every setting can be set Global and overridden per Environment, with the page showing which fields are inherited and which are overridden.

Every setting except an Environment's name and Repos, a device's Notifications, and records such as Workspaces and Agent changes now has a value at two Scopes. A Session resolves its Environment's Overrides over Global over the defaults before its next request.

- **Global, not "for every Environment".** Scope `*` is called Global in the glossary, the UI and the docs. Every Session works in some Environment, so the two cover the same ground, and Global is the usual name for the top of a settings hierarchy. Two names for one Scope would be worse than either.
- **Keyed settings merge key by key; everything else is replaced whole.** Variables, Secrets, Skills, Roles and extension options are overridden name by name. Single values, lists (offered tools, Container-only paths) and texts (Setup and Start Scripts, Toolchains) are replaced whole: an Environment's Setup Script runs instead of the Global one, not after it. Replacement makes "inherited" and "overridden" a property of a field that the page can show and Reset.
- **Instructions are the exception: they add up.** The model is shown the Global Instructions, then the Environment's, then the Project instructions (`AGENTS.md`), the nearer winning where two disagree, as nested `AGENTS.md` files and pi's `~/.pi/agent/AGENTS.md` already work. Replacing them would drop the owner's Global rules from any Environment that adds its own. They are a frozen system prompt section before `project_context`, so an edit applies from a Session's next Context Window, and the agent changes them only with the owner's Approval, at both Scopes: they steer every context unasked, which makes them a stronger target for a prompt-injected agent than the Global Skills that already need one.
- **An Override is explicit.** An Environment stores exactly the fields set on purpose, even one equal to the Global value, and Reset removes it. The defaults keep the old rule: Global still stores only what differs from them (`overridesFrom`). Without this an Environment could not pin a value: saving "Opus" while Global is Opus would store nothing, and the Environment would follow Global's next change. The Container settings Environments already store become their Overrides, and the Global Container settings start at the defaults, so nothing resolves differently after the migration.
- **The agent names the Scope.** The agent's settings and Environment tools require a `scope` (`*` or an Environment's id) instead of defaulting to the Session's Environment, so "use Sonnet for small" is the agent's decision about where, recorded in the Agent change. Approvals are otherwise unchanged: a Limit at either Scope, Global Skills, Instructions at either Scope, and what no revert undoes.

It extends ADR-0019 (the agent changes Environments and Settings, with `id: "*"`) and ADR-0023 (Variables for every Environment, now Global).

## Considered options

- **Keep the Settings Global and give Environments only their Container settings**, with separate pages per kind. The owner wants per-Environment models, tools and limits, and one place that shows what an Environment inherits.
- **Diff Overrides against the inherited value**, as Overrides are diffed against the defaults today. Simpler storage, but a value cannot be pinned, and the page could not tell an Override equal to Global from an inherited field.
- **Chain every text** (Global Setup Script, then the Environment's). That is useful for scripts, but it makes "overridden" meaningless for them and needs ordering rules per field. Only Instructions chain, since dropping the Global ones is never what the owner wants.
- **Default the agent's `scope` to its Session's Environment.** That is convenient, but a request meant for every Environment would silently land in one.

## Consequences

- Changing a Global value can do nothing for an Environment that overrides it. The page shows "Overridden in N environments" at Global for that reason.
- A Session's Settings now depend on its Environment, so two Sessions started at once can run with different models, tools and spend limits.
- An Environment's Setup Script hides the Global one entirely. An owner who wants both copies the Global text into the Environment's.
