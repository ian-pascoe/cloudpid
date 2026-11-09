---
status: accepted
---

# A cloudpid report is posted at once by the Registry, as the GitHub App, with an issues-only token

The agent should be able to report friction with cloudpid itself in passing (GLOSSARY.md → cloudpid report), so `cloudpid_report` is offered by default and files a public issue on `ian-pascoe/cloudpid` labelled `cloudpid-report` and `needs-triage`. The repo is public while the owner's Environments hold private repos, so a report could make private detail public, and cloudpid cannot take a post back. We decided it is **posted at once, with no Approval**: the owner accepts that risk, and the guard is a deterministic check rather than a human in the loop. The Registry refuses a title or body that names the owner's Repos (their GitHub `owner/name`, an owner other than `ian-pascoe`, a `/workspace/<dir>` path, or a compound Repo name of 6 or more characters; `ian-pascoe/cloudpid` itself, Environment names and MCP server names are not matched). The Session refuses held Secrets and token-shaped strings before that, and cloudpid's own footer carries the stage, the version, the model and a Session link, never an Environment or Repo name.

The **Registry** posts, not the Session or a Container: a Session never holds a GitHub token and asks the Registry, as for Skill installs. It mints a token for the installation on `ian-pascoe` with `{ issues: "write" }` alone, narrowed with `repositories: ["cloudpid"]` (the narrow token per purpose that the Trigger object's `repository_hooks` token set). The target repo is a constant in code, not a setting, because the agent changes extension options and could otherwise point public posts at any repo the App reaches. The Registry claims each call by its Session and task before it posts, so a rerun never posts twice, and it counts the caps every Session shares.

## Considered options

- **A draft the owner sends or discards** (a store, a send and discard UI, a Notification, a 7-day expiry, as ADR-0050's requests): it stops the leak a human would catch, at 2–3× the build, and the owner asked for a post.
- **The owner's Approval before each post:** it stalls Runs a Trigger started, with nobody there to answer.
- **Post at once only from Environments whose Repos are all public:** it is the draft's whole build plus a visibility check per Repo, and "only public Repos" still leaves Instructions, Skills, attachments and the owner's messages, which may be private.
- **`gh issue create` from the Container**, which already works: no fixed label or shape, no checks, no caps, and it needs a Container.
- **The target repo as a setting** or a deploy-time variable: not needed with one owner, and a setting can be redirected by the agent.

## Consequences

- Pasted private code or data that names no Repo can still be posted; only the tool's description guards against that.
- The check knows no Repo's visibility, so the owner's other public repos are refused too; the agent rewrites without them.
- A prompt-injected agent gains nothing it did not already have (`gh issue create`, `web_fetch`).
- Every stage posts to the real repo, marked with its stage in the footer, with a lower daily cap off `prod`.
- The `cloudpid-report` label is made by hand once; until it exists, every report is refused before anything is posted.
