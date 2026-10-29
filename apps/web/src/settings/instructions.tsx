// The Instructions section of the Settings page (docs/architecture/client-and-protocol.md → Settings page;
// docs/architecture/workspace.md → Instructions): what the agent is told, kept per Scope. Instructions add up rather
// than being overridden (ADR-0027): an Environment's Sessions are shown Global's, then the Environment's own. So the
// section carries no Inherited or Overridden mark and no Reset; at an Environment it shows Global's text, read-only with
// a link to edit it at Global, above the Environment's own. Each Scope saves only its own text (`forms.ts`).

import { instructionsProblem, MAX_INSTRUCTIONS_BYTES, utf8Bytes } from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { settingsPath } from "../router.ts";
import { settingsOverridesAtom } from "../settings.ts";
import { environmentInstructionsForm, instructionsForm } from "./forms.ts";
import { CODE_AREA, Field, Group, noteId, SectionFormView, SettingsSection } from "./parts.tsx";
import { ScopedSectionForm } from "./scoped-view.tsx";

const bytes = (count: number): string => count.toLocaleString("en-US");

const APPLIES =
  "An edit applies from each session's next context: a new session, a handoff or a rollover. A context already open keeps the instructions it started with.";

/** One Scope's text box, with its size against the cap under it, and its problem once it is over. */
const InstructionsField = ({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) => {
  const size = utf8Bytes(value);
  const over = size - MAX_INSTRUCTIONS_BYTES;

  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      problem={
        over > 0
          ? `${bytes(over)} ${over === 1 ? "byte" : "bytes"} too long: the instructions may be at most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8.`
          : null
      }
    >
      <textarea
        id={id}
        rows={18}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore
        aria-invalid={over > 0}
        aria-describedby={`${id}-size ${noteId(id)}`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(CODE_AREA, "resize-y")}
      />
      <p
        id={`${id}-size`}
        className={cn(
          "self-end text-xs tabular-nums",
          over > 0 ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {bytes(size)} / {bytes(MAX_INSTRUCTIONS_BYTES)} bytes
      </p>
    </Field>
  );
};

const GlobalInstructions = () => (
  <ScopedSectionForm
    form={instructionsForm}
    scope={GLOBAL_SCOPE}
    section="instructions"
    invalid={(fields) => instructionsProblem(fields.instructions.value) !== undefined}
  >
    {(field) => (
      <Group>
        <InstructionsField
          id="instructions"
          label="Global instructions"
          hint={`Every environment's sessions are shown them, then that environment's own. ${APPLIES}`}
          value={field.value("instructions")}
          placeholder={"Answer in British English.\nUse Conventional Commits."}
          onChange={(instructions) => {
            field.set("instructions", instructions);
          }}
        />
      </Group>
    )}
  </ScopedSectionForm>
);

/**
 * Global's Instructions as an Environment's Sessions are shown them first: read-only, in a dashed frame as what comes
 * from Global is, with a link to edit them at Global.
 */
const FromGlobal = ({ text }: { text: string }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h3 id="instructions-global-label" className="text-sm font-medium">
        From Global
      </h3>
      <InAppLink
        href={settingsPath(GLOBAL_SCOPE, "instructions")}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Edit at Global
      </InAppLink>
    </div>
    {text === "" ? (
      <p className="rounded-md border border-dashed border-input px-2.5 py-2 text-sm text-muted-foreground">
        None at Global.
      </p>
    ) : (
      // A region of its own that scrolls: Global's text may be long, and the keyboard reaches it to scroll it.
      <pre
        role="region"
        aria-labelledby="instructions-global-label"
        tabIndex={0}
        className="max-h-72 min-w-0 overflow-auto rounded-md border border-dashed border-input px-2.5 py-2 font-mono text-sm break-words whitespace-pre-wrap text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {text}
      </pre>
    )}
  </div>
);

const EnvironmentInstructions = ({ scope }: { scope: string }) => {
  // Global's text, as the Environment's Settings carry it: on the key the form asks again after a save.
  const globalText = useAtomValue(settingsOverridesAtom(scope)).pipe(
    AsyncResult.value,
    Option.match({ onNone: () => "", onSome: (state) => state.global.instructions }),
  );

  return (
    <SectionFormView
      form={environmentInstructionsForm}
      scope={scope}
      invalid={(fields) => instructionsProblem(fields.instructions) !== undefined}
    >
      {(fields, set) => (
        <Group>
          <FromGlobal text={globalText} />
          <InstructionsField
            id={`instructions-${scope}`}
            label="This environment's instructions"
            hint={`Shown after the global ones, to this environment's sessions only; where the two disagree, these win. ${APPLIES}`}
            value={fields.instructions}
            placeholder={"Run the tests with pnpm test:unit.\nDeploy only from main."}
            onChange={(instructions) => {
              set({ instructions });
            }}
          />
        </Group>
      )}
    </SectionFormView>
  );
};

/** Instructions at Scope `scope`: Global's, or an Environment's own below Global's, which its sessions are shown first. */
export const InstructionsSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Instructions"
    description={
      scope === GLOBAL_SCOPE ? (
        <>
          What the agent is told in every session. A repository's own instructions (
          <code>AGENTS.md</code>) win where they disagree. The agent can propose a change too, which
          you approve in its session.
        </>
      ) : (
        <>
          What the agent is told in this environment's sessions, after the global instructions:
          where the two disagree, this environment's win. A repository's own instructions (
          <code>AGENTS.md</code>) win over both. The agent can propose a change too, which you
          approve in its session.
        </>
      )
    }
  >
    {scope === GLOBAL_SCOPE ? <GlobalInstructions /> : <EnvironmentInstructions scope={scope} />}
  </SettingsSection>
);
