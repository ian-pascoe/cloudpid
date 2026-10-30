---
status: accepted
---

# An MCP prompt is got when its message is sent and becomes the owner's one message

The owner picks an MCP prompt from the composer's `/` menu (`/mcp__<server>__<prompt>`), fills its arguments in a form, and sends it as a chip with their own words; the agent cannot get one itself, as MCP makes prompts user-controlled. The Session calls `prompts/get` once, when it admits the message (as Prompt templates and Skills expand at submit, [ADR-0001](0001-expand-skills-and-prompt-templates-at-submit.md)), and a failure refuses the send instead of sending the text as typed. The result, however many messages and roles it holds, becomes the owner's one user message: an `<mcp_prompt server name title>` block first, its assistant-role parts marked `<prompt_message role="assistant">` inside it, then the prompt's images, then what the owner typed. Its text, of both roles, reaches the model as the owner's request, as a Prompt template's or a Skill's does once the owner picked it, a Repo's server's included; the resources it embeds are untrusted content in the same `<mcp_resources>` blocks as an Attached resource's.

## Considered options

- **Real assistant messages for assistant-role parts**: pi-ai's assistant message holds no images and needs a provider, model, usage and stop reason cloudpid would have to make up, which Usage, context estimates and cross-provider replay all read; a trailing one is a prefill that providers reject with thinking on; and the transcript would show the agent saying what it never said.
- **Wrapping the whole prompt as untrusted**: a prompt exists to instruct, and Prompt templates and Skills from the same Repos already speak in the owner's voice; the spec's "user-controlled" is about who decides when a prompt is used, not who wrote it.
- **Getting the prompt when it is picked and putting it in the composer as editable text** (VS Code's way): a result is messages with roles, images, audio and resources, which a textarea flattens into the owner's own words, losing the resources' untrusted framing; abandoned picks would start Containers; and the text could be stale by the time it is sent.
- **A tool for the agent to list and get prompts**: the model choosing a server's instructions for itself is what tools already are, and no other MCP host offers one.

## Consequences

- A server that pastes fetched third-party text into a prompt's text message delivers it in the owner's voice; only embedded resources are marked untrusted.
- A follow-up queued behind a long Run carries what the server returned when it was sent, not when it is placed.
- A get may take up to 30 s, so a message is prepared outside the Session's admission lock and only placed under it, in order per conversation; other conversations, Stop and commands never wait for it.
- Fork, Clone and Branch copy the stored result without getting the prompt again; editing the message gets it again at send.
