// The Variables section of the Settings page: the variables kept Global, or an Environment's own, a `NAME=value` line
// each (docs/architecture/container.md → Container settings). They are plain, as the agent can read them; an
// Environment's own variable wins over Global's of the same name. Each Scope's saves only its own variables
// (`forms.ts`). As the other sections' fields are (ADR-0027), an Environment's list marks the names it inherits and
// those it overrides, and Global's names the Environments that override each of its variables.

import { fieldVariable, GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Record from "effect/Record";
import { DialogProblem } from "../components/ui/dialog.tsx";
import {
  globalSettingsAtom,
  globalSettingsErrorAtom,
  globalVariablesAtom,
} from "../environments-state.ts";
import { inheritedVariables, parseVariables } from "../environments.ts";
import { settingsPath } from "../router.ts";
import { environmentVariablesForm, globalVariablesForm } from "./forms.ts";
import {
  CodeField,
  Group,
  MarkedNames,
  OverriddenIn,
  SectionFormView,
  SettingsSection,
} from "./parts.tsx";

/** Why `text` cannot be saved as variables (beside `inherited`, which count toward the limit), or null. */
const problemOf = (text: string, inherited?: Readonly<Record<string, string>>): string | null => {
  const parsed = parseVariables(text, inherited);

  return Result.isFailure(parsed) ? parsed.failure : null;
};

/** At Global, each variable that Environments override, with them: `variables.NAME` fields of the saved state. */
const useOverriddenVariables = () =>
  useAtomValue(globalSettingsAtom).pipe(
    AsyncResult.value,
    Option.map((state) =>
      Arr.filterMap(Record.toEntries(state.overriddenIn), ([field, environments]) => {
        const name = fieldVariable(field);

        return name === null ? Result.failVoid : Result.succeed({ name, environments });
      }),
    ),
    Option.getOrElse(() => []),
  );

const GlobalVariables = () => {
  const loadError = useAtomValue(globalSettingsErrorAtom);
  const overridden = useOverriddenVariables();

  return (
    <>
      <DialogProblem problem={loadError} />
      <SectionFormView
        form={globalVariablesForm}
        scope={GLOBAL_SCOPE}
        invalid={(fields) => problemOf(fields.variables) !== null}
      >
        {(fields, set) => (
          <Group>
            <CodeField
              id="variables-global"
              label="Variables (NAME=value, one per line)"
              rows={6}
              value={fields.variables}
              placeholder={"NODE_ENV=development\nCI=1"}
              problem={problemOf(fields.variables)}
              hint="Every command, Setup Script and Start Script gets them, at its next Container start. An environment's own variable of the same name wins."
              onChange={(variables) => {
                set({ variables });
              }}
            />
            {Arr.map(overridden, ({ name, environments }) => (
              <OverriddenIn
                key={name}
                subject={<span className="font-mono text-foreground">{name}: </span>}
                environments={environments}
                pathAt={(environment) => settingsPath(environment, "variables")}
              />
            ))}
          </Group>
        )}
      </SectionFormView>
    </>
  );
};

const EnvironmentVariables = ({ scope }: { scope: string }) => {
  const globalVariables = useAtomValue(globalVariablesAtom);

  return (
    <SectionFormView
      form={environmentVariablesForm}
      scope={scope}
      invalid={(fields) => problemOf(fields.variables, globalVariables) !== null}
    >
      {(fields, set) => {
        const typed = Result.getOrElse(parseVariables(fields.variables), () => ({}));
        const { inherited, overridden } = inheritedVariables(typed, globalVariables);

        return (
          <Group>
            <CodeField
              id={`variables-${scope}`}
              label="Variables (NAME=value, one per line)"
              rows={6}
              value={fields.variables}
              placeholder={"NODE_ENV=development\nDATABASE_URL=postgres://localhost/app"}
              problem={problemOf(fields.variables, globalVariables)}
              hint="Every command, Setup Script and Start Script gets them, at its next Container start."
              onChange={(variables) => {
                set({ variables });
              }}
            />
            <MarkedNames kind="inherited" names={inherited} />
            <MarkedNames kind="overridden" names={overridden} />
          </Group>
        );
      }}
    </SectionFormView>
  );
};

/** The Variables section at Scope `scope`. */
export const VariablesSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Variables"
    description="Plain values every command gets. The agent can read them, so keep a secret value in Secrets instead."
  >
    {scope === GLOBAL_SCOPE ? <GlobalVariables /> : <EnvironmentVariables scope={scope} />}
  </SettingsSection>
);
