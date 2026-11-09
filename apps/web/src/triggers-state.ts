// The Settings page's Triggers section, as atoms (`docs/architecture/triggers.md` → The owner's UI): a Scope's Triggers
// with their last Fire, asked again while the page is visible (the agent makes and changes Triggers too); the form that
// makes or edits one; Pause, Resume, Remove and Fire now; and each Trigger's fire log, asked for while it is open. None
// of the owner's own changes waits for Approval. A new Trigger's id is drawn when its form opens, and a Fire now's key
// at each press, so a call sent again makes no second one.

import { GLOBAL_SCOPE, triggerChangeValue, type TriggerDefinition } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";
import { type TriggerDraft, triggerInput, triggerPatch } from "./triggers.ts";

/**
 * The form key of the Workspace trigger made from Workspace `id`'s row in the Workspaces section. The form atoms
 * (`triggerFormAtom`, `triggerDraftAtom`, `triggerNoticeAtom`, `saveTriggerAtom`) are keyed by form key: a Scope's (the
 * Triggers section's own form) or a Workspace's.
 */
export const workspaceFormKey = (id: string): string => `workspace:${id}`;

/** A new id for a Trigger or a Fire now, drawn by the page. */
// @effect-diagnostics-next-line cryptoRandomUUID:off -- an id, not a secret: what makes a call sent again the same.
export const newTriggerKey = (): string => crypto.randomUUID();

/**
 * Scope `scope`'s Triggers, newest first, each with its last Fire: every one at Global, else the Environment's own,
 * whose objects alone are asked.
 */
export const triggersAtom = Atom.family((scope: string) =>
  RegistryClient.query("listTriggers", scope === GLOBAL_SCOPE ? {} : { environment: scope }, {
    reactivityKeys: ["triggers"],
  }).pipe(Atom.makeRefreshOnSignal(visibleTickAtom)),
);

/** Why Scope `scope`'s Triggers could not load, or null. */
export const triggersErrorAtom = Atom.family((scope: string) =>
  Atom.map(triggersAtom(scope), failureOf),
);

/** Scope `scope`'s Triggers, as of the last answer; null until the first. */
export const triggersInAtom = Atom.family((scope: string) =>
  Atom.map(triggersAtom(scope), (result) => result.pipe(AsyncResult.value, Option.getOrNull)),
);

/**
 * The form open under form key `formKey`: a new Trigger's, under the id drawn when it opened, or the edit of the Trigger as it
 * was when the form opened; null when it is closed.
 */
export type TriggerForm =
  | { readonly kind: "create"; readonly id: string }
  | { readonly kind: "edit"; readonly opened: TriggerDefinition };

export const triggerFormAtom = Atom.family((_formKey: string) =>
  Atom.make<TriggerForm | null>(null),
);

/** What is typed in form `formKey`; set when the form opens. */
export const triggerDraftAtom = Atom.family((_formKey: string) =>
  Atom.make<TriggerDraft | null>(null),
);

/** What the section of form `formKey` says after its form closed: a Trigger saved but not scheduled yet; null for nothing. */
export const triggerNoticeAtom = Atom.family((_formKey: string) => Atom.make<string | null>(null));

/**
 * Save form `formKey`: make the Trigger under the form's id, or change the one it edits by what was edited since
 * it opened, while it still has the fields it opened on (a pause or resume meanwhile aside). Once saved the form closes; one saved but not scheduled
 * closes too, saying so; a refusal keeps it open with what was typed.
 */
export const saveTriggerAtom = Atom.family((formKey: string) =>
  appRuntime.fn(
    (_: void, get) =>
      Effect.gen(function* () {
        const form = get.registry.get(triggerFormAtom(formKey));
        const draft = get.registry.get(triggerDraftAtom(formKey));

        if (form === null || draft === null) return;

        get.set(triggerNoticeAtom(formKey), null);

        if (form.kind === "create") {
          yield* RegistryClient.use((registry) =>
            registry("createTrigger", { id: form.id, trigger: triggerInput(draft) }),
          ).pipe(
            Effect.catchTag("TriggerUnscheduled", ({ message }) =>
              Effect.sync(() => {
                get.set(triggerNoticeAtom(formKey), message);
              }),
            ),
          );
        } else {
          const { opened } = form;

          yield* RegistryClient.use((registry) =>
            registry("updateTrigger", {
              id: opened.id,
              patch: triggerPatch(opened, draft),
              expected: triggerChangeValue(opened),
            }),
          );
        }

        get.set(triggerFormAtom(formKey), null);
        get.set(triggerDraftAtom(formKey), null);
      }).pipe(changing(["triggers"])),
    { concurrent: true },
  ),
);

/** Pause or resume Trigger `id`. A resumed one does not catch up on the Fires it missed. */
export const setTriggerPausedAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (paused: boolean) =>
      RegistryClient.use((registry) => registry("setTriggerPaused", { id, paused })).pipe(
        changing(["triggers"]),
      ),
    { concurrent: true },
  ),
);

/** The Trigger of Scope `scope` whose Remove dialog is open, by id: null when none is. */
export const removeTriggerDialogAtom = Atom.family((_scope: string) =>
  Atom.make<string | null>(null),
);

/** Remove a Trigger of Scope `scope` for good, with its fire log. Once it is removed, its dialog closes. */
export const removeTriggerAtom = Atom.family((scope: string) =>
  appRuntime.fn(
    (id: string, get) =>
      RegistryClient.use((registry) => registry("removeTrigger", { id })).pipe(
        changing(["triggers"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(removeTriggerDialogAtom(scope), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/**
 * The owner's Fire now of Trigger `id`, under `key` (drawn at the press): a Fire recorded `manual`, which its fire log
 * shows once it went out.
 */
export const fireTriggerAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (key: string) =>
      RegistryClient.use((registry) => registry("fireTrigger", { id, key })).pipe(
        changing(["triggers", `trigger-fires:${id}`]),
      ),
    { concurrent: true },
  ),
);

/** Whether Trigger `id`'s fire log is open. */
export const fireLogOpenAtom = Atom.family((_id: string) => Atom.make(false));

/** Trigger `id`'s fire log, newest first, asked for while it is open and again while the page is visible. */
export const fireLogAtom = Atom.family((id: string) =>
  RegistryClient.query("triggerFireLog", { id }, { reactivityKeys: [`trigger-fires:${id}`] }).pipe(
    Atom.makeRefreshOnSignal(visibleTickAtom),
  ),
);

/**
 * The Session triggers of Session `session` (`docs/architecture/triggers.md` → The owner's UI), as the Session details
 * list them: definitions alone (`listSessionTriggers` reads no object), asked again while the page is visible, since
 * the agent makes and changes them too, for as long as the Session details are open and show them. Empty until the
 * first answer, and when it fails (the Settings page says why).
 */
export const sessionTriggersAtom = Atom.family((session: string) =>
  RegistryClient.query("listSessionTriggers", { session }, { reactivityKeys: ["triggers"] }).pipe(
    Atom.makeRefreshOnSignal(visibleTickAtom),
    Atom.map((result): ReadonlyArray<TriggerDefinition> =>
      result.pipe(
        AsyncResult.value,
        Option.getOrElse(() => []),
      ),
    ),
  ),
);

/** What a Subagent page lists of Session triggers: none, which are the Session's, so nothing is asked. */
export const NO_SESSION_TRIGGERS: Atom.Atom<ReadonlyArray<TriggerDefinition>> = Atom.make([]);

/**
 * Pause or resume a Trigger of Session `session` from the Session details; the owner's change, at once. One atom per
 * Session, so a failure shown for one Session does not follow the owner to another.
 */
export const setSessionTriggerPausedAtom = Atom.family((_session: string) =>
  appRuntime.fn(
    (change: { readonly id: string; readonly paused: boolean }) =>
      RegistryClient.use((registry) => registry("setTriggerPaused", change)).pipe(
        changing(["triggers"]),
      ),
    { concurrent: true },
  ),
);

/** Remove a Trigger of Session `session` from the Session details, with its fire log; the owner's change, at once. */
export const removeSessionTriggerAtom = Atom.family((_session: string) =>
  appRuntime.fn(
    (id: string) =>
      RegistryClient.use((registry) => registry("removeTrigger", { id })).pipe(
        changing(["triggers"]),
      ),
    { concurrent: true },
  ),
);
