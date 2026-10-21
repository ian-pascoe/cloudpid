# Skills and Prompt templates expand when a message is submitted

A message that names a Skill (`/skill:name …` at its start, or `$name` anywhere outside code) or starts with a Prompt template's `/name` is expanded by the Session when it is submitted: the model gets the expansion (the Skill in local pi's `<skill name location>` block, the template with its arguments filled in), and the conversation entry keeps what the owner typed in its `data`, which the transcript, the Session's title and the queue lanes show instead.

## Considered Options

- **Expand at request time**: keep the typed text as the entry and expand it in a `beforeRequest` hook. The transcript would need no display data, but the Skill file would be read again for every request, so editing it mid-Session would change earlier messages, break the prompt cache, and make the model's view of the past differ from what it actually saw.

## Consequences

- A Skill is frozen as it was when the owner named it, as in local pi.
- What the model saw and what the transcript shows differ by design; the transcript shows each expanded Skill as a closed disclosure, so the difference stays visible.
