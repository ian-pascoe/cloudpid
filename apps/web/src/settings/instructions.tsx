// The Instructions section of the Settings page (docs/architecture/client-and-protocol.md → Settings page;
// docs/architecture/workspace.md → Instructions): Global's, what every conversation's agent is told. Instructions add up
// rather than being overridden (ADR-0027), so the section is Global's only and carries no Inherited or Overridden mark;
// it saves only its own field (`forms.ts`).

import {
  instructionsProblem,
  MAX_INSTRUCTIONS_BYTES,
  utf8Bytes,
} from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { cn } from "../lib/utils.ts";
import { instructionsForm } from "./forms.ts";
import { CODE_AREA, Field, Group, noteId, SettingsSection } from "./parts.tsx";
import { ScopedSectionForm } from "./scoped-view.tsx";

const bytes = (count: number): string => count.toLocaleString("en-US");

/** Instructions: Global's, which every session's agent reads at the start of each context. */
export const InstructionsSection = () => (
  <SettingsSection
    title="Instructions"
    description={
      <>
        What the agent is told in every session. A repository's own instructions (
        <code>AGENTS.md</code>) win where the two disagree. The agent can propose a change too,
        which you approve in its session.
      </>
    }
  >
    <ScopedSectionForm
      form={instructionsForm}
      scope={GLOBAL_SCOPE}
      section="instructions"
      invalid={(fields) => instructionsProblem(fields.instructions.value) !== undefined}
    >
      {(field) => {
        const instructions = field.value("instructions");
        const size = utf8Bytes(instructions);
        const over = size - MAX_INSTRUCTIONS_BYTES;

        return (
          <Group>
            <Field
              label="Global instructions"
              htmlFor="instructions"
              hint="An edit applies from each session's next context: a new session, a handoff or a rollover. A context already open keeps the instructions it started with."
              problem={
                over > 0
                  ? `${bytes(over)} ${over === 1 ? "byte" : "bytes"} too long: the instructions may be at most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8.`
                  : null
              }
            >
              <textarea
                id="instructions"
                rows={18}
                value={instructions}
                placeholder={"Answer in British English.\nUse Conventional Commits."}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={over > 0}
                aria-describedby={`instructions-size ${noteId("instructions")}`}
                onChange={(event) => {
                  field.set("instructions", event.target.value);
                }}
                className={cn(CODE_AREA, "resize-y")}
              />
              <p
                id="instructions-size"
                className={cn(
                  "self-end text-xs tabular-nums",
                  over > 0 ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {bytes(size)} / {bytes(MAX_INSTRUCTIONS_BYTES)} bytes
              </p>
            </Field>
          </Group>
        );
      }}
    </ScopedSectionForm>
  </SettingsSection>
);
