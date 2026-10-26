---
status: accepted
---

# Variables for every Environment, merged at handover

A Secret can be kept for every Environment (`*`), but a plain variable could be kept only per Environment. So the owner kept `CLOUDFLARE_EMAIL` as a Secret for every Environment, only to share it. The Build's snapshot scan then refused the snapshot, finding the value in `/root/.gitconfig`: the bootstrap writes the same email as git's `user.email` (`CLOUDPID_GIT_EMAIL` defaults to it). The scan did what it should: a Secret's value must never reach a snapshot. The value was never secret, so the mistake was keeping it as a Secret.

Plain variables can now be kept for every Environment too, with the scope `*` the Secrets already use. Shared configuration that is not secret never has to be a Secret.

- **Storage.** One JSON document, `every-environment`, in the Registry's existing `documents` table (migration 4): the overrides of `EveryEnvironmentSettings`, `{ variables }`. There is no new table and no migration. An Environment's own variables are already one JSON value, not rows; the Secrets have rows only because each value is sealed and bound to its scope and name. A struct rather than a bare map leaves room for other settings kept for every Environment.
- **Precedence.** An Environment's own variable wins over the one kept for every Environment of the same name, as an Environment's own Secret wins. Both stay under `toolchainEnv` and what a caller passes.
- **Validation.** The same rules as an Environment's own variables (names, reserved names, value length, at most 50). Saves are strict and reads lenient.
- **The 50 applies to the merged set** an Environment's Workspaces get. A save of an Environment is refused when its merged set would pass 50, and a save of the variables for every Environment is refused when any Environment's would.
- **The merge happens before the Workspace side**, in the Registry and the main Worker, not in the Workspace DO. `getWorkspaceSetup`, `upkeepSpares` and `workspaceOverrides` (for the Session's own Workspace after an Agent change) hand the merged overrides. `buildWork` hands the Environment's own overrides and the variables kept for every Environment (`everyVariables`), and the Build upkeep and Test Builds merge them (`withEveryEnvironmentVariables`) before the Build key is computed and the request is made. The Workspace DO, `ContainerLaunch`, `ToolchainBackend`, the Build object and `buildKey` are unchanged: they receive the merged set as the Environment's variables and never know of the document. An Environment that inherits nothing gets the same overrides and the same Build key, so a deploy rebuilds nothing.
- **Builds** are made again for every Environment that wants one and does not override the name whenever the variables change, as for a `*` Secret marked for the Build, since Setup Scripts get the variables. A Test Build merges them under the proposed map.
- **Agent changes.** Changes to them are recorded under the scope `*` (already the history of the `*` Secrets) as `variables.<NAME>` and reverted like an Environment's own. `environment_variable_set` and `environment_variable_unset` take `id: "*"` with the same refusals; the other `environment_*` tools that are not for a Secret or a read refuse it.
- **The page** gets a Variables form in the section for every Environment, a Variables line on each card, and an Edit dialog that counts the inherited names in its limit. The Secrets text says that a value that is not secret belongs in the variables, and so does the snapshot's refusal.

It extends ADR-0016 (variables) and ADR-0019 (`id: "*"`).

## Considered options

- **A scan exemption** for values that are also the git identity, or for Secrets marked "not secret". It would weaken the check that keeps a Secret out of a snapshot for every Secret, to cover a value that was never one.
- **Changing `CLOUDPID_GIT_EMAIL`** so the value differs. It avoids the one case and leaves the cause: shared non-secret configuration with nowhere to live.
- **A table with a row per variable.** More schema (a migration) for values that need neither sealing nor per-row access, when an Environment's own variables are one JSON value.
- **Merging in the Workspace DO.** It cannot reach the Registry, so a second channel (a field, its own storage and a merge at each bootstrap) would touch `prepare.ts`, `spare.ts`, `settings.ts`, `toolchains.ts` and the Build request, for no gain over handing the merged overrides it already applies.
- **A limit of 50 per scope** (up to 100 merged). The Workspace DO's schema refuses more than 50 variables, and its lenient read then drops all of them, so every command would lose every variable.

## Consequences

- A change to the variables for every Environment can rebuild every Environment (the Builds are the cost, as for a `*` Secret marked for the Build).
- A save can be refused because of another Environment: its own variables plus those for every Environment pass 50.
- Secrets for every Environment remain for credentials only.
- The owner's case is not migrated: add `CLOUDFLARE_EMAIL` to the variables for every Environment on the Environments page, then delete the `*` Secret. The agent cannot do it in that order, since `environment_variable_set` refuses a value that holds a held Secret until the Secret is gone, and deleting it needs the owner's Approval. Scripts that read the Secret through its `PI_SECRET_` variable must read `$CLOUDFLARE_EMAIL`.
