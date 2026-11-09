// @effect-diagnostics globalDate:off preferEffectArray:off -- the times shown are now's, and JSX lists are native arrays.

// The Triggers section of the Settings page (docs/architecture/triggers.md → The owner's UI): an Environment's Triggers,
// or at Global every Environment's under its name (its Workspace triggers listed under their Workspace, by branch), each
// with its Schedule, or its webhook's match, last delivery and ping (and a GitHub-managed hook's repo, events, and where
// the hook is or why GitHub refused it); its last and next Fire; Fire now (a webhook's Fire
// again), Edit, Pause or Resume, Remove behind a confirm; its fire log, with a webhook's refused and filtered deliveries
// per day; and a webhook's Trigger URL and Signing secret, which the owner reveals, copies and replaces (New URL, New
// signing secret). And the form that makes or edits an Environment trigger, or a Workspace trigger (made from the
// Workspaces section's New trigger, which shows the same form): a Schedule, with its zone filled in from the browser
// and the next 5 Fires it gives, or a webhook, with its format and its `match` rows, and for a github one the repo and
// events cloudpid makes its hook on. The owner's changes never wait for
// Approval, and record no Agent change.

import { SUPPORTED_MODELS, THINKING_LEVELS } from "@cloudpid/config";
import {
  type EnvironmentRecord,
  fireTimeWords,
  webhookOf,
  GLOBAL_SCOPE,
  MAX_TRIGGER_NAME_LENGTH,
  takesBase,
  takesModel,
  type TriggerDefinition,
  type TriggerKind,
  type TriggerOverview,
  type WorkspaceRef,
  settingsPath,
} from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { Pause, Pencil, Play, Plus, RotateCw, Trash2, Zap } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { environmentsErrorAtom, environmentsInOrderAtom } from "../environments-state.ts";
import { InAppLink } from "../in-app-link.tsx";
import { modelName } from "../models.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import { sessionPath } from "../router.ts";
import { sessionListAtom } from "../sessions.ts";
import {
  fireAgainAtom,
  fireLogAtom,
  fireLogOpenAtom,
  fireTriggerAtom,
  triggerSecretsAtom,
  rotateAskAtom,
  triggerDeliveriesAtom,
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
  deliveryDays,
  deliveryOutcomeWords,
  emptyTriggerDraft,
  githubEventWords,
  githubHookWords,
  triggerUrl,
  lastDeliveryWords,
  matchWords,
  nextFireOf,
  pingWords,
  withSource,
  outcomeWords,
  previewFires,
  triggerSourceWords,
  sourceWords,
  type MatchRow,
  type TriggerDraft,
  triggerDraftOf,
  triggerDraftProblems,
  triggerDraftReady,
  waitingWords,
  whenBusyChoices,
  whenBusyOfText,
  kindWords,
  zoneOf,
  oneOrMany,
  triggerNames,
  workspaceTriggersOf,
} from "../triggers.ts";
import {
  CODE_AREA,
  CopyValue,
  Field,
  Group,
  Pending,
  SettingsSection,
  TEXT_AREA,
} from "./parts.tsx";

/** The browser's zone, the one a new Trigger's Schedule starts in. */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Trigger `id`'s fire log, newest first: each Fire's time, what made it and what came of it. */
const FireLog = ({ id, kind, zone }: { id: string; kind: TriggerKind; zone: string }) => {
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
          <span>{outcomeWords(fire.outcome, kind)}</span>
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

/**
 * Webhook Trigger `id`'s refused and filtered deliveries over the last 30 days, a line for each UTC day: the counts a
 * delivery leaves when it starts no Session, kept per day only.
 */
const DeliveryCounts = ({ id }: { id: string }) => {
  const deliveries = useAtomValue(triggerDeliveriesAtom(id));
  const days = AsyncResult.isSuccess(deliveries) ? deliveryDays(deliveries.value.counts) : null;

  if (days === null) return <Pending problem={failureOf(deliveries)} />;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">Deliveries that started nothing, last 30 days (UTC days)</span>
      {days.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul aria-label="Refused and filtered deliveries" className="flex flex-col gap-0.5">
          {days.map(({ day, counts }) => (
            <li key={day} data-day={day} className="flex flex-wrap gap-x-2">
              <span className="text-muted-foreground">{day}</span>
              <span>
                {counts
                  .map(({ outcome, n }) => `${String(n)} ${deliveryOutcomeWords(outcome)}`)
                  .join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** What webhook Trigger `id`'s row says of its deliveries: the last one's time, and GitHub's ping. */
const DeliveryStatus = ({ id, zone }: { id: string; zone: string }) => {
  const deliveries = useAtomValue(triggerDeliveriesAtom(id));

  if (!AsyncResult.isSuccess(deliveries)) {
    return <Pending problem={failureOf(deliveries)} />;
  }

  const ping = pingWords(deliveries.value, zone);

  return (
    <>
      <span className="text-xs text-muted-foreground">
        {lastDeliveryWords(deliveries.value, zone)}
      </span>
      {ping !== null && <span className="text-xs text-muted-foreground">{ping}</span>}
    </>
  );
};

/** What replacing each of a webhook Trigger's two secrets does, said before it is done. */
const ROTATION_WORDS = {
  url: {
    button: "New URL",
    warning:
      "The old URL stops working at once, and the sender must be given the new one. The signing secret stays.",
  },
  secret: {
    button: "New signing secret",
    warning:
      "The old signing secret stops working at once, and deliveries signed with it are refused until the sender is given the new one. The URL stays.",
  },
} as const;

/** What replacing each secret of a Trigger with a GitHub-managed hook does: cloudpid gives GitHub the new one. */
const MANAGED_ROTATION_WORDS = {
  url: "The old URL stops working at once; cloudpid points the GitHub hook at the new one. The signing secret stays.",
  secret:
    "The old signing secret stops working at once; cloudpid gives the GitHub hook the new one. The URL stays.",
} as const;

/**
 * Webhook Trigger `id`'s URL and Signing secret, which the owner reveals (nothing is read until they ask), copies, and
 * replaces with **New URL** and **New signing secret** (each applies at once, behind a confirm). The two replacements
 * are there whether or not the values are shown, since a Trigger whose secrets can't be read is mended by them alone.
 * A Trigger with a GitHub-managed hook (`managed`) has GitHub given both. The agent never sees either.
 */
const TriggerSecretsPanel = ({ id, managed }: { id: string; managed: boolean }) => {
  const [secrets, request] = useAtom(triggerSecretsAtom(id));
  const [asking, setAsking] = useAtom(rotateAskAtom(id));
  const shown = AsyncResult.isSuccess(secrets) ? secrets.value : null;
  // Not known before the page is in a browser; a Trigger URL is only shown there.
  const pageOrigin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2">
      {shown !== null && (
        <>
          {/* Keyed by the value: a Copy that said "Copied" starts over once a rotation changed the value. */}
          <CopyValue
            key={triggerUrl(shown, pageOrigin)}
            label="Trigger URL"
            value={triggerUrl(shown, pageOrigin)}
          />
          <CopyValue key={shown.secret} label="Signing secret" value={shown.secret} />
          {shown.github !== undefined && shown.github.state !== "ready" && (
            <p data-github-hook={shown.github.state} className="text-xs text-destructive">
              {githubHookWords(shown.github)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {managed
              ? "GitHub's hook has both: cloudpid gave them to it, and gives it new ones when either is replaced."
              : "Paste both into the sender."}{" "}
            Anyone with the URL can reach this trigger, but only a delivery signed with the secret
            starts a session.
          </p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {shown === null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-reveal=""
            disabled={secrets.waiting}
            onClick={() => {
              request({ kind: "reveal" });
            }}
          >
            {secrets.waiting ? "Revealing…" : "Show URL and signing secret"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAsking(null);
              request(Atom.Reset);
            }}
          >
            Hide
          </Button>
        )}
        {(["url", "secret"] as const).map((what) => (
          <Button
            key={what}
            type="button"
            size="sm"
            variant="outline"
            data-rotate={what}
            disabled={secrets.waiting}
            onClick={() => {
              setAsking(what);
            }}
          >
            <RotateCw />
            {ROTATION_WORDS[what].button}
          </Button>
        ))}
      </div>
      {asking !== null && (
        <div
          role="group"
          data-confirm-rotate={asking}
          aria-label={`Confirm: ${ROTATION_WORDS[asking].button}`}
          className="flex flex-col gap-2 text-xs"
        >
          <p>{managed ? MANAGED_ROTATION_WORDS[asking] : ROTATION_WORDS[asking].warning}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              autoFocus
              disabled={secrets.waiting}
              onClick={() => {
                request({ kind: "rotate", what: asking });
                setAsking(null);
              }}
            >
              {ROTATION_WORDS[asking].button}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAsking(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <DialogProblem problem={settledFailureOf(secrets)} />
    </div>
  );
};

/** What a row says of a Trigger's last Fire. */
const lastFireWords = (overview: TriggerOverview, zone: string): string => {
  if (!overview.reached) return "Last fire: unknown, its object didn't answer";

  return overview.lastFire === null
    ? "No fires yet"
    : `Last fire: ${fireTimeWords(overview.lastFire.at, zone)} · ${outcomeWords(overview.lastFire.outcome, overview.definition.kind)}`;
};

/**
 * Webhook Trigger `id`'s Fire again: a Fire with the last delivery it accepted, held while it is paused and until it
 * accepted one (there is nothing to send again before).
 */
const FireAgain = ({ id, paused }: { id: string; paused: boolean }) => {
  const [again, fireAgain] = useAtom(fireAgainAtom(id));
  const deliveries = useAtomValue(triggerDeliveriesAtom(id));
  // Unknown until the deliveries answer: the button is held then too, and the RPC says if there is none.
  const none = !AsyncResult.isSuccess(deliveries) || deliveries.value.lastDeliveryAt === null;

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      title={
        none
          ? "No delivery has been accepted yet, so there is nothing to fire again"
          : "Fire again with the last delivery this trigger accepted"
      }
      data-fire-again=""
      disabled={paused || none || again.waiting}
      onClick={() => {
        fireAgain(newTriggerKey());
      }}
    >
      <Zap />
      {again.waiting ? "Firing…" : "Fire again"}
    </Button>
  );
};

/** A Trigger: its name, Schedule and Fires, and its actions. */
const TriggerRow = ({ scope, overview }: { scope: string; overview: TriggerOverview }) => {
  const { definition } = overview;
  const zone = zoneOf(definition);
  const next = nextFireOf(definition, Date.now());
  const [paused, setPaused] = useAtom(setTriggerPausedAtom(definition.id));
  const [fired, fire] = useAtom(fireTriggerAtom(definition.id));
  const again = useAtomValue(fireAgainAtom(definition.id));
  const webhook = webhookOf(definition);
  const events = githubEventWords(definition);
  const [logOpen, setLogOpen] = useAtom(fireLogOpenAtom(definition.id));
  const setForm = useAtomSet(triggerFormAtom(scope));
  const setDraft = useAtomSet(triggerDraftAtom(scope));
  const setNotice = useAtomSet(triggerNoticeAtom(scope));
  const setRemoving = useAtomSet(removeTriggerDialogAtom(scope));
  const forgetRemove = useAtomSet(removeTriggerAtom(scope));

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-sm font-medium">
            {definition.name}
            {kindWords(definition.kind).badge !== undefined && (
              <span className="rounded-full border px-2 text-xs font-normal text-muted-foreground">
                {kindWords(definition.kind).badge}
              </span>
            )}
            {definition.paused && (
              <span className="rounded-full border px-2 text-xs font-normal text-muted-foreground">
                Paused
              </span>
            )}
          </span>
          {definition.session !== undefined && (
            <InAppLink
              href={sessionPath(definition.session)}
              className="self-start text-xs underline underline-offset-2"
            >
              Open its session
            </InAppLink>
          )}
          <span className="font-mono text-xs text-muted-foreground">
            {triggerSourceWords(definition)}
          </span>
          {webhook !== undefined && (
            <span className="text-xs text-muted-foreground">{matchWords(webhook.match)}</span>
          )}
          {events !== null && <span className="text-xs text-muted-foreground">{events}</span>}
          {overview.github !== undefined && (
            <span
              data-github-hook={overview.github.state}
              className={
                overview.github.state === "failed"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {githubHookWords(overview.github)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{lastFireWords(overview, zone)}</span>
          {overview.waiting !== undefined && (
            <span className="text-xs text-muted-foreground">
              {waitingWords(overview.waiting, zone)}
            </span>
          )}
          {webhook === undefined ? (
            <span className="text-xs text-muted-foreground">
              {next === null ? "No next fire" : `Next fire: ${fireTimeWords(next, zone)}`}
            </span>
          ) : (
            <DeliveryStatus id={definition.id} zone={zone} />
          )}
        </span>
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          {webhook === undefined ? (
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
          ) : (
            <FireAgain id={definition.id} paused={definition.paused} />
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setNotice(null);
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
              setNotice(null);
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
      {((AsyncResult.isSuccess(fired) && !fired.waiting) ||
        (AsyncResult.isSuccess(again) && !again.waiting)) && (
        <p className="text-xs text-muted-foreground">
          Fired: the fire shows in its log once it went out.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(paused)} />
      <DialogProblem problem={settledFailureOf(fired)} />
      <DialogProblem problem={settledFailureOf(again)} />
      {webhook !== undefined && (
        <TriggerSecretsPanel id={definition.id} managed={events !== null} />
      )}
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
      {logOpen && (
        <>
          {webhook !== undefined && <DeliveryCounts id={definition.id} />}
          <FireLog id={definition.id} kind={definition.kind} zone={zone} />
        </>
      )}
    </li>
  );
};

/** A list of Triggers. */
const TriggerList = ({
  scope,
  triggers,
}: {
  scope: string;
  triggers: ReadonlyArray<TriggerOverview>;
}) => (
  <ul className="flex flex-col divide-y">
    {triggers.map((overview) => (
      <TriggerRow key={overview.definition.id} scope={scope} overview={overview} />
    ))}
  </ul>
);

/** An Environment's Triggers: its Environment triggers, then each Workspace's under its branch; or what says there are none. */
const EnvironmentTriggers = ({
  scope,
  triggers,
}: {
  scope: string;
  triggers: ReadonlyArray<TriggerOverview>;
}) => {
  if (triggers.length === 0)
    return <p className="text-sm text-muted-foreground">No triggers yet.</p>;

  const own = triggers.filter((overview) => overview.definition.workspace === undefined);
  // In the order the Triggers came, each Workspace once.
  const workspaces = new Map<string, { branch: string; triggers: TriggerOverview[] }>();

  for (const overview of triggers) {
    const kept = overview.definition.workspace;

    if (kept === undefined) continue;

    const held = workspaces.get(kept.id) ?? { branch: kept.branch, triggers: [] };

    held.triggers.push(overview);
    workspaces.set(kept.id, held);
  }

  return (
    <>
      {own.length > 0 && <TriggerList scope={scope} triggers={own} />}
      {[...workspaces].map(([id, held]) => (
        <div key={id} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            Workspace <span className="font-mono text-foreground">{held.branch}</span>
          </h3>
          <TriggerList scope={scope} triggers={held.triggers} />
        </div>
      ))}
    </>
  );
};

/** A row of the `match` rows: a path of the delivery's body, the values it may have (one to a line), and a Remove. */
const MatchRowFields = ({
  row,
  at,
  busy,
  onChange,
  onRemove,
}: {
  row: MatchRow;
  at: number;
  busy: boolean;
  onChange: (next: MatchRow) => void;
  onRemove: () => void;
}) => (
  <li
    data-match-row=""
    className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
  >
    <Input
      aria-label={`Match path ${String(at + 1)}`}
      value={row.path}
      placeholder="workflow_run.conclusion"
      spellCheck={false}
      autoComplete="off"
      disabled={busy}
      onChange={(event) => {
        onChange({ ...row, path: event.target.value });
      }}
      className="font-mono"
    />
    <textarea
      aria-label={`Match values ${String(at + 1)}`}
      rows={2}
      value={row.values}
      placeholder="failure"
      spellCheck={false}
      disabled={busy}
      onChange={(event) => {
        onChange({ ...row, values: event.target.value });
      }}
      className={`${TEXT_AREA} font-mono`}
    />
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-8"
      aria-label={`Remove match row ${String(at + 1)}`}
      disabled={busy}
      onClick={onRemove}
    >
      <Trash2 />
    </Button>
  </li>
);

/**
 * What a new github webhook Trigger may ask: the repo and events of a GitHub-managed hook, which cloudpid makes as the
 * GitHub App. Fixed once the Trigger is made, so an edit shows them, held.
 */
const GitHubHookFields = ({
  draft,
  editing,
  busy,
  idOf,
  problem,
  change,
}: {
  draft: TriggerDraft;
  editing: boolean;
  busy: boolean;
  idOf: (field: string) => string;
  problem: string | null;
  change: (patch: Partial<TriggerDraft>) => void;
}) => (
  <div className="grid gap-4 sm:grid-cols-2">
    <Field
      label="GitHub repo"
      htmlFor={idOf("repo")}
      hint={
        editing
          ? "Fixed once the trigger is made."
          : "Optional: owner/name. cloudpid makes the webhook on it as the GitHub App, so you set nothing up on GitHub. The App's installation needs Webhooks: write."
      }
      problem={draft.repo === "" && draft.events === "" ? null : problem}
    >
      <Input
        id={idOf("repo")}
        value={draft.repo}
        placeholder="octo-org/octo-repo"
        spellCheck={false}
        autoComplete="off"
        disabled={busy || editing}
        onChange={(event) => {
          change({ repo: event.target.value });
        }}
        className="font-mono"
      />
    </Field>
    <Field
      label="GitHub events"
      htmlFor={idOf("events")}
      hint="With a repo: the events GitHub sends, apart by commas, such as workflow_run, issue_comment."
    >
      <Input
        id={idOf("events")}
        value={draft.events}
        placeholder="workflow_run"
        spellCheck={false}
        autoComplete="off"
        disabled={busy || editing}
        onChange={(event) => {
          change({ events: event.target.value });
        }}
        className="font-mono"
      />
    </Field>
  </div>
);

/**
 * What a new webhook Trigger asks beyond the rest: its format, a github one's GitHub-managed hook, and the `match` that
 * filters its deliveries.
 */
const WebhookFields = ({
  draft,
  editing,
  busy,
  idOf,
  problem,
  hookProblem,
  change,
}: {
  draft: TriggerDraft;
  editing: boolean;
  busy: boolean;
  idOf: (field: string) => string;
  problem: string | null;
  hookProblem: string | null;
  change: (patch: Partial<TriggerDraft>) => void;
}) => (
  <div className="flex flex-col gap-4">
    <Field
      label="Format"
      htmlFor={idOf("format")}
      hint={
        editing
          ? "Fixed once the trigger is made."
          : "How the sender signs each delivery: GitHub's X-Hub-Signature-256, or the Standard Webhooks headers. The URL and signing secret come with the trigger, on its row."
      }
    >
      <NativeSelect
        id={idOf("format")}
        value={draft.format}
        disabled={busy || editing}
        onChange={(event) => {
          change({ format: event.target.value === "standard" ? "standard" : "github" });
        }}
      >
        <option value="github">GitHub</option>
        <option value="standard">Standard Webhooks</option>
      </NativeSelect>
    </Field>
    {draft.format === "github" && (!editing || draft.repo !== "") && (
      <GitHubHookFields
        draft={draft}
        editing={editing}
        busy={busy}
        idOf={idOf}
        problem={hookProblem}
        change={change}
      />
    )}
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Match</span>
      <p className="text-xs text-muted-foreground">
        Only deliveries that match start a session; the others are answered and counted. Every path
        must match, and any one of its values will do, one to a line (a value's edge spaces are
        trimmed). <code>event</code> is the event's name, such as <code>pull_request</code>. With no
        rows, every delivery signed right starts a session.
      </p>
      {draft.match.length > 0 && (
        <ul aria-label="Match rows" className="flex flex-col gap-2">
          {draft.match.map((row, at) => (
            <MatchRowFields
              key={at}
              row={row}
              at={at}
              busy={busy}
              onChange={(next) => {
                change({ match: draft.match.map((each, index) => (index === at ? next : each)) });
              }}
              onRemove={() => {
                change({ match: draft.match.filter((_, index) => index !== at) });
              }}
            />
          ))}
        </ul>
      )}
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy}
        onClick={() => {
          change({ match: [...draft.match, { path: "", values: "" }] });
        }}
      >
        <Plus />
        Add a path
      </Button>
    </div>
  </div>
);

/**
 * The form that makes a Trigger, or edits one: at Global it names the Environment of a new one; an edited Trigger's
 * Environment is fixed.
 */
export const TriggerFormView = ({
  formKey,
  draft,
  opened,
  environments,
}: {
  /** The key of the form's atoms: a Scope, or a Workspace's (`workspaceFormKey`). */
  formKey: string;
  draft: TriggerDraft;
  /** The Trigger as the form opened on it, when it edits one. */
  opened?: TriggerDefinition | undefined;
  environments: ReadonlyArray<EnvironmentRecord>;
}) => {
  const editing = opened !== undefined;
  const setDraft = useAtomSet(triggerDraftAtom(formKey));
  const setForm = useAtomSet(triggerFormAtom(formKey));
  const [saved, save] = useAtom(saveTriggerAtom(formKey));
  const problems = triggerDraftProblems(draft, opened);
  const preview = previewFires(draft, Date.now());
  const busy = saved.waiting;
  const id = (field: string) => `trigger-${field}-${formKey}`;
  const { kind } = draft;
  const words = kindWords(kind);

  const change = (patch: Partial<TriggerDraft>) => {
    setDraft({ ...draft, ...patch });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!triggerDraftReady(draft, opened) || busy) return;

    save();
  };

  return (
    <form
      onSubmit={submit}
      aria-label={editing ? "Edit trigger" : "New trigger"}
      className="flex flex-col gap-4"
    >
      {formKey === GLOBAL_SCOPE && !editing && draft.workspace === null && (
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
        hint={
          draft.scheduled
            ? `What each fire sends ${words.messageTarget}, under a header with the trigger's name and the time.`
            : `What each fire sends ${words.messageTarget}, under a header with the trigger's name and the delivery's details. The delivery's body follows it, fenced as untrusted content, and is saved to a file.`
        }
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
      {!editing && draft.kind !== "session" && (
        <Field
          label="Fires on"
          htmlFor={id("source")}
          hint="A schedule, or each signed delivery a webhook sender makes to the trigger's URL. It can't be changed once the trigger is made."
        >
          <NativeSelect
            id={id("source")}
            value={draft.scheduled ? "schedule" : "webhook"}
            disabled={busy}
            onChange={(event) => {
              setDraft(
                withSource(draft, event.target.value === "webhook" ? "webhook" : "schedule"),
              );
            }}
          >
            <option value="schedule">A schedule</option>
            <option value="webhook">A webhook</option>
          </NativeSelect>
        </Field>
      )}
      {!draft.scheduled && (
        <WebhookFields
          draft={draft}
          editing={editing}
          busy={busy}
          idOf={id}
          problem={problems.match}
          hookProblem={problems.hook}
          change={change}
        />
      )}
      {draft.scheduled && (
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
          <Field
            label="Time zone"
            htmlFor={id("zone")}
            hint="An IANA zone, such as America/Chicago."
          >
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
      )}
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
        <Field label={words.whenBusyLabel} htmlFor={id("when-busy")} hint={words.whenBusyHint}>
          <NativeSelect
            id={id("when-busy")}
            value={draft.whenBusy}
            disabled={busy}
            onChange={(event) => {
              change({ whenBusy: whenBusyOfText(kind, event.target.value) });
            }}
          >
            {whenBusyChoices(kind).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {takesBase(kind) && (
          <Field
            label="Start from"
            htmlFor={id("base")}
            hint="A branch; empty: each repo's default."
          >
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
        )}
        {takesModel(kind) && (
          <>
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
          </>
        )}
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
        <Button type="submit" disabled={busy || !triggerDraftReady(draft, opened)}>
          {busy ? "Saving…" : editing ? "Save" : "Create trigger"}
        </Button>
      </div>
    </form>
  );
};

/**
 * What removing a Workspace trigger leaves of its Workspace `workspace`: it stays, with its files, because the owner
 * removes a Workspace only from the Workspaces section; and, while a Session is in it or another trigger keeps it, what
 * keeps it.
 */
const WorkspaceStays = ({
  workspace,
  others,
}: {
  workspace: WorkspaceRef;
  /** The other Workspace triggers kept for the Workspace. */
  others: ReadonlyArray<TriggerDefinition>;
}) => {
  const sessions = useAtomValue(sessionListAtom);
  const branch = <span className="font-mono">{workspace.branch}</span>;

  if (others.length > 0) {
    return (
      <>
        The workspace {branch} stays, kept by {oneOrMany(others.length, "trigger", "triggers")}{" "}
        {triggerNames(others)}.
      </>
    );
  }

  // A list that has not answered says nothing of the Sessions.
  if (sessions?.some((session) => session.workspace === workspace.id) === true) {
    return (
      <>
        The workspace {branch} stays, with its files; no trigger keeps it any more, so deleting its
        last session removes it.
      </>
    );
  }

  return <>The workspace {branch} stays, with its files; remove it from the Workspaces section.</>;
};

/** Confirm removing Trigger `definition` of Scope `scope`, saying what goes with it and what stays. */
const RemoveTriggerDialog = ({
  scope,
  definition,
  triggers,
}: {
  scope: string;
  definition: TriggerDefinition;
  /** Every Trigger as last listed, for what else keeps the Workspace. */
  triggers: ReadonlyArray<TriggerOverview>;
}) => {
  const [removed, remove] = useAtom(removeTriggerAtom(scope));
  const setRemoving = useAtomSet(removeTriggerDialogAtom(scope));
  const busy = removed.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) return;

    remove(definition.id);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        It stops firing, and its fire log goes with it. {kindWords(definition.kind).removeNote}
      </p>
      {definition.workspace !== undefined && (
        <p className="text-sm">
          <WorkspaceStays
            workspace={definition.workspace}
            others={workspaceTriggersOf(triggers, definition.workspace.id).filter(
              (other) => other.id !== definition.id,
            )}
          />
        </p>
      )}
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
    ? "Each trigger starts a new session when its schedule comes due: in a new workspace of its environment, or, for a workspace trigger, in its workspace; a session trigger sends its message to the session that made it instead. Your changes here apply at once; the agent's wait for your approval."
    : "Each of this environment's triggers starts a new session when its schedule comes due: in a new workspace of it, or, for a workspace trigger, in its workspace; a session trigger sends its message to the session that made it instead. Your changes here apply at once; the agent's wait for your approval.";

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
        <EnvironmentTriggers
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
      <EnvironmentTriggers scope={scope} triggers={triggers} />
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
            formKey={scope}
            draft={draft}
            opened={form.kind === "edit" ? form.opened : undefined}
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
          <RemoveTriggerDialog
            scope={scope}
            definition={removingTrigger.definition}
            triggers={triggers}
          />
        )}
      </Dialog>
    </SettingsSection>
  );
};
