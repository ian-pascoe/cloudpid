# Skills and Prompt templates expand when a message is submitted

A message that starts with `/skill:name …` or a Prompt template's `/name` is expanded by the Session when it is submitted: the model gets the expansion (the Skill in local pi's `<skill name location>` block, the template with its arguments filled in), and the conversation entry keeps what the owner typed in its `data`, which the transcript, the Session's title and the queue lanes show instead.

A `$name` naming a known Skill, anywhere in the message's prose, is not expanded: it becomes, in place, a Markdown link to the Skill's `SKILL.md` (`[$name](/path/to/SKILL.md)`), as the owner's local pi extension pi-skills-selector makes it. The model reads the Skill when it needs it, so naming a Skill in passing keeps the context small, and a message means the same here as in the owner's local pi. The entry keeps what the owner typed in the same way, but names no Skill as expanded.

## Considered Options

- **Expand at request time**: keep the typed text as the entry and expand it in a `beforeRequest` hook. The transcript would need no display data, but the Skill file would be read again for every request, so editing it mid-Session would change earlier messages, break the prompt cache, and make the model's view of the past differ from what it actually saw.
- **Embed the Skill for `$name` too** (as first built): every Skill named in passing would put its whole `SKILL.md` into the context at once, whether the model needs it or not, and the message would mean something else than in local pi, where `$name` is a link.

## Consequences

- A Skill embedded with `/skill:` is frozen as it was when the owner named it, as in local pi; one linked with `$name` is read as it is when the model reads it.
- What the model saw and what the transcript shows differ by design; the transcript shows the Skill a `/skill:` embedded as a closed disclosure, so the difference stays visible. A `$name` link shows as typed, with no disclosure: the model's message holds only the link.
