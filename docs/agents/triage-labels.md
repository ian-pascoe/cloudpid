# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker: labels of the Linear team **SPI** (`docs/agents/issue-tracker.md`), with the ids Executor's Linear tools take (`labelId`, `labelIds`). The `linear` CLI takes the names.

| Label in mattpocock/skills | Label in our tracker | Linear label id                        | Meaning                                  |
| -------------------------- | -------------------- | -------------------------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | `60b09003-73ce-4341-b886-9d152402cfb6` | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | `5faac0a3-c8be-42da-8dd5-f724c463dc7a` | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | `58973407-93c2-4c40-bad0-97e93b2a0610` | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | `84c02e07-a608-487b-9b73-4c47683d7565` | Requires human implementation            |
| `wontfix`                  | `wontfix`            | `617a55ae-8e6c-4b26-9688-e3c678454e9b` | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Besides these, `cloudpid-report` (`244a4f0c-c158-49a5-a7df-40a49c89d282`) marks an issue a cloudpid agent filed about cloudpid itself with the `cloudpid_report` tool (GLOSSARY.md → cloudpid report; ADR-0051). Such an issue is filed on GitHub with `needs-triage` too, synced into Linear, and triaged like any other: it is the agent's account, public, and may be wrong. Remove neither label to hide one; close it instead. The label must exist on GitHub (`gh label create cloudpid-report`): while it is missing, cloudpid refuses every report.

The wayfinder labels are SPI's too: `wayfinder:map` `42d85e9b-40b2-40bf-9c45-e98799d23930`, `wayfinder:research` `e03d2ce5-67b9-4c99-923f-deaade4195be`, `wayfinder:prototype` `21dda5a9-ab19-4b9b-b429-df49aa2bb39e`, `wayfinder:grilling` `642c5812-78ae-4e1d-b15e-0c130b0ca861`, `wayfinder:task` `ebe3749e-2cee-4b3d-b0a4-9c514bd8a60c`.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
