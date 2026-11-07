// The Settings page's Triggers section, as atoms (`docs/architecture/triggers.md` → The owner's UI): every Trigger with
// its last Fire, asked again while the page is visible (the agent makes and changes Triggers too); the form that makes
// or edits one; Pause, Resume, Remove and Fire now; and each Trigger's fire log, asked for while it is open. None of the
// owner's own changes waits for Approval.

import { GLOBAL_SCOPE, type TriggerOverview } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";
import { type TriggerDraft, triggerInput, triggerPatch } from "./triggers.ts";

/** Every Trigger, newest first, each with its last Fire. */
export const triggersAtom = RegistryClient.query(
  "listTriggers",
  {},
  { reactivityKeys: ["triggers"] },
).pipe(Atom.makeRefreshOnSignal(visibleTickAtom));

/** Why the Triggers could not load, or null. */
export const triggersErrorAtom = Atom.map(triggersAtom, failureOf);

/** The Triggers Scope `scope` shows, as of the last answer: every one at Global, else its own; null until the first. */
export const triggersInAtom = Atom.family((scope: string) =>
  Atom.map(triggersAtom, (result) =>
    result.pipe(
      AsyncResult.value,
      Option.map((all): ReadonlyArray<TriggerOverview> =>
        scope === GLOBAL_SCOPE
          ? all
          : Arr.filter(all, (trigger) => trigger.definition.environment === scope),
      ),
      Option.getOrNull,
    ),
  ),
);

/** The form open at Scope `scope`: a new Trigger's, or the edit of Trigger `id`; null when it is closed. */
export type TriggerForm =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly id: string };

export const triggerFormAtom = Atom.family((_scope: string) => Atom.make<TriggerForm | null>(null));

/** What is typed in Scope `scope`'s form; set when the form opens. */
export const triggerDraftAtom = Atom.family((_scope: string) =>
  Atom.make<TriggerDraft | null>(null),
);

/**
 * Save Scope `scope`'s form: make the Trigger, or change the one it edits by what was edited. Once saved the form
 * closes; a refusal keeps it open with what was typed.
 */
export const saveTriggerAtom = Atom.family((scope: string) =>
  appRuntime.fn(
    (_: void, get) =>
      Effect.gen(function* () {
        const form = get.registry.get(triggerFormAtom(scope));
        const draft = get.registry.get(triggerDraftAtom(scope));

        if (form === null || draft === null) return;

        if (form.kind === "create") {
          yield* RegistryClient.use((registry) =>
            registry("createTrigger", { trigger: triggerInput(draft) }),
          );
        } else {
          const held = Arr.findFirst(
            get.registry.get(triggersInAtom(scope)) ?? [],
            (trigger) => trigger.definition.id === form.id,
          );

          if (Option.isSome(held)) {
            yield* RegistryClient.use((registry) =>
              registry("updateTrigger", {
                id: form.id,
                patch: triggerPatch(held.value.definition, draft),
              }),
            );
          }
        }

        get.set(triggerFormAtom(scope), null);
        get.set(triggerDraftAtom(scope), null);
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

/** The Trigger whose Remove dialog is open: null when none is. */
export const removeTriggerDialogAtom = Atom.make<TriggerOverview | null>(null);

/** Remove a Trigger for good, with its fire log. Once it is removed, its dialog closes. */
export const removeTriggerAtom = appRuntime.fn(
  (id: string, get) =>
    RegistryClient.use((registry) => registry("removeTrigger", { id })).pipe(
      changing(["triggers"]),
      Effect.tap(() =>
        Effect.sync(() => {
          get.set(removeTriggerDialogAtom, null);
        }),
      ),
    ),
  { concurrent: true },
);

/** The owner's Fire now of Trigger `id`: a Fire recorded `manual`, which its fire log shows once it went out. */
export const fireTriggerAtom = Atom.family((id: string) =>
  appRuntime.fn(
    () =>
      RegistryClient.use((registry) => registry("fireTrigger", { id })).pipe(
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
