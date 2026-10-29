// @effect-diagnostics preferEffectArray:off -- JSX lists of options and Roles are native arrays.

// Global's sections of the Settings (docs/architecture/client-and-protocol.md → Settings page): General (the Session
// tree's prompt), Instructions (what every conversation's agent is told; docs/architecture/workspace.md →
// Instructions), Models (the default model and thinking level, and the Roles), Tools (the offered tools) and Limits
// (the spend limit). Each saves only its own fields (`forms.ts`); the Settings' problem, if the Registry reports one,
// shows above each.

import {
  instructionsProblem,
  isModelId,
  MAX_INSTRUCTIONS_BYTES,
  type ModelId,
  ROLE_NAMES,
  type RoleName,
  type Settings,
  SUPPORTED_MODELS,
  THINKING_LEVELS,
  utf8Bytes,
} from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { modelName } from "../models.ts";
import { badOfferedEntries, offeredFromText } from "../offered-tools.ts";
import { settingsStateAtom } from "../settings.ts";
import { spendLimitFromText } from "../spend-limit.ts";
import { generalForm, globalLimitsForm, instructionsForm, modelsForm, toolsForm } from "./forms.ts";
import {
  CODE_AREA,
  Field,
  Group,
  noteId,
  SectionFormView,
  SettingsSection,
  TEXT_AREA,
} from "./parts.tsx";

/** The problem the Registry reports with the Settings, if any. */
const SettingsProblem = () => {
  const state = useAtomValue(settingsStateAtom);

  return <DialogProblem problem={state?.problem ?? null} />;
};

const ModelSelect = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ModelId;
  onChange: (model: ModelId) => void;
}) => (
  <NativeSelect
    id={id}
    value={value}
    onChange={(event) => {
      if (isModelId(event.target.value)) onChange(event.target.value);
    }}
  >
    {SUPPORTED_MODELS.map((model) => (
      <option key={model} value={model}>
        {modelName(model)}
      </option>
    ))}
  </NativeSelect>
);

/** General: whether a move in the Session tree asks about a summary of the branch left. */
export const GeneralSection = () => (
  <SettingsSection
    title="General"
    description="How sessions behave, at Global: these apply to every session."
  >
    <SettingsProblem />
    <SectionFormView form={generalForm} scope={GLOBAL_SCOPE} invalid={() => false}>
      {(fields, set) => (
        <Group
          title="Session tree"
          description={
            <>
              Going to another point of a session's tree (<code>/tree</code>, the Branch button)
              asks whether to carry a summary of the session branch left, which is a model request
              on the session's usage.
            </>
          }
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fields.skipPrompt}
              onChange={(event) => {
                set({ skipPrompt: event.target.checked });
              }}
            />
            Do not ask: leave a session branch without a summary
          </label>
        </Group>
      )}
    </SectionFormView>
  </SettingsSection>
);

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
    <SettingsProblem />
    <SectionFormView
      form={instructionsForm}
      scope={GLOBAL_SCOPE}
      invalid={(fields) => instructionsProblem(fields.instructions) !== undefined}
    >
      {(fields, set) => {
        const size = utf8Bytes(fields.instructions);
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
                value={fields.instructions}
                placeholder={"Answer in British English.\nUse Conventional Commits."}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={over > 0}
                aria-describedby={`instructions-size ${noteId("instructions")}`}
                onChange={(event) => {
                  set({ instructions: event.target.value });
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
    </SectionFormView>
  </SettingsSection>
);

const RoleFields = ({
  name,
  role,
  onChange,
}: {
  name: RoleName;
  role: Settings["roles"][RoleName];
  onChange: (role: Settings["roles"][RoleName]) => void;
}) => (
  <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
    <legend className="px-1 text-sm font-medium capitalize">{name}</legend>
    <Field label="Model" htmlFor={`role-${name}-model`}>
      <ModelSelect
        id={`role-${name}-model`}
        value={role.model}
        onChange={(model) => {
          onChange({ ...role, model });
        }}
      />
    </Field>
    <Field label="When to use it" htmlFor={`role-${name}-hint`}>
      <textarea
        id={`role-${name}-hint`}
        rows={3}
        value={role.hint}
        onChange={(event) => {
          onChange({ ...role, hint: event.target.value });
        }}
        className={TEXT_AREA}
      />
    </Field>
  </fieldset>
);

/** Models: the default model and thinking level, and the model and hint of each Role. */
export const ModelsSection = () => (
  <SettingsSection
    title="Models"
    description="What sessions run with, and what each role uses when work is delegated."
  >
    <SettingsProblem />
    <SectionFormView form={modelsForm} scope={GLOBAL_SCOPE} invalid={() => false}>
      {(fields, set) => (
        <>
          <Group
            title="Default model"
            description="What a session runs with until it picks its own. A change applies to the next request of new and idle sessions."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Model" htmlFor="default-model">
                <ModelSelect
                  id="default-model"
                  value={fields.model}
                  onChange={(model) => {
                    set({ ...fields, model });
                  }}
                />
              </Field>
              <Field label="Thinking level" htmlFor="default-thinking">
                <NativeSelect
                  id="default-thinking"
                  value={fields.thinkingLevel}
                  onChange={(event) => {
                    const level = THINKING_LEVELS.find((known) => known === event.target.value);

                    if (level !== undefined) set({ ...fields, thinkingLevel: level });
                  }}
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          </Group>
          <Group
            title="Model roles"
            description="The model each role uses when work is delegated, and the hint that tells an agent when to pick it."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              {ROLE_NAMES.map((name) => (
                <RoleFields
                  key={name}
                  name={name}
                  role={fields.roles[name]}
                  onChange={(role) => {
                    set({ ...fields, roles: { ...fields.roles, [name]: role } });
                  }}
                />
              ))}
            </div>
          </Group>
        </>
      )}
    </SectionFormView>
  </SettingsSection>
);

/** Tools: the tools the model is offered from its first request; every other tool is deferred. */
export const ToolsSection = () => (
  <SettingsSection title="Tools" description="Which tools the model sees from its first request.">
    <SettingsProblem />
    <SectionFormView
      form={toolsForm}
      scope={GLOBAL_SCOPE}
      invalid={(fields) => badOfferedEntries(offeredFromText(fields.offered)).length > 0}
    >
      {(fields, set) => {
        const offered = offeredFromText(fields.offered);
        const bad = badOfferedEntries(offered);

        return (
          <Group
            title="Offered tools"
            description={
              <>
                One name per line (<code>*</code> matches any run of characters, as in{" "}
                <code>context_*</code>). Every other tool is deferred: the model finds it with{" "}
                <code>tool_search</code>, which is always offered, as is{" "}
                <code>context_rollover</code>, and scripts in <code>codemode</code> call it without
                loading it. A change applies to the next request of new and idle sessions.
              </>
            }
          >
            <Field
              label="Tools"
              htmlFor="offered-tools"
              problem={
                bad.length === 0
                  ? null
                  : `Not a tool name: ${bad.join(", ")}. Use lowercase letters, digits, underscores, and *.`
              }
              hint={
                offered.length === 0 ? (
                  <>
                    Nothing is listed, so the model is offered only <code>tool_search</code> and{" "}
                    <code>context_rollover</code> and must search for every other tool.
                  </>
                ) : undefined
              }
            >
              <textarea
                id="offered-tools"
                rows={Math.min(Math.max(offered.length + 1, 4), 16)}
                value={fields.offered}
                spellCheck={false}
                aria-invalid={bad.length > 0}
                onChange={(event) => {
                  set({ offered: event.target.value });
                }}
                className={CODE_AREA}
              />
            </Field>
          </Group>
        );
      }}
    </SectionFormView>
  </SettingsSection>
);

/** Global's Limits: the most a Session may spend on model requests. */
export const GlobalLimitsSection = () => (
  <SettingsSection title="Limits" description="What a session may spend before it stops.">
    <SettingsProblem />
    <SectionFormView
      form={globalLimitsForm}
      scope={GLOBAL_SCOPE}
      invalid={(fields) => spendLimitFromText(fields.spendLimit) === undefined}
    >
      {(fields, set) => (
        <Group
          title="Spend limit"
          description="The most a session may spend on model requests, in US dollars, its subagents and its title included. A session at its limit refuses its next request and ends the run with a message; raise or clear the limit and prompt again to go on."
        >
          <Field
            label="Per session (USD)"
            htmlFor="spend-limit"
            hint="Leave it empty for no limit."
            problem={
              spendLimitFromText(fields.spendLimit) === undefined
                ? "Enter an amount above zero, such as 5 or 12.50, or leave it empty for no limit."
                : null
            }
          >
            <Input
              id="spend-limit"
              inputMode="decimal"
              value={fields.spendLimit}
              placeholder="No limit"
              aria-invalid={spendLimitFromText(fields.spendLimit) === undefined}
              onChange={(event) => {
                set({ spendLimit: event.target.value });
              }}
              className="sm:max-w-48"
            />
          </Field>
        </Group>
      )}
    </SectionFormView>
  </SettingsSection>
);
