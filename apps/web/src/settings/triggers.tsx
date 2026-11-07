// @effect-diagnostics globalDate:off preferEffectArray:off -- the times shown are now's, and JSX lists are native arrays.

// The Triggers section of the Settings page (docs/architecture/triggers.md → The owner's UI): an Environment's Triggers,
// or at Global every Environment's under its name, each with its Schedule, its last and next Fire, Fire now, Edit,
// Pause or Resume, Remove behind a confirm, and its fire log; and the form that makes or edits an Environment trigger,
// its zone filled in from the browser, with the next 5 Fires its Schedule gives. The owner's changes never wait for
// Approval, and record no Agent change.

import { SUPPORTED_MODELS, THINKING_LEVELS } from "@cloudpid/config";
import {
  type EnvironmentRecord,
  fireTimeWords,
  GLOBAL_SCOPE,
  MAX_TRIGGER_NAME_LENGTH,
  type TriggerOverview,
} from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { environmentsErrorAtom, environmentsInOrderAtom } from "../environments-state.ts";
import { InAppLink } from "../in-app-link.tsx";
import { modelName } from "../models.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import { sessionPath, settingsPath } from "../router.ts";
import {
  fireLogAtom,
  fireLogOpenAtom,
  fireTriggerAtom,
  newTriggerKey,
  removeTriggerAtom,
  removeTriggerDialogAtom,
  saveTriggerAtom,
  setTriggerPausedAtom,
  triggerDraftAtom,
  triggerFormAtom,
  triggerNoticeAtom,
  triggersErrorAtom,
  triggersInAtom,
} from "../triggers-state.ts";
import {
  emptyTriggerDraft,
  nextFireOf,
  outcomeWords,
  previewFires,
  scheduleWords,
  sourceWords,
  type TriggerDraft,
  triggerDraftOf,
  triggerDraftProblems,
  triggerDraftReady,
  zoneOf,
} from "../triggers.ts";
import { CODE_AREA, Field, Group, Pending, SettingsSection, TEXT_AREA } from "./parts.tsx";

/** The browser's zone, the one a new Trigger's Schedule starts in. */
const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Trigger `id`'s fire log, newest first: each Fire's time, what made it and what came of it. */
const FireLog = ({ id, zone }: { id: string; zone: string }) => {
  const log = useAtomValue(fireLogAtom(id));
  const fires = AsyncResult.isSuccess(log) ? log.value : null;

  if (fires === null) return <Pending problem={failureOf(log)} />;

  if (fires.length === 0) return <p className="text-xs text-muted-foreground">No fires yet.</p>;

  return (
    <ol aria-label="Fire log" className="flex flex-col gap-1 text-xs">
      {fires.map((fire) => (
        <li key={fire.key} className="flex flex-wrap gap-x-2">
          <span className="text-muted-foreground">{fireTimeWords(fire.at, zone)}</span>
          <span>{sourceWords(fire, zone)}</span>
          <span>{outcomeWords(fire.outcome)}</span>
          {fire.outcome.type === "started" && (
            <InAppLink
              href={sessionPath(fire.outcome.session)}
              className="underline underline-offset-2"
            >
              Open session
            </InAppLink>
          )}
        </li>
      ))}
    </ol>
  );
};

/** What a row says of a Trigger's last Fire. */
const lastFireWords = (overview: TriggerOverview, zone: string): string => {
  if (!overview.reached) return "Last fire: unknown, its object didn't answer";

  return overview.lastFire === null
    ? "No fires yet"
    : `Last fire: ${fireTimeWords(overview.lastFire.at, zone)} · ${outcomeWords(overview.lastFire.outcome)}`;
};

/** A Trigger: its name, Schedule and Fires, and its actions. */
const TriggerRow = ({ scope, overview }: { scope: string; overview: TriggerOverview }) => {
  const { definition } = overview;
  const zone = zoneOf(definition);
  const next = nextFireOf(definition, Date.now());
  const [paused, setPaused] = useAtom(setTriggerPausedAtom(definition.id));
  const [fired, fire] = useAtom(fireTriggerAtom(definition.id));
  const [logOpen, setLogOpen] = useAtom(fireLogOpenAtom(definition.id));
  const setForm = useAtomSet(triggerFormAtom(scope));
  const setDraft = useAtomSet(triggerDraftAtom(scope));
  const setRemoving = useAtomSet(removeTriggerDialogAtom(scope));
  const forgetRemove = useAtomSet(removeTriggerAtom(scope));

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-sm font-medium">
            {definition.name}
            {definition.paused && (
              <span className="rounded-full border px-2 text-xs font-normal text-muted-foreground">
                Paused
              </span>
            )}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {scheduleWords(definition)}
          </span>
          <span className="text-xs text-muted-foreground">{lastFireWords(overview, zone)}</span>
          <span className="text-xs text-muted-foreground">
            {next === null ? "No next fire" : `Next fire: ${fireTimeWords(next, zone)}`}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={definition.paused || fired.waiting}
            onClick={() => {
              fire(newTriggerKey());
            }}
          >
            <Zap />
            {fired.waiting ? "Firing…" : "Fire now"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(triggerDraftOf(definition));
              setForm({ kind: "edit", opened: definition });
            }}
          >
            <Pencil />
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={paused.waiting}
            onClick={() => {
              setPaused(!definition.paused);
            }}
          >
            {definition.paused ? <Play /> : <Pause />}
            {definition.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Remove ${definition.name}`}
            title={`Remove ${definition.name}`}
            onClick={() => {
              forgetRemove(Atom.Reset);
              setRemoving(definition.id);
            }}
          >
            <Trash2 />
          </Button>
        </span>
      </div>
      {AsyncResult.isSuccess(fired) && !fired.waiting && (
        <p className="text-xs text-muted-foreground">
          Fired: the fire shows in its log once it went out.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(paused)} />
      <DialogProblem problem={settledFailureOf(fired)} />
      <button
        type="button"
        aria-expanded={logOpen}
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          setLogOpen(!logOpen);
        }}
      >
        {logOpen ? "Hide fire log" : "Show fire log"}
      </button>
      {logOpen && <FireLog id={definition.id} zone={zone} />}
    </li>
  );
};

/** A list of Triggers, or what says there are none. */
const TriggerList = ({
  scope,
  triggers,
}: {
  scope: string;
  triggers: ReadonlyArray<TriggerOverview>;
}) =>
  triggers.length === 0 ? (
    <p className="text-sm text-muted-foreground">No triggers yet.</p>
  ) : (
    <ul className="flex flex-col divide-y">
      {triggers.map((overview) => (
        <TriggerRow key={overview.definition.id} scope={scope} overview={overview} />
      ))}
    </ul>
  );

/**
 * The form that makes a Trigger, or edits one: at Global it names the Environment of a new one; an edited Trigger's
 * Environment is fixed.
 */
const TriggerFormView = ({
  scope,
  draft,
  editing,
  environments,
}: {
  scope: string;
  draft: TriggerDraft;
  editing: boolean;
  environments: ReadonlyArray<EnvironmentRecord>;
}) => {
  const setDraft = useAtomSet(triggerDraftAtom(scope));
  const setForm = useAtomSet(triggerFormAtom(scope));
  const [saved, save] = useAtom(saveTriggerAtom(scope));
  const problems = triggerDraftProblems(draft);
  const preview = previewFires(draft, Date.now());
  const busy = saved.waiting;
  const id = (field: string) => `trigger-${field}-${scope}`;

  const change = (patch: Partial<TriggerDraft>) => {
    setDraft({ ...draft, ...patch });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!triggerDraftReady(draft) || busy) return;

    save();
  };

  return (
    <form
      onSubmit={submit}
      aria-label={editing ? "Edit trigger" : "New trigger"}
      className="flex flex-col gap-4"
    >
      {scope === GLOBAL_SCOPE && !editing && (
        <Field label="Environment" htmlFor={id("environment")}>
          <NativeSelect
            id={id("environment")}
            value={draft.environment}
            disabled={busy}
            onChange={(event) => {
              change({ environment: event.target.value });
            }}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <Field label="Name" htmlFor={id("name")} problem={draft.name === "" ? null : problems.name}>
        <Input
          id={id("name")}
          value={draft.name}
          maxLength={MAX_TRIGGER_NAME_LENGTH}
          disabled={busy}
          onChange={(event) => {
            change({ name: event.target.value });
          }}
        />
      </Field>
      <Field
        label="Message"
        htmlFor={id("message")}
        hint="What each fire sends a new session, under a header with the trigger's name and the time."
        problem={draft.message === "" ? null : problems.message}
      >
        <textarea
          id={id("message")}
          rows={4}
          value={draft.message}
          disabled={busy}
          onChange={(event) => {
            change({ message: event.target.value });
          }}
          className={TEXT_AREA}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Schedule"
          htmlFor={id("cron")}
          hint="5-field cron, or @hourly, @daily, @weekly."
          problem={draft.cron === "" ? null : problems.schedule}
        >
          <Input
            id={id("cron")}
            value={draft.cron}
            placeholder="0 9 * * MON"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              change({ cron: event.target.value });
            }}
            className="font-mono"
          />
        </Field>
        <Field label="Time zone" htmlFor={id("zone")} hint="An IANA zone, such as America/Chicago.">
          <Input
            id={id("zone")}
            value={draft.zone}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              change({ zone: event.target.value });
            }}
            className="font-mono"
          />
        </Field>
      </div>
      {preview.length > 0 && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Next fires</span>
          <ol aria-label="Next fires" className={`${CODE_AREA} flex flex-col gap-0.5 text-xs`}>
            {preview.map((at) => (
              <li key={at}>{fireTimeWords(at, draft.zone.trim())}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="When the last fire's session is busy"
          htmlFor={id("when-busy")}
          hint="Busy: still running, or waiting for you."
        >
          <NativeSelect
            id={id("when-busy")}
            value={draft.whenBusy}
            disabled={busy}
            onChange={(event) => {
              change({ whenBusy: event.target.value === "start" ? "start" : "skip" });
            }}
          >
            <option value="skip">Skip this fire</option>
            <option value="start">Start another session</option>
          </NativeSelect>
        </Field>
        <Field label="Start from" htmlFor={id("base")} hint="A branch; empty: each repo's default.">
          <Input
            id={id("base")}
            value={draft.base}
            placeholder="Default branch"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              change({ base: event.target.value });
            }}
          />
        </Field>
        <Field label="Model" htmlFor={id("model")}>
          <NativeSelect
            id={id("model")}
            value={draft.model}
            disabled={busy}
            onChange={(event) => {
              change({ model: event.target.value });
            }}
          >
            <option value="">The environment's</option>
            {/* A model the agent set that this version doesn't list stays as it is. */}
            {draft.model !== "" && !SUPPORTED_MODELS.some((model) => model === draft.model) && (
              <option value={draft.model}>{draft.model}</option>
            )}
            {SUPPORTED_MODELS.map((model) => (
              <option key={model} value={model}>
                {modelName(model)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Thinking" htmlFor={id("thinking")}>
          <NativeSelect
            id={id("thinking")}
            value={draft.thinking}
            disabled={busy}
            onChange={(event) => {
              change({ thinking: event.target.value });
            }}
          >
            <option value="">The environment's</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setForm(null);
            setDraft(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !triggerDraftReady(draft)}>
          {busy ? "Saving…" : editing ? "Save" : "Create trigger"}
        </Button>
      </div>
    </form>
  );
};

/** Confirm removing a Trigger of Scope `scope`, saying what goes with it. */
const RemoveTriggerDialog = ({ scope, id }: { scope: string; id: string }) => {
  const [removed, remove] = useAtom(removeTriggerAtom(scope));
  const setRemoving = useAtomSet(removeTriggerDialogAtom(scope));
  const busy = removed.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    remove(id);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        It stops firing, and its fire log goes with it. The sessions it started stay.
      </p>
      <DialogProblem problem={settledFailureOf(removed)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRemoving(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Removing…" : "Remove trigger"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** What the section says it is for, at Scope `scope`. */
const description = (scope: string): string =>
  scope === GLOBAL_SCOPE
    ? "Each trigger starts a new session in a new workspace of its environment when its schedule comes due. Your changes here apply at once; the agent's wait for your approval."
    : "Each of this environment's triggers starts a new session in a new workspace of it when its schedule comes due. Your changes here apply at once; the agent's wait for your approval.";

/** The Triggers, under each Environment's name at Global, or the Environment's own. */
const TriggerLists = ({
  scope,
  triggers,
  environments,
}: {
  scope: string;
  triggers: ReadonlyArray<TriggerOverview>;
  environments: ReadonlyArray<EnvironmentRecord>;
}) =>
  scope === GLOBAL_SCOPE ? (
    environments.map((environment) => (
      <Group key={environment.id} title={environment.name}>
        <TriggerList
          scope={scope}
          triggers={triggers.filter((trigger) => trigger.definition.environment === environment.id)}
        />
        <InAppLink
          href={settingsPath(environment.id, "triggers")}
          className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {environment.name}'s settings
        </InAppLink>
      </Group>
    ))
  ) : (
    <Group>
      <TriggerList scope={scope} triggers={triggers} />
    </Group>
  );

/** The Triggers section at Scope `scope`. */
export const TriggersSection = ({ scope }: { scope: string }) => {
  const triggers = useAtomValue(triggersInAtom(scope));
  const loadError = useAtomValue(triggersErrorAtom(scope));
  const environments = useAtomValue(environmentsInOrderAtom);
  const environmentsError = useAtomValue(environmentsErrorAtom);
  const [form, setForm] = useAtom(triggerFormAtom(scope));
  const [draft, setDraft] = useAtom(triggerDraftAtom(scope));
  const [notice, setNotice] = useAtom(triggerNoticeAtom(scope));
  const [removing, setRemoving] = useAtom(removeTriggerDialogAtom(scope));
  const removed = useAtomValue(removeTriggerAtom(scope));
  const atGlobal = scope === GLOBAL_SCOPE;

  if (triggers === null || environments === null) {
    return (
      <SettingsSection title="Triggers" description={description(scope)}>
        <Group>
          <Pending problem={loadError ?? environmentsError} />
        </Group>
      </SettingsSection>
    );
  }

  // Looked up in the list as it is now: a Trigger removed meanwhile closes its dialog.
  const removingTrigger = triggers.find((trigger) => trigger.definition.id === removing);

  const create = () => {
    setNotice(null);
    setDraft(emptyTriggerDraft(atGlobal ? (environments[0]?.id ?? "") : scope, browserZone()));
    setForm({ kind: "create", id: newTriggerKey() });
  };

  return (
    <SettingsSection title="Triggers" description={description(scope)}>
      <DialogProblem problem={loadError} />
      <TriggerLists scope={scope} triggers={triggers} environments={environments} />
      <Group>
        {notice !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {form !== null && draft !== null ? (
          <TriggerFormView
            scope={scope}
            draft={draft}
            editing={form.kind === "edit"}
            environments={environments}
          />
        ) : (
          <Button type="button" variant="outline" className="self-start" onClick={create}>
            <Plus />
            New trigger
          </Button>
        )}
      </Group>
      <Dialog
        open={removingTrigger !== undefined}
        onClose={() => {
          setRemoving(null);
        }}
        dismissible={!removed.waiting}
        title={`Remove ${removingTrigger?.definition.name ?? ""}?`}
      >
        {removingTrigger !== undefined && (
          <RemoveTriggerDialog scope={scope} id={removingTrigger.definition.id} />
        )}
      </Dialog>
    </SettingsSection>
  );
};
