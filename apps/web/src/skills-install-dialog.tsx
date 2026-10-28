// @effect-diagnostics preferEffectArray:off -- JSX lists of options and lines are native arrays.

// The install target picker (ADR-0026, docs/architecture/client-and-protocol.md → Skills page): the dialog every place
// that offers Install opens, a row of a Skill directory list, a repo's selected Skills, a Skill's page. It asks where to
// install, Every environment (the default) or one Environment, and installs only the Skills the page named, through the
// owner's install: no Approval, and no Agent change. A page opens it by setting `skillsToInstallAtom` (with the `ref` its
// `?ref=` names, if any). `SkillsFrame` (skills-page.tsx) mounts it, so every page that renders through the frame, which
// all of `/skills` and the pages below it do, has it; a page that does not must mount it itself.

import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { type FormEvent, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "./components/ui/dialog.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { environmentListAtom } from "./environments-state.ts";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { settledFailureOf } from "./registry.ts";
import { installToTargetAtom, skillsToInstallAtom, type SkillsToInstall } from "./skills-state.ts";
import { installOutcomeLines } from "./skills.ts";

/** What the picker is for, in a title: the one Skill's ID, or how many Skills. */
const titleOf = ({ skills }: SkillsToInstall): string =>
  skills.length === 1 ? `Install ${skills[0]}` : `Install ${skills.length} skills`;

/** The picker's form: the target, with Every environment chosen first, and the install's outcome once it ran. */
const InstallTargetForm = ({ pending, close }: { pending: SkillsToInstall; close: () => void }) => {
  const environments = useAtomValue(environmentListAtom);
  const [installed, install] = useAtom(installToTargetAtom);
  const [target, setTarget] = useState(EVERY_ENVIRONMENT);
  const answer = installed.pipe(AsyncResult.value, Option.getOrNull);
  const busy = installed.waiting;

  // An answer that kept a Skill, or found it kept already, ends the picking; one where every Skill was refused leaves it
  // open to try another target.
  const done =
    answer !== null &&
    answer.status === "installed" &&
    answer.skills.some(({ outcome }) => outcome !== "rejected");

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy || done) return;

    install({ target, ...pending });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Install for</span>
        <NativeSelect
          value={target}
          disabled={busy || done}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        >
          <option value={EVERY_ENVIRONMENT}>Every environment</option>
          {(environments ?? []).map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <p className="text-xs text-muted-foreground">
        From <span className="font-mono">{pending.source}</span>, pinned to the latest commit of{" "}
        {pending.ref === undefined ? (
          "its default branch"
        ) : (
          <span className="font-mono">{pending.ref}</span>
        )}
        . {pending.skills.length === 1 ? "Only this skill is" : "Only the picked skills are"}{" "}
        installed, whatever else the source holds. It is your own change: no approval is asked and
        the agent records nothing.
      </p>
      <DialogProblem problem={settledFailureOf(installed)} />
      {answer !== null && (
        <ul className="flex flex-col gap-0.5 text-xs" role="status" aria-label="Install result">
          {answer.status === "installed" ? (
            installOutcomeLines(answer.skills).map((line) => (
              <li key={line} className="font-mono break-words">
                {line}
              </li>
            ))
          ) : (
            <li>
              {answer.repo} holds several skills and none of them was named: nothing installed.
            </li>
          )}
        </ul>
      )}
      <DialogActions>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>
          {done ? "Done" : "Cancel"}
        </Button>
        {!done && (
          <Button type="submit" disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </Button>
        )}
      </DialogActions>
    </form>
  );
};

/**
 * The install target picker, open while `skillsToInstallAtom` names Skills. A page that offers Install mounts it once;
 * closing it forgets the last install's answer.
 */
export const InstallSkillsDialog = () => {
  const [pending, setPending] = useAtom(skillsToInstallAtom);
  const [installed, install] = useAtom(installToTargetAtom);

  const close = () => {
    setPending(null);
    install(Atom.Reset);
  };

  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      dismissible={!installed.waiting}
      title={pending === null ? "Install" : titleOf(pending)}
    >
      {pending !== null && <InstallTargetForm pending={pending} close={close} />}
    </Dialog>
  );
};

/** What a page's Install button does: open the picker for `skills` of `source`. */
export const useInstallPicker = (): ((skills: SkillsToInstall) => void) =>
  useAtomSet(skillsToInstallAtom);
