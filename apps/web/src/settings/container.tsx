// @effect-diagnostics preferEffectArray:off -- JSX lists of sizes are native arrays.

// An Environment's sections of its Container settings on the Settings page (docs/architecture/container.md → Container
// settings, Builds): Container (the size, the idle time, the Container-only paths, the Spare Workspace, and the Build),
// Setup (the Toolchains and the Setup and Start Scripts) and Limits (the size limit). Each saves only its own fields
// (`forms.ts`); they apply at each Workspace's next Container start.

import { INSTANCE_TYPES, instanceLimitProblem, type InstanceType } from "@cloudpid/config";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { RotateCw } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import {
  containerSettingsAtom,
  environmentBuildAtom,
  environmentSettingsAtom,
  rebuildEnvironmentAtom,
} from "../environments-state.ts";
import {
  buildLine,
  idleMinutesProblem,
  ignoreProblem,
  instanceLabel,
  scriptFieldProblem,
  sizeLimitLabel,
  toolchainsFieldProblem,
} from "../environments.ts";
import { settledFailureOf } from "../registry.ts";
import { containerSectionForm, environmentLimitsForm, setupForm } from "./forms.ts";
import { CODE_AREA, CodeField, Field, Group, SectionFormView, SettingsSection } from "./parts.tsx";

/** The problem the Registry reports with Environment `scope`'s Container settings, if any. */
const ContainerProblem = ({ scope }: { scope: string }) => {
  const state = useAtomValue(environmentSettingsAtom(scope)).pipe(
    AsyncResult.value,
    Option.getOrNull,
  );

  return <DialogProblem problem={state?.problem ?? null} />;
};

/** A list of the sizes, by `label`, as `INSTANCE_TYPES` orders them. */
const SizeSelect = ({
  id,
  value,
  label,
  onPick,
  invalid = false,
}: {
  id: string;
  value: InstanceType;
  label: (type: InstanceType) => string;
  onPick: (type: InstanceType) => void;
  invalid?: boolean;
}) => (
  <NativeSelect
    id={id}
    value={value}
    aria-invalid={invalid}
    onChange={(event) => {
      const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

      if (picked !== undefined) onPick(picked);
    }}
  >
    {INSTANCE_TYPES.map((type) => (
      <option key={type} value={type}>
        {label(type)}
      </option>
    ))}
  </NativeSelect>
);

/** Environment `scope`'s saved Container settings, for a check against a field of another section; null until loaded. */
const useSaved = (scope: string) =>
  useAtomValue(containerSettingsAtom(scope)).pipe(AsyncResult.value, Option.getOrNull);

/** Why `instance` is above `maxInstance`, or null. */
const limitProblem = (instance: InstanceType, maxInstance: InstanceType | undefined) =>
  maxInstance === undefined ? null : (instanceLimitProblem({ instance, maxInstance }) ?? null);

/** Environment `id`'s Build: where it stands, and a button to make it again now. */
const BuildStatus = ({ id }: { id: string }) => {
  const build = useAtomValue(environmentBuildAtom(id));
  const [rebuilt, rebuild] = useAtom(rebuildEnvironmentAtom(id));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {/* A Build's times are read against the wall clock as the section renders. */}
          {/* @effect-diagnostics-next-line globalDate:off */}
          {build === null ? "Loading…" : buildLine(build, Date.now())}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rebuilt.waiting || build?.status === "building"}
          onClick={() => {
            rebuild();
          }}
        >
          <RotateCw aria-hidden />
          Rebuild
        </Button>
      </div>
      <DialogProblem problem={settledFailureOf(rebuilt)} />
    </div>
  );
};

/** An Environment's Container: its size, idle time, Container-only paths and Spare Workspace, and its Build. */
export const ContainerSection = ({ scope }: { scope: string }) => {
  const saved = useSaved(scope);

  return (
    <SettingsSection
      title="Container"
      description="What each workspace's Container is like. A change applies the next time a workspace's Container starts: a running one keeps what it started with."
    >
      <ContainerProblem scope={scope} />
      <SectionFormView
        form={containerSectionForm}
        scope={scope}
        invalid={(fields) =>
          idleMinutesProblem(fields.idle) !== null ||
          ignoreProblem(fields.ignore) !== null ||
          limitProblem(fields.instance, saved?.maxInstance) !== null
        }
      >
        {(fields, set) => (
          <>
            <Group
              title="Size"
              description="A saved disk larger than a smaller size's disk cannot be restored there; the Container then starts from scratch."
            >
              <Field
                label="Size"
                htmlFor={`instance-${scope}`}
                problem={limitProblem(fields.instance, saved?.maxInstance)}
                hint="At most the size limit, in Limits."
              >
                <SizeSelect
                  id={`instance-${scope}`}
                  value={fields.instance}
                  label={instanceLabel}
                  invalid={limitProblem(fields.instance, saved?.maxInstance) !== null}
                  onPick={(instance) => {
                    set({ ...fields, instance });
                  }}
                />
              </Field>
              <Field
                label="Stop after (minutes without a command)"
                htmlFor={`idle-${scope}`}
                problem={idleMinutesProblem(fields.idle)}
              >
                <Input
                  id={`idle-${scope}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={fields.idle}
                  aria-invalid={idleMinutesProblem(fields.idle) !== null}
                  onChange={(event) => {
                    set({ ...fields, idle: event.target.value });
                  }}
                  className="sm:max-w-48"
                />
              </Field>
            </Group>
            <Group
              title="Container-only paths"
              description="Kept on the Container, out of the Workspace, like node_modules. One saved with other paths is not restored; the Container then starts from scratch."
            >
              <Field
                label="More Container-only paths (one per line)"
                htmlFor={`paths-${scope}`}
                problem={ignoreProblem(fields.ignore)}
                hint="Start with / (from /workspace) or **/ (at any depth); a line starting with ! keeps a path synced. What a Workspace already holds there stays until it is deleted."
              >
                <textarea
                  id={`paths-${scope}`}
                  rows={3}
                  value={fields.ignore}
                  placeholder={"/data\n**/.gradle-cache"}
                  spellCheck={false}
                  aria-invalid={ignoreProblem(fields.ignore) !== null}
                  onChange={(event) => {
                    set({ ...fields, ignore: event.target.value });
                  }}
                  className={CODE_AREA}
                />
              </Field>
            </Group>
            <Group title="Spare Workspace">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`spare-${scope}`}
                  className="flex items-center gap-2 text-sm font-medium"
                >
                  <input
                    id={`spare-${scope}`}
                    type="checkbox"
                    checked={fields.spareWorkspace}
                    onChange={(event) => {
                      set({ ...fields, spareWorkspace: event.target.checked });
                    }}
                  />
                  Keep a Spare Workspace ready
                </label>
                <p className="max-w-prose text-xs text-muted-foreground">
                  A new session starts without waiting for the clones and Setup Scripts, at the cost
                  of the minute or two of Container time each spare takes to prepare.
                </p>
              </div>
            </Group>
          </>
        )}
      </SectionFormView>
      <Group
        title="Build"
        description="A snapshot of a Container with the repos cloned and the Setup Scripts run, so a new workspace starts from it."
      >
        <BuildStatus id={scope} />
      </Group>
    </SettingsSection>
  );
};

/** An Environment's Setup: its Toolchains (a mise.toml), and its Setup and Start Scripts. */
export const SetupSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Setup"
    description="What every Container start gets. These apply the next time a workspace's Container starts. Commands wait for the scripts; one that fails is reported to the first command and does not stop the others."
  >
    <ContainerProblem scope={scope} />
    <SectionFormView
      form={setupForm}
      scope={scope}
      invalid={(fields) =>
        toolchainsFieldProblem(fields.toolchains) !== null ||
        scriptFieldProblem(fields.setupScript) !== null ||
        scriptFieldProblem(fields.startScript) !== null
      }
    >
      {(fields, set) => (
        <>
          <Group title="Toolchains">
            <CodeField
              id={`toolchains-${scope}`}
              label="Toolchains (mise.toml)"
              rows={5}
              value={fields.toolchains}
              placeholder={'[tools]\nnode = "24.22.1"\npnpm = "12.15.0"\npython = "3.14.9"'}
              problem={toolchainsFieldProblem(fields.toolchains)}
              hint="Written as /workspace/mise.toml where a Workspace has none, or still has the copy written last; a Workspace's own edits to the file stay. Empty: the image's base Toolchains (git, gh, Node, pnpm, Python, uv). A Build installs them."
              onChange={(toolchains) => {
                set({ ...fields, toolchains });
              }}
            />
          </Group>
          <Group title="Scripts">
            <CodeField
              id={`setup-${scope}`}
              label="Setup Script (bash)"
              rows={4}
              value={fields.setupScript}
              placeholder="sudo apt-get install -y postgresql-client"
              problem={scriptFieldProblem(fields.setupScript)}
              hint="Runs in /workspace before the repos' .cloudpid/setup.sh, to install what the Workspace needs. It runs again only when it changes, or after it failed."
              onChange={(setupScript) => {
                set({ ...fields, setupScript });
              }}
            />
            <CodeField
              id={`start-${scope}`}
              label="Start Script (bash)"
              rows={4}
              value={fields.startScript}
              placeholder={"setsid nohup docker compose up >/tmp/compose.log 2>&1 &"}
              problem={scriptFieldProblem(fields.startScript)}
              hint="Runs in /workspace at every Container start, before the repos' .cloudpid/start.sh, and is stopped after 5 minutes. A service it starts must detach (setsid nohup cmd >/tmp/cmd.log 2>&1 &), or the script does not end."
              onChange={(startScript) => {
                set({ ...fields, startScript });
              }}
            />
          </Group>
        </>
      )}
    </SectionFormView>
  </SettingsSection>
);

/** An Environment's Limits: the largest size its Containers may run at. */
export const EnvironmentLimitsSection = ({ scope }: { scope: string }) => {
  const saved = useSaved(scope);

  const problemOf = (maxInstance: InstanceType) =>
    saved === null ? null : limitProblem(saved.instance, maxInstance);

  return (
    <SettingsSection title="Limits" description="How large this environment's Containers may be.">
      <ContainerProblem scope={scope} />
      <SectionFormView
        form={environmentLimitsForm}
        scope={scope}
        invalid={(fields) => problemOf(fields.maxInstance) !== null}
      >
        {(fields, set) => (
          <Group title="Size limit">
            <Field
              label="Size limit"
              htmlFor={`max-instance-${scope}`}
              problem={problemOf(fields.maxInstance)}
              hint="The largest the size may be, and the largest the agent may restart a Workspace's Container at (container_resize) until it is stopped for being idle. Sizes are ordered by memory, then vCPU. The agent cannot raise it without you."
            >
              <SizeSelect
                id={`max-instance-${scope}`}
                value={fields.maxInstance}
                label={sizeLimitLabel}
                invalid={problemOf(fields.maxInstance) !== null}
                onPick={(maxInstance) => {
                  set({ maxInstance });
                }}
              />
            </Field>
          </Group>
        )}
      </SectionFormView>
    </SettingsSection>
  );
};
