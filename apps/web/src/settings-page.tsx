// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SETTINGS,
  ROLE_NAMES,
  isModelId,
  type ModelId,
  type RoleName,
  type Settings,
  SUPPORTED_MODELS,
  THINKING_LEVELS,
} from "@cloudpid/config";
import * as Exit from "effect/Exit";
import { ArrowLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./components/ui/button.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { modelName } from "./models.ts";
import { badOfferedEntries, offeredFromText, offeredToText } from "./offered-tools.ts";
import { disablePushAtom, enablePushAtom, pushStatusValueAtom } from "./push-state.ts";
import { failureOf } from "./registry.ts";
import { navigate } from "./router.ts";
import { settingsLoadErrorAtom, settingsStateAtom, updateSettingsAtom } from "./settings.ts";
import { spendLimitFromText, spendLimitToText } from "./spend-limit.ts";

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

const Field = ({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {label}
    </label>
    {children}
  </div>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-4 border-t py-6">
    <h2 className="text-sm font-semibold">{title}</h2>
    {children}
  </section>
);

/** Whether this device gets a push when a Run ends, fails, or needs input. Takes effect at once, like no other setting here. */
const NotificationsSection = () => {
  const status = useAtomValue(pushStatusValueAtom);
  const [enabling, enable] = useAtom(enablePushAtom, { mode: "promiseExit" });
  const [disabling, disable] = useAtom(disablePushAtom, { mode: "promiseExit" });
  const busy = enabling.waiting || disabling.waiting;
  const on = status?.kind === "on";

  return (
    <Section title="Notifications">
      <p className="text-sm text-muted-foreground">
        A push to this device when a run finishes or fails, or when the agent needs you to enter a
        secret, linking to the session. Each device chooses for itself.
      </p>
      {status?.kind === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          This browser cannot receive push notifications. On an iPhone or iPad, add the app to the
          home screen first.
        </p>
      )}
      {status?.kind === "denied" && (
        <p role="alert" className="text-sm text-destructive">
          Notifications are blocked for this site. Allow them in the browser's site settings, then
          turn them on here.
        </p>
      )}
      {status?.kind === "error" && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {status.message}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant={on ? "outline" : "default"}
          disabled={
            status === null || busy || status.kind === "unsupported" || status.kind === "denied"
          }
          onClick={() => {
            void (on ? disable() : enable());
          }}
        >
          {busy ? "Working…" : on ? "Turn off on this device" : "Turn on for this device"}
        </Button>
        {on && (
          <span role="status" className="text-sm text-muted-foreground">
            On for this device
          </span>
        )}
      </div>
    </Section>
  );
};

const RoleFields = ({
  name,
  role,
  onChange,
}: {
  name: RoleName;
  role: Settings["roles"][RoleName];
  onChange: (role: Settings["roles"][RoleName]) => void;
}) => (
  <div className="flex flex-col gap-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium capitalize">{name}</h3>
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
        className="min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
    </Field>
  </div>
);

const SettingsForm = ({
  saved,
  saving,
  error,
  onSave,
}: {
  saved: Settings;
  saving: boolean;
  error: string | null;
  onSave: (settings: Settings) => Promise<boolean>;
}) => {
  const [draft, setDraft] = useState(saved);
  const [justSaved, setJustSaved] = useState(false);
  // The text box keeps what is typed; the draft holds what it parses to.
  const [offeredText, setOfferedText] = useState(offeredToText(saved.tools.offered));
  const [limitText, setLimitText] = useState(spendLimitToText(saved.spendLimit.perSession));
  const badLimit = spendLimitFromText(limitText) === undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const badOffered = badOfferedEntries(draft.tools.offered);

  const edit = (next: Settings) => {
    setDraft(next);
    setJustSaved(false);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft).then(setJustSaved);
      }}
    >
      <Section title="Default model">
        <p className="text-sm text-muted-foreground">
          What a session runs with until it picks its own. A change applies to the next request of
          new and idle sessions.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model" htmlFor="default-model">
            <ModelSelect
              id="default-model"
              value={draft.model}
              onChange={(model) => {
                edit({ ...draft, model });
              }}
            />
          </Field>
          <Field label="Thinking level" htmlFor="default-thinking">
            <NativeSelect
              id="default-thinking"
              value={draft.thinkingLevel}
              onChange={(event) => {
                const level = THINKING_LEVELS.find((known) => known === event.target.value);

                if (level !== undefined) edit({ ...draft, thinkingLevel: level });
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
      </Section>
      <Section title="Model roles">
        <p className="text-sm text-muted-foreground">
          The model each role uses when work is delegated, and the hint that tells an agent when to
          pick it.
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          {ROLE_NAMES.map((name) => (
            <RoleFields
              key={name}
              name={name}
              role={draft.roles[name]}
              onChange={(role) => {
                edit({ ...draft, roles: { ...draft.roles, [name]: role } });
              }}
            />
          ))}
        </div>
      </Section>
      <Section title="Offered tools">
        <p className="text-sm text-muted-foreground">
          The tools the model sees from its first request, one name per line (<code>*</code> matches
          any run of characters, as in <code>context_*</code>). Every other tool is deferred: the
          model finds it with <code>tool_search</code>, which is always offered, as is{" "}
          <code>context_rollover</code>, and scripts in <code>codemode</code> call it without
          loading it. A change applies to the next request of new and idle sessions.
        </p>
        <Field label="Tools" htmlFor="offered-tools">
          <textarea
            id="offered-tools"
            rows={Math.min(Math.max(draft.tools.offered.length + 1, 4), 16)}
            value={offeredText}
            spellCheck={false}
            onChange={(event) => {
              setOfferedText(event.target.value);
              edit({
                ...draft,
                tools: { ...draft.tools, offered: offeredFromText(event.target.value) },
              });
            }}
            className="min-w-0 rounded-md border border-input bg-background px-2.5 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
        </Field>
        {badOffered.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            Not a tool name: {badOffered.join(", ")}. Use lowercase letters, digits, underscores,
            and <code>*</code>.
          </p>
        )}
        {draft.tools.offered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing is listed, so the model is offered only <code>tool_search</code> and{" "}
            <code>context_rollover</code> and must search for every other tool.
          </p>
        )}
      </Section>
      <Section title="Spend limit">
        <p className="text-sm text-muted-foreground">
          The most a session may spend on model requests, in US dollars, its subagents and its title
          included. A session at its limit refuses its next request and ends the run with a message;
          raise or clear the limit and prompt again to go on. Leave it empty for no limit.
        </p>
        <Field label="Per session (USD)" htmlFor="spend-limit">
          <input
            id="spend-limit"
            inputMode="decimal"
            value={limitText}
            placeholder="No limit"
            onChange={(event) => {
              setLimitText(event.target.value);

              const perSession = spendLimitFromText(event.target.value);

              if (perSession !== undefined) edit({ ...draft, spendLimit: { perSession } });
            }}
            className="min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:max-w-48"
          />
        </Field>
        {badLimit && (
          <p role="alert" className="text-sm text-destructive">
            Enter an amount above zero, such as <code>5</code> or <code>12.50</code>, or leave it
            empty for no limit.
          </p>
        )}
      </Section>
      {error !== null && (
        <p role="alert" className="mb-4 text-sm whitespace-pre-wrap text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3 border-t py-4">
        <Button type="submit" disabled={!dirty || saving || badOffered.length > 0 || badLimit}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            edit(DEFAULT_SETTINGS);
            setOfferedText(offeredToText(DEFAULT_SETTINGS.tools.offered));
            setLimitText(spendLimitToText(DEFAULT_SETTINGS.spendLimit.perSession));
          }}
        >
          Reset to defaults
        </Button>
        {justSaved && !dirty && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        )}
      </div>
    </form>
  );
};

/** The settings page: the default model and thinking level, the model roles, the offered tools, the spend limit, and this device's notifications. */
export const SettingsPage = () => {
  const state = useAtomValue(settingsStateAtom);
  const loadError = useAtomValue(settingsLoadErrorAtom);
  const [update, save] = useAtom(updateSettingsAtom, { mode: "promiseExit" });
  // Why a save was refused shows until the next save answers; until then, why the settings could not load.
  const error = failureOf(update) ?? loadError;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigate("/");
            }}
            aria-label="Back to sessions"
            className="-ml-2 rounded-md p-2 hover:bg-accent md:hidden"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>
        {state?.problem !== undefined && (
          <p role="alert" className="mt-4 text-sm whitespace-pre-wrap text-destructive">
            {state.problem}
          </p>
        )}
        {state === null ? (
          error === null ? (
            <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <p role="alert" className="mt-6 text-sm text-destructive">
              {error}
            </p>
          )
        ) : (
          <SettingsForm
            saved={state.settings}
            saving={update.waiting}
            error={error}
            onSave={(settings) => save(settings).then(Exit.isSuccess)}
          />
        )}
        <NotificationsSection />
      </div>
    </div>
  );
};
