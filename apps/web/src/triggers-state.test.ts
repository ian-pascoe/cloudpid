// The Triggers section's form over the fake Registry: what it sends to make or change a Trigger, and when it closes.

import {
  EnvironmentError,
  type TriggerChangeValue,
  triggerChangeValue,
  type TriggerDefinition,
  type TriggerPatch,
  TriggerUnscheduled,
} from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import {
  saveTriggerAtom,
  sessionTriggersAtom,
  type TriggerForm,
  triggerDraftAtom,
  triggerFormAtom,
  triggerNoticeAtom,
} from "./triggers-state.ts";
import { emptyTriggerDraft, triggerDraftOf } from "./triggers.ts";

const DEFINITION: TriggerDefinition = {
  id: "t1",
  revision: 3,
  kind: "environment",
  environment: "work",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * 1", zone: "America/Chicago" },
  whenBusy: "skip",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
};

const DRAFT = {
  ...emptyTriggerDraft("work", "America/Chicago"),
  name: "Nightly",
  message: "Run the checks.",
  cron: "@daily",
};

/** Save the form of Scope `work` over `handlers`, answering the registry after it settled and the save's result. */
const save = (handlers: Partial<RegistryHandlers>, form: TriggerForm, draft = DRAFT) =>
  Effect.gen(function* () {
    const registry = registryWith(handlers);

    registry.mount(triggerFormAtom("work"));
    registry.mount(triggerDraftAtom("work"));
    registry.mount(triggerNoticeAtom("work"));
    registry.set(triggerFormAtom("work"), form);
    registry.set(triggerDraftAtom("work"), draft);
    registry.set(saveTriggerAtom("work"), undefined);

    const result = yield* settled(registry, saveTriggerAtom("work"));

    return { registry, result };
  });

describe("saving the Trigger form", () => {
  it.effect("makes a new Trigger under the form's id, then closes the form", () =>
    Effect.gen(function* () {
      const asked: Array<{ id: string; name: string }> = [];

      const { registry, result } = yield* save(
        {
          createTrigger: ({ id, trigger }) =>
            Effect.sync(() => {
              asked.push({ id, name: trigger.name });

              return { ...DEFINITION, id, name: trigger.name };
            }),
        },
        { kind: "create", id: "0190-new" },
      );

      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(asked).toEqual([{ id: "0190-new", name: "Nightly" }]);
      expect(registry.get(triggerFormAtom("work"))).toBeNull();
      expect(registry.get(triggerDraftAtom("work"))).toBeNull();
      registry.dispose();
    }),
  );

  it.effect("closes the form on a Trigger saved but not scheduled, saying so", () =>
    Effect.gen(function* () {
      const { registry, result } = yield* save(
        {
          createTrigger: () =>
            Effect.fail(TriggerUnscheduled.make({ message: "The trigger is saved, but …" })),
        },
        { kind: "create", id: "0190-new" },
      );

      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(registry.get(triggerFormAtom("work"))).toBeNull();
      expect(registry.get(triggerNoticeAtom("work"))).toBe("The trigger is saved, but …");
      registry.dispose();
    }),
  );

  it.effect(
    "changes only what was edited, while the trigger has the fields the form opened on, then closes the form",
    () =>
      Effect.gen(function* () {
        const asked: Array<{ id: string; patch: TriggerPatch; expected?: TriggerChangeValue }> = [];

        const { registry } = yield* save(
          {
            updateTrigger: (input) =>
              Effect.sync(() => {
                asked.push(input);

                return { ...DEFINITION, revision: 4, message: "Mine" };
              }),
          },
          { kind: "edit", opened: DEFINITION },
          { ...triggerDraftOf(DEFINITION), message: "Mine" },
        );

        expect(asked).toEqual([
          { id: "t1", patch: { message: "Mine" }, expected: triggerChangeValue(DEFINITION) },
        ]);
        expect(registry.get(triggerFormAtom("work"))).toBeNull();
        registry.dispose();
      }),
  );

  it.effect("keeps the form open, with what was typed, when the Registry refuses it", () =>
    Effect.gen(function* () {
      for (const message of [
        "The trigger changed since you opened it: reopen the form",
        "This trigger was removed",
      ]) {
        const draft = { ...triggerDraftOf(DEFINITION), message: "Mine" };

        const { registry, result } = yield* save(
          { updateTrigger: () => Effect.fail(EnvironmentError.make({ message })) },
          { kind: "edit", opened: DEFINITION },
          draft,
        );

        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(registry.get(triggerFormAtom("work"))).toEqual({ kind: "edit", opened: DEFINITION });
        expect(registry.get(triggerDraftAtom("work"))).toEqual(draft);
        registry.dispose();
      }
    }),
  );
});

describe("a Session's triggers", () => {
  const SESSION_TRIGGER: TriggerDefinition = {
    ...DEFINITION,
    id: "t2",
    kind: "session",
    session: "s-1",
    whenBusy: "queue",
  };

  it.effect(
    "are asked of the Session's own method, so a Registry without it fails them loudly",
    () =>
      Effect.gen(function* () {
        const asked: Array<string> = [];

        const registry = registryWith({
          listSessionTriggers: ({ session }) =>
            Effect.sync(() => {
              asked.push(session);

              return [SESSION_TRIGGER];
            }),
        });

        // Until its answer, the list is empty.
        const listed = yield* Effect.callback<readonly TriggerDefinition[]>((resume) => {
          const cancel = registry.subscribe(sessionTriggersAtom("s-1"), (found) => {
            if (found.length === 0) return;

            cancel();
            resume(Effect.succeed(found));
          });

          return Effect.sync(cancel);
        });

        // Asked again as the page becomes visible: always of the one Session.
        expect(Arr.dedupe(asked)).toEqual(["s-1"]);
        expect(listed).toEqual([SESSION_TRIGGER]);
        registry.dispose();
      }),
  );

  it.effect("are none while the Registry cannot answer", () =>
    Effect.gen(function* () {
      const registry = registryWith({ listSessionTriggers: () => Effect.die("no such method") });

      registry.mount(sessionTriggersAtom("s-1"));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(registry.get(sessionTriggersAtom("s-1"))).toEqual([]);
      registry.dispose();
    }),
  );
});
