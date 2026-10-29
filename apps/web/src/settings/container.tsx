// @effect-diagnostics preferEffectArray:off -- JSX lists of sizes are native arrays.

// The sections of the Container settings on the Settings page at either Scope (docs/architecture/container.md → Container
// settings, Builds; ADR-0027): Container (the size, the idle time, the Container-only paths, the Spare Workspace, and an
// Environment's Build) and Setup (the Toolchains and the Setup and Start Scripts). The size limit is in Limits
// (`settings-sections.tsx`). Each saves only its own fields (`forms.ts`); at an Environment each field is marked Inherited
// or Overridden, the paths and each script as a whole (`scoped-view.tsx`). They apply at each Workspace's next Container
// start.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { INSTANCE_TYPES, instanceLimitProblem, type InstanceType } from "@cloudpid/config";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { RotateCw } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { environmentBuildAtom, rebuildEnvironmentAtom } from "../environments-state.ts";
import {
  buildLine,
  idleMinutesProblem,
  ignoreProblem,
  instanceLabel,
  scriptFieldProblem,
  toolchainsFieldProblem,
} from "../environments.ts";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import { containerSectionForm, setupForm } from "./forms.ts";
import { CODE_AREA, Field, Group, SettingsSection } from "./parts.tsx";
import { ScopedSectionForm } from "./scoped-view.tsx";

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

/** Container: the size, idle time, Container-only paths and Spare Workspace, and an Environment's Build. */
export const ContainerSection = ({ scope }: { scope: string }) => {
  // The size limit in force at the Scope, as saved: the size may not be above it.
  const maxInstance = useAtomValue(containerSectionForm.scopeView(scope))?.inForce.maxInstance;
  const atGlobal = scope === GLOBAL_SCOPE;

  return (
    <SettingsSection
      title="Container"
      description={
        atGlobal
          ? "What each workspace's Container is like, in every environment that does not override it. A change applies the next time a workspace's Container starts: a running one keeps what it started with."
          : "What each workspace's Container is like. A field this environment does not override follows Global. A change applies the next time a workspace's Container starts: a running one keeps what it started with."
      }
    >
      <ScopedSectionForm
        form={containerSectionForm}
        scope={scope}
        section="container"
        invalid={(fields) =>
          idleMinutesProblem(fields.idleMinutes.value) !== null ||
          ignoreProblem(fields.ignore.value) !== null ||
          limitProblem(fields.instance.value, maxInstance) !== null
        }
      >
        {(field) => {
          const instance = field.value("instance");
          const idle = field.value("idleMinutes");
          const ignore = field.value("ignore");
          const spare = field.marks("spareWorkspace");

          return (
            <>
              <Group
                title="Size"
                description="A saved disk larger than a smaller size's disk cannot be restored there; the Container then starts from scratch."
              >
                <Field
                  label="Size"
                  htmlFor="instance"
                  problem={limitProblem(instance, maxInstance)}
                  hint="At most the size limit, in Limits."
                  {...field.marks("instance")}
                >
                  <NativeSelect
                    id="instance"
                    value={instance}
                    aria-invalid={limitProblem(instance, maxInstance) !== null}
                    className={field.look("instance")}
                    onChange={(event) => {
                      const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

                      if (picked !== undefined) field.set("instance", picked);
                    }}
                  >
                    {INSTANCE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {instanceLabel(type)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  label="Stop after (minutes without a command)"
                  htmlFor="idle-minutes"
                  problem={idleMinutesProblem(idle)}
                  {...field.marks("idleMinutes")}
                >
                  <Input
                    id="idle-minutes"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={idle}
                    aria-invalid={idleMinutesProblem(idle) !== null}
                    onChange={(event) => {
                      field.set("idleMinutes", event.target.value);
                    }}
                    className={cn("sm:max-w-48", field.look("idleMinutes"))}
                  />
                </Field>
              </Group>
              <Group
                title="Container-only paths"
                description="Kept on the Container, out of the Workspace, like node_modules. One saved with other paths is not restored; the Container then starts from scratch."
              >
                <Field
                  label="More Container-only paths (one per line)"
                  htmlFor="ignore-paths"
                  problem={ignoreProblem(ignore)}
                  hint="Start with / (from /workspace) or **/ (at any depth); a line starting with ! keeps a path synced. What a Workspace already holds there stays until it is deleted."
                  {...field.marks("ignore")}
                >
                  <textarea
                    id="ignore-paths"
                    rows={3}
                    value={ignore}
                    placeholder={"/data\n**/.gradle-cache"}
                    spellCheck={false}
                    aria-invalid={ignoreProblem(ignore) !== null}
                    onChange={(event) => {
                      field.set("ignore", event.target.value);
                    }}
                    className={cn(CODE_AREA, field.look("ignore"))}
                  />
                </Field>
              </Group>
              <Group title="Spare Workspace">
                <div id={spare.anchor} className="flex scroll-mt-6 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <label
                      htmlFor="spare-workspace"
                      className="flex items-center gap-2 text-sm font-medium"
                    >
                      <input
                        id="spare-workspace"
                        type="checkbox"
                        checked={field.value("spareWorkspace")}
                        onChange={(event) => {
                          field.set("spareWorkspace", event.target.checked);
                        }}
                      />
                      Keep a Spare Workspace ready
                    </label>
                    {spare.mark}
                  </div>
                  {spare.note}
                  <p className="max-w-prose text-xs text-muted-foreground">
                    A new session starts without waiting for the clones and Setup Scripts, at the
                    cost of the minute or two of Container time each spare takes to prepare.
                  </p>
                </div>
              </Group>
            </>
          );
        }}
      </ScopedSectionForm>
      {!atGlobal && (
        <Group
          title="Build"
          description="A snapshot of a Container with the repos cloned and the Setup Scripts run, so a new workspace starts from it."
        >
          <BuildStatus id={scope} />
        </Group>
      )}
    </SettingsSection>
  );
};

/** Setup: the Toolchains (a mise.toml), and the Setup and Start Scripts, each overridden as a whole. */
export const SetupSection = ({ scope }: { scope: string }) => (
  <SettingsSection
    title="Setup"
    description={
      scope === GLOBAL_SCOPE
        ? "What every Container start gets, in every environment that does not override it: an environment's own script runs instead of the Global one, not after it. Commands wait for the scripts; one that fails is reported to the first command and does not stop the others."
        : "What every Container start gets. A script or the Toolchains this environment overrides replaces the Global one whole. Commands wait for the scripts; one that fails is reported to the first command and does not stop the others."
    }
  >
    <ScopedSectionForm
      form={setupForm}
      scope={scope}
      section="setup"
      invalid={(fields) =>
        toolchainsFieldProblem(fields.toolchains.value) !== null ||
        scriptFieldProblem(fields.setupScript.value) !== null ||
        scriptFieldProblem(fields.startScript.value) !== null
      }
    >
      {(field) => (
        <>
          <Group title="Toolchains">
            <Field
              label="Toolchains (mise.toml)"
              htmlFor="toolchains"
              problem={toolchainsFieldProblem(field.value("toolchains"))}
              hint="Written as /workspace/mise.toml where a Workspace has none, or still has the copy written last; a Workspace's own edits to the file stay. Empty: the image's base Toolchains (git, gh, Node, pnpm, Python, uv). A Build installs them."
              {...field.marks("toolchains")}
            >
              <textarea
                id="toolchains"
                rows={5}
                value={field.value("toolchains")}
                placeholder={'[tools]\nnode = "24.22.1"\npnpm = "12.15.0"\npython = "3.14.9"'}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={toolchainsFieldProblem(field.value("toolchains")) !== null}
                onChange={(event) => {
                  field.set("toolchains", event.target.value);
                }}
                className={cn(CODE_AREA, field.look("toolchains"))}
              />
            </Field>
          </Group>
          <Group title="Scripts">
            <Field
              label="Setup Script (bash)"
              htmlFor="setup-script"
              problem={scriptFieldProblem(field.value("setupScript"))}
              hint="Runs in /workspace before the repos' .cloudpid/setup.sh, to install what the Workspace needs. It runs again only when it changes, or after it failed."
              {...field.marks("setupScript")}
            >
              <textarea
                id="setup-script"
                rows={4}
                value={field.value("setupScript")}
                placeholder="sudo apt-get install -y postgresql-client"
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={scriptFieldProblem(field.value("setupScript")) !== null}
                onChange={(event) => {
                  field.set("setupScript", event.target.value);
                }}
                className={cn(CODE_AREA, field.look("setupScript"))}
              />
            </Field>
            <Field
              label="Start Script (bash)"
              htmlFor="start-script"
              problem={scriptFieldProblem(field.value("startScript"))}
              hint="Runs in /workspace at every Container start, before the repos' .cloudpid/start.sh, and is stopped after 5 minutes. A service it starts must detach (setsid nohup cmd >/tmp/cmd.log 2>&1 &), or the script does not end."
              {...field.marks("startScript")}
            >
              <textarea
                id="start-script"
                rows={4}
                value={field.value("startScript")}
                placeholder={"setsid nohup docker compose up >/tmp/compose.log 2>&1 &"}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                aria-invalid={scriptFieldProblem(field.value("startScript")) !== null}
                onChange={(event) => {
                  field.set("startScript", event.target.value);
                }}
                className={cn(CODE_AREA, field.look("startScript"))}
              />
            </Field>
          </Group>
        </>
      )}
    </ScopedSectionForm>
  </SettingsSection>
);
