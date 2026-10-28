// The Variables section of the Settings page: the variables kept Global, or an Environment's own, a `NAME=value` line
// each (docs/architecture/container.md → Container settings). They are plain, as the agent can read them; an
// Environment's own variable wins over Global's of the same name. Each Scope's saves only its own variables
// (`forms.ts`).

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { globalSettingsErrorAtom, globalVariablesAtom } from "../environments-state.ts";
import { inheritedVariables, parseVariables } from "../environments.ts";
import { environmentVariablesForm, globalVariablesForm } from "./forms.ts";
import { CodeField, Group, SectionFormView, SettingsSection } from "./parts.tsx";

/** Why `text` cannot be saved as variables (beside `inherited`, which count toward the limit), or null. */
const problemOf = (text: string, inherited?: Readonly<Record<string, string>>): string | null => {
  const parsed = parseVariables(text, inherited);

  return Result.isFailure(parsed) ? parsed.failure : null;
};

const GlobalVariables = () => {
  const loadError = useAtomValue(globalSettingsErrorAtom);

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
            {inherited.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Also from Global: <span className="font-mono">{Arr.join(inherited, ", ")}</span>
              </p>
            )}
            {overridden.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Overrides the Global one:{" "}
                <span className="font-mono">{Arr.join(overridden, ", ")}</span>
              </p>
            )}
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
