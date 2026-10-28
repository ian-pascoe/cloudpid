// @effect-diagnostics preferEffectArray:off -- JSX lists of Secrets are native arrays.

// The Secrets section of the Settings page (docs/architecture/agent-capabilities.md → Secrets): the Secrets kept at the
// Scope, Global or an Environment (GLOSSARY.md → Secret), with the form that keeps another, and an Environment's names of those it gets from Global. The Registry
// never shows a value again. Saving, replacing, switching the build flag and deleting each take effect at once.

import {
  GLOBAL_SCOPE,
  MAX_SECRET_NAME_LENGTH,
  type EnvironmentSecretRecord,
} from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { KeyRound, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  deleteSecretAtom,
  environmentSecretsAtom,
  environmentSecretsErrorAtom,
  saveSecretAtom,
  secretDialogAtom,
  secretDraftAtom,
  secretsInAtom,
  setSecretBuildAtom,
} from "../environments-state.ts";
import {
  inheritedSecrets,
  secretDraftProblems,
  secretDraftReady,
  secretVariable,
} from "../environments.ts";
import { settledFailureOf } from "../registry.ts";
import { CODE_AREA, Group, SettingsSection } from "./parts.tsx";

/**
 * The form that keeps a Secret at Scope `scope`: a name and a value. The value's field hides what is typed where the
 * browser can, and holds several lines, for a key file. A name the Scope keeps already replaces that Secret's value.
 */
const SecretForm = ({ scope }: { scope: string }) => {
  const [draft, setDraft] = useAtom(secretDraftAtom(scope));
  const [saved, save] = useAtom(saveSecretAtom(scope));
  const kept = useAtomValue(secretsInAtom(scope)) ?? [];
  const problems = secretDraftProblems(draft);
  const replacing = kept.some((record) => record.name === draft.name);
  const busy = saved.waiting;
  const nameId = `secret-name-${scope}`;
  const valueId = `secret-value-${scope}`;
  const buildId = `secret-build-${scope}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!secretDraftReady(draft) || busy) return;

    save();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          {replacing ? "Replace a secret" : "Add a secret"}
        </label>
        <Input
          id={nameId}
          value={draft.name}
          maxLength={MAX_SECRET_NAME_LENGTH}
          onChange={(event) => {
            setDraft({ ...draft, name: event.target.value.toUpperCase() });
          }}
          placeholder="NAME"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          disabled={busy}
          aria-invalid={problems.name !== null}
          className="font-mono"
        />
        {problems.name !== null && <p className="text-xs text-destructive">{problems.name}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={valueId} className="sr-only">
          Value
        </label>
        <textarea
          id={valueId}
          rows={2}
          value={draft.value}
          placeholder="Value"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          data-1p-ignore
          disabled={busy}
          onChange={(event) => {
            setDraft({ ...draft, value: event.target.value });
          }}
          aria-invalid={problems.value !== null}
          className={`${CODE_AREA} [-webkit-text-security:disc]`}
        />
        {problems.value !== null && <p className="text-xs text-destructive">{problems.value}</p>}
      </div>
      <div className="flex items-center justify-between gap-2">
        {replacing ? (
          <p className="text-xs text-muted-foreground">
            Replaces the value kept under this name. Its build setting stays.
          </p>
        ) : (
          <label htmlFor={buildId} className="flex items-center gap-2 text-xs">
            <input
              id={buildId}
              type="checkbox"
              checked={draft.build}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, build: event.target.checked });
              }}
            />
            Give it to the build's setup scripts too
          </label>
        )}
        <Button type="submit" variant="outline" disabled={busy || !secretDraftReady(draft)}>
          <KeyRound />
          {busy ? "Saving…" : replacing ? "Replace" : "Add"}
        </Button>
      </div>
      <DialogProblem problem={settledFailureOf(saved)} />
    </form>
  );
};

/** Confirm deleting Secret `name` of Scope `scope`, after saying what stays where it was. */
const DeleteSecretDialog = ({ scope, name }: { scope: string; name: string }) => {
  const [deleted, remove] = useAtom(deleteSecretAtom(scope));
  const setDialog = useAtomSet(secretDialogAtom(scope));
  const busy = deleted.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    remove(name);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        Sessions stop getting it within a minute, and the next build runs without it. What a command
        or a model already did with it stays as it is: revoke it where it was issued if it may have
        leaked.
      </p>
      <DialogProblem problem={settledFailureOf(deleted)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDialog(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Deleting…" : "Delete secret"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** A kept Secret: its name, whether it reaches the Build, and its actions. */
const SecretRow = ({
  scope,
  record,
  onReplace,
  onDelete,
}: {
  scope: string;
  record: EnvironmentSecretRecord;
  onReplace: () => void;
  onDelete: () => void;
}) => {
  const [switched, setBuild] = useAtom(setSecretBuildAtom(scope));
  const buildId = `secret-${scope}-${record.name}-build`;

  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-sm">{record.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {record.build
            ? `Sessions, and the build's setup scripts as $${secretVariable(record.name)}`
            : "Sessions only"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <label htmlFor={buildId} className="flex items-center gap-1.5 text-xs">
          <input
            id={buildId}
            type="checkbox"
            checked={record.build}
            disabled={switched.waiting}
            onChange={(event) => {
              setBuild({ name: record.name, build: event.target.checked });
            }}
          />
          Build
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={onReplace}>
          Replace
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Delete ${record.name}`}
          title={`Delete ${record.name}`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </span>
    </li>
  );
};

/** The Secrets section at Scope `scope`. */
export const SecretsSection = ({ scope }: { scope: string }) => {
  const kept = useAtomValue(secretsInAtom(scope));
  const all = useAtomValue(environmentSecretsAtom).pipe(AsyncResult.value, Option.getOrNull);
  const loadError = useAtomValue(environmentSecretsErrorAtom);
  const [draft, setDraft] = useAtom(secretDraftAtom(scope));
  const [deleting, setDeleting] = useAtom(secretDialogAtom(scope));
  const deleted = useAtomValue(deleteSecretAtom(scope));
  const forgetDelete = useAtomSet(deleteSecretAtom(scope));
  const switched = useAtomValue(setSecretBuildAtom(scope));
  const atGlobal = scope === GLOBAL_SCOPE;
  const inherited = atGlobal || all === null ? [] : inheritedSecrets(all, scope);

  return (
    <SettingsSection
      title="Secrets"
      description={
        atGlobal
          ? "Used by reference in every session, as one the agent asked for is, but never expiring. An environment's own secret of the same name wins."
          : "Used by reference in this environment's sessions, as one the agent asked for is, but never expiring. Its own secret wins over Global's of the same name."
      }
    >
      <Group
        title="Kept here"
        description="A value is not shown again, and is taken out of command output and of what the model is sent. A value that is not secret (an email, a URL) belongs in Variables: a kept secret found on a Container's disk stops its snapshot."
      >
        {kept === null ? (
          loadError === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : kept.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {atGlobal ? "None kept Global." : "None kept for this environment."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {kept.map((record) => (
              <SecretRow
                key={record.name}
                scope={scope}
                record={record}
                onReplace={() => {
                  setDraft({ ...draft, name: record.name, value: "" });
                }}
                onDelete={() => {
                  forgetDelete(Atom.Reset);
                  setDeleting(record.name);
                }}
              />
            ))}
          </ul>
        )}
        {inherited.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Also from Global:{" "}
            <span className="font-mono">{inherited.map((record) => record.name).join(", ")}</span>
          </p>
        )}
        <DialogProblem problem={loadError} />
        <DialogProblem problem={settledFailureOf(switched)} />
      </Group>
      <Group>
        <SecretForm scope={scope} />
      </Group>
      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        dismissible={!deleted.waiting}
        title={`Delete ${deleting ?? ""}?`}
      >
        {deleting !== null && <DeleteSecretDialog scope={scope} name={deleting} />}
      </Dialog>
    </SettingsSection>
  );
};
