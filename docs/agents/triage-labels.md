# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Besides these, `cloudpid-report` marks an issue a cloudpid agent filed about cloudpid itself with the `cloudpid_report` tool (GLOSSARY.md → cloudpid report; ADR-0051). Such an issue is filed with `needs-triage` too, and triaged like any other: it is the agent's account, public, and may be wrong. Remove neither label to hide one; close it instead. The label must exist (`gh label create cloudpid-report`): while it is missing, cloudpid refuses every report.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.
