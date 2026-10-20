// The `context` extension (`docs/spec.md` → Context management): pi-context-management's `context_notes`,
// `context_history`, and `context_rollover`, rebuilt on pi-durable. Notes are a conversation document, History reads
// stored entries, and Rollover hands off with `control: { handoff }`; a `beforeCompact` hook turns a background
// threshold compaction into a Rollover request, and a compaction that cannot wait into an Emergency Rollover.
import { effectSection, type Harness } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import { ContextRollover, PrepareRollover } from "./context/rollover.ts";
import { CONTEXT_GUIDELINES, ContextHistory, ContextNotes } from "./context/tools.ts";

export const extensionName = "context";

export { ContextDoc, type ContextState, type Note } from "./context/notes.ts";

export { CONTINUE_ENTRY, PREPARE_ENTRY } from "./context/rollover.ts";

/** The guideline of each context tool the request offers, as pi-context-management adds them to the prompt. */
const Guidelines = effectSection("context_management", (input) =>
  Effect.sync(() => {
    const lines = Arr.flatMap(Record.toEntries(CONTEXT_GUIDELINES), ([tool, line]) =>
      Arr.some(input.agent.tools, (offered) => offered.name === tool) ? [`- ${line}`] : [],
    );

    return lines.length === 0 ? undefined : Arr.join(lines, "\n");
  }),
);

/**
 * The `context` extension. Its compaction hook asks the agent to prepare a Rollover through the Session's `Harness`,
 * so a conversation without `context_rollover` keeps pi-durable's own compaction.
 */
export const ContextManagement: Effect.Effect<Extension, never, Harness> = Effect.map(
  Effect.all([ContextNotes, ContextHistory, ContextRollover, PrepareRollover, Guidelines]),
  ([notes, history, rollover, prepare, guidelines]) =>
    defineExtension({
      name: extensionName,
      tools: [notes, history, rollover],
      hooks: [prepare],
      sections: [guidelines],
    }),
);
