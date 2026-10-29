// @effect-diagnostics preferEffectArray:off -- JSX lists of options and Roles are native arrays.

// The Settings' sections of the Settings page at either Scope (docs/architecture/client-and-protocol.md → Settings page;
// ADR-0027): General (the Session tree's prompt), Models (the default model and thinking level, and the Roles), Tools
// (the offered tools) and Limits (the spend limit, the subagent depth and the Subagent Workspace limit, and the size
// limit of the Container settings). Each saves only its own fields (`forms.ts`); at an Environment each field is marked
// Inherited or Overridden, a Role by itself (`scoped-view.tsx`).

import {
  INSTANCE_TYPES,
  instanceLimitProblem,
  type InstanceType,
  isModelId,
  type ModelId,
  ROLE_NAMES,
  type RoleName,
  THINKING_LEVELS,
  SUPPORTED_MODELS,
} from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { sizeLimitLabel } from "../environments.ts";
import { cn } from "../lib/utils.ts";
import { modelName } from "../models.ts";
import { badOfferedEntries, offeredFromText } from "../offered-tools.ts";
import { spendLimitFromText } from "../spend-limit.ts";
import {
  generalForm,
  limitsForm,
  modelsForm,
  type Role,
  subagentLimitProblem,
  toolsForm,
} from "./forms.ts";
import { CODE_AREA, Field, Group, SettingsSection, TEXT_AREA } from "./parts.tsx";
import { type FieldBinding, ScopedSectionForm } from "./scoped-view.tsx";

/** What a section's line says of its Scope: at an Environment, that what it does not override follows Global. */
const scopeLine = (scope: string, global: string, environment: string): string =>
  scope === GLOBAL_SCOPE ? global : environment;

const ModelSelect = ({
  id,
  value,
  className,
  onChange,
}: {
  id: string;
  value: ModelId;
  className?: string;
  onChange: (model: ModelId) => void;
}) => (
  <NativeSelect
    id={id}
    value={value}
    className={className}
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
export const GeneralSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="General"
    description={scopeLine(
      scope,
      "How sessions behave, at Global: every environment's sessions, unless it overrides a setting.",
      "How this environment's sessions behave. A setting it does not override follows Global.",
    )}
  >
    <ScopedSectionForm form={generalForm} scope={scope} section="general" invalid={() => false}>
      {(field) => {
        const { mark, note, anchor } = field.marks("branchSummary.skipPrompt");

        return (
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
            <div id={anchor} className="flex scroll-mt-6 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.value("branchSummary.skipPrompt")}
                    onChange={(event) => {
                      field.set("branchSummary.skipPrompt", event.target.checked);
                    }}
                  />
                  Do not ask: leave a session branch without a summary
                </label>
                {mark}
              </div>
              {note}
            </div>
          </Group>
        );
      }}
    </ScopedSectionForm>
  </SettingsSection>
);

type RoleKey = `roles.${RoleName}`;

/** A Role: its model and hint, one field, marked as one at an Environment. */
const RoleFields = ({
  name,
  field,
}: {
  name: RoleName;
  field: FieldBinding<Readonly<Record<RoleKey, Role>>>;
}) => {
  const key: RoleKey = `roles.${name}`;
  const role = field.value(key);
  const { mark, note, anchor } = field.marks(key);

  return (
    <fieldset
      id={anchor}
      className={cn(
        "flex min-w-0 scroll-mt-6 flex-col gap-3 rounded-lg border p-4",
        field.inherited(key) && "border-dashed",
      )}
    >
      <legend className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span className="text-sm font-medium capitalize">{name}</span>
        {mark}
      </legend>
      {note}
      <Field label="Model" htmlFor={`role-${name}-model`}>
        <ModelSelect
          id={`role-${name}-model`}
          value={role.model}
          className={field.look(key)}
          onChange={(model) => {
            field.set(key, { ...role, model });
          }}
        />
      </Field>
      <Field label="When to use it" htmlFor={`role-${name}-hint`}>
        <textarea
          id={`role-${name}-hint`}
          rows={3}
          value={role.hint}
          onChange={(event) => {
            field.set(key, { ...role, hint: event.target.value });
          }}
          className={cn(TEXT_AREA, field.look(key))}
        />
      </Field>
    </fieldset>
  );
};

/** Models: the default model and thinking level, and the model and hint of each Role. */
export const ModelsSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Models"
    description={scopeLine(
      scope,
      "What sessions run with, and what each role uses when work is delegated.",
      "What this environment's sessions run with, and what each role uses when work is delegated. Each role is overridden by itself.",
    )}
  >
    <ScopedSectionForm form={modelsForm} scope={scope} section="models" invalid={() => false}>
      {(field) => (
        <>
          <Group
            title="Default model"
            description="What a session runs with until it picks its own. A change applies to the next request of new and idle sessions."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Model" htmlFor="default-model" {...field.marks("model")}>
                <ModelSelect
                  id="default-model"
                  value={field.value("model")}
                  className={field.look("model")}
                  onChange={(model) => {
                    field.set("model", model);
                  }}
                />
              </Field>
              <Field
                label="Thinking level"
                htmlFor="default-thinking"
                {...field.marks("thinkingLevel")}
              >
                <NativeSelect
                  id="default-thinking"
                  value={field.value("thinkingLevel")}
                  className={field.look("thinkingLevel")}
                  onChange={(event) => {
                    const level = THINKING_LEVELS.find((known) => known === event.target.value);

                    if (level !== undefined) field.set("thinkingLevel", level);
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
                <RoleFields key={name} name={name} field={field} />
              ))}
            </div>
          </Group>
        </>
      )}
    </ScopedSectionForm>
  </SettingsSection>
);

/** Tools: the tools the model is offered from its first request; every other tool is deferred. */
export const ToolsSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Tools"
    description={scopeLine(
      scope,
      "Which tools the model sees from its first request.",
      "Which tools the model sees from its first request in this environment's sessions. The list is overridden as a whole.",
    )}
  >
    <ScopedSectionForm
      form={toolsForm}
      scope={scope}
      section="tools"
      invalid={(fields) =>
        badOfferedEntries(offeredFromText(fields["tools.offered"].value)).length > 0
      }
    >
      {(field) => {
        const text = field.value("tools.offered");
        const offered = offeredFromText(text);
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
              {...field.marks("tools.offered")}
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
                value={text}
                spellCheck={false}
                aria-invalid={bad.length > 0}
                onChange={(event) => {
                  field.set("tools.offered", event.target.value);
                }}
                className={cn(CODE_AREA, field.look("tools.offered"))}
              />
            </Field>
          </Group>
        );
      }}
    </ScopedSectionForm>
  </SettingsSection>
);

/** Why the spend limit typed cannot be saved, or null. */
const spendLimitProblem = (text: string): string | null =>
  spendLimitFromText(text) === undefined
    ? "Enter an amount above zero, such as 5 or 12.50, or leave it empty for no limit."
    : null;

/** Why `maxInstance` cannot be the size limit while the size is `instance` (both in force at the Scope), or null. */
const sizeLimitProblem = (instance: InstanceType | undefined, maxInstance: InstanceType) =>
  instance === undefined ? null : (instanceLimitProblem({ instance, maxInstance }) ?? null);

/**
 * Limits: the most a Session may spend, how deep its subagents may go and how many Subagent Workspaces it may have, and
 * the largest size the Containers may run at. The agent changes any of them only with the owner's Approval.
 */
export const LimitsSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Limits"
    description={scopeLine(
      scope,
      "What a session may spend and run. The agent changes these only with your approval.",
      "What this environment's sessions may spend and run. The agent changes these only with your approval.",
    )}
  >
    <LimitsForm scope={scope} />
  </SettingsSection>
);

const LimitsForm = ({ scope }: { scope: string }) => {
  // The size in force at the Scope, as saved: the size limit may not be below it.
  const instance = useAtomValue(limitsForm.scopeView(scope))?.inForce.container.instance;

  return (
    <ScopedSectionForm
      form={limitsForm}
      scope={scope}
      section="limits"
      invalid={(fields) =>
        spendLimitProblem(fields["spendLimit.perSession"].value) !== null ||
        subagentLimitProblem(
          "maxSubagentDepth",
          fields["extensions.subagents.maxSubagentDepth"].value,
        ) !== null ||
        subagentLimitProblem(
          "maxSubagentWorkspaces",
          fields["extensions.subagents.maxSubagentWorkspaces"].value,
        ) !== null ||
        sizeLimitProblem(instance, fields.maxInstance.value) !== null
      }
    >
      {(field) => {
        const spend = field.value("spendLimit.perSession");
        const depth = field.value("extensions.subagents.maxSubagentDepth");
        const workspaces = field.value("extensions.subagents.maxSubagentWorkspaces");
        const maxInstance = field.value("maxInstance");

        return (
          <>
            <Group
              title="Spend limit"
              description="The most a session may spend on model requests, in US dollars, its subagents and its title included. A session at its limit refuses its next request and ends the run with a message; raise or clear the limit and prompt again to go on."
            >
              <Field
                label="Per session (USD)"
                htmlFor="spend-limit"
                hint="Leave it empty for no limit."
                problem={spendLimitProblem(spend)}
                {...field.marks("spendLimit.perSession")}
              >
                <Input
                  id="spend-limit"
                  inputMode="decimal"
                  value={spend}
                  placeholder="No limit"
                  aria-invalid={spendLimitProblem(spend) !== null}
                  onChange={(event) => {
                    field.set("spendLimit.perSession", event.target.value);
                  }}
                  className={cn("sm:max-w-48", field.look("spendLimit.perSession"))}
                />
              </Field>
            </Group>
            <Group
              title="Subagents"
              description="How far a session may delegate. Subagents and Subagent Workspaces that exist keep what they started with."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Subagent depth"
                  htmlFor="subagent-depth"
                  hint="Levels of subagents below a session's root: 1 for its children only, 2 for their children too. A deeper tree can spend more at once."
                  problem={subagentLimitProblem("maxSubagentDepth", depth)}
                  {...field.marks("extensions.subagents.maxSubagentDepth")}
                >
                  <Input
                    id="subagent-depth"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={depth}
                    aria-invalid={subagentLimitProblem("maxSubagentDepth", depth) !== null}
                    onChange={(event) => {
                      field.set("extensions.subagents.maxSubagentDepth", event.target.value);
                    }}
                    className={cn(
                      "sm:max-w-48",
                      field.look("extensions.subagents.maxSubagentDepth"),
                    )}
                  />
                </Field>
                <Field
                  label="Subagent Workspace limit"
                  htmlFor="subagent-workspaces"
                  hint="Subagent Workspaces one session may have at once, each with a Container of its own that costs while it runs. 0 for none."
                  problem={subagentLimitProblem("maxSubagentWorkspaces", workspaces)}
                  {...field.marks("extensions.subagents.maxSubagentWorkspaces")}
                >
                  <Input
                    id="subagent-workspaces"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={workspaces}
                    aria-invalid={
                      subagentLimitProblem("maxSubagentWorkspaces", workspaces) !== null
                    }
                    onChange={(event) => {
                      field.set("extensions.subagents.maxSubagentWorkspaces", event.target.value);
                    }}
                    className={cn(
                      "sm:max-w-48",
                      field.look("extensions.subagents.maxSubagentWorkspaces"),
                    )}
                  />
                </Field>
              </div>
            </Group>
            <Group title="Size limit">
              <Field
                label="Size limit"
                htmlFor="max-instance"
                problem={sizeLimitProblem(instance, maxInstance)}
                hint="The largest the size may be, and the largest the agent may restart a Workspace's Container at (container_resize) until it is stopped for being idle. Sizes are ordered by memory, then vCPU."
                {...field.marks("maxInstance")}
              >
                <NativeSelect
                  id="max-instance"
                  value={maxInstance}
                  aria-invalid={sizeLimitProblem(instance, maxInstance) !== null}
                  className={field.look("maxInstance")}
                  onChange={(event) => {
                    const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

                    if (picked !== undefined) field.set("maxInstance", picked);
                  }}
                >
                  {INSTANCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {sizeLimitLabel(type)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </Group>
          </>
        );
      }}
    </ScopedSectionForm>
  );
};
