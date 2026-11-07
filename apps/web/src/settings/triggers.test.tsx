// The Triggers section of the Settings page at a Scope, rendered with `react-dom/server` over the fake Registry: the
// queries it reads are settled first, so the markup shows what they answered.

import type {
  EnvironmentRecord,
  FireRecord,
  TriggerDefinition,
  TriggerOverview,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "../environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import { sessionsAtom } from "../sessions.ts";
import {
  fireLogAtom,
  fireLogOpenAtom,
  triggerDraftAtom,
  triggerFormAtom,
  removeTriggerDialogAtom,
  triggerNoticeAtom,
  triggersAtom,
} from "../triggers-state.ts";
import { emptyTriggerDraft, triggerDraftOf } from "../triggers.ts";
import { TriggersSection } from "./triggers.tsx";

const environment = (id: string, name: string): EnvironmentRecord => ({
  id,
  name,
  repos: [],
  createdAt: 1,
});

const definition = (id: string, environmentId: string, name: string): TriggerDefinition => ({
  id,
  revision: 1,
  kind: "environment",
  environment: environmentId,
  name,
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * 1", zone: "America/Chicago" },
  whenBusy: "skip",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});

const WEBHOOK_TRIGGER: TriggerDefinition = {
  ...definition("t3", "work", "CI failed"),
  source: { type: "webhook", format: "github" },
  whenBusy: "start",
};

const STARTED: FireRecord = {
  key: "t1:1",
  at: Date.parse("2025-01-06T15:00:05Z"),
  source: { type: "schedule", scheduledAt: Date.parse("2025-01-06T15:00:00Z") },
  outcome: { type: "started", session: "s-fired" },
};

const TRIGGERS: ReadonlyArray<TriggerOverview> = [
  { definition: definition("t1", "work", "Weekly report"), lastFire: STARTED, reached: true },
  {
    definition: { ...definition("t2", "home", "Nightly"), paused: true },
    lastFire: null,
    reached: false,
  },
  { definition: WEBHOOK_TRIGGER, lastFire: null, reached: true },
];

const WORKSPACE_TRIGGER: TriggerDefinition = {
  ...definition("t3", "work", "Lint sweep"),
  workspace: { id: "ab12cd34", branch: "feature/lint" },
  whenBusy: "wait",
};

const WORKSPACE_OVERVIEW: TriggerOverview = {
  definition: WORKSPACE_TRIGGER,
  lastFire: null,
  reached: true,
  waiting: { since: Date.parse("2025-01-06T15:00:00Z"), merged: 2 },
};

const HANDLERS: Partial<RegistryHandlers> = {
  listSessions: () => Effect.succeed([]),
  listEnvironments: () =>
    Effect.succeed([environment("work", "Work"), environment("home", "Home")]),
  listTriggers: ({ environment }) =>
    Effect.succeed(
      Arr.filter(
        [...TRIGGERS, WORKSPACE_OVERVIEW],
        (trigger) => environment === undefined || trigger.definition.environment === environment,
      ),
    ),
  triggerFireLog: () =>
    Effect.succeed([
      STARTED,
      {
        key: "t1:manual:x",
        at: STARTED.at - 1000,
        source: { type: "manual" },
        outcome: { type: "skipped", reason: "overlap" },
      },
    ]),
};

/** The section at Scope `scope`, once its queries answered; `before` sets atoms first. */
const render = (
  scope: string,
  before?: (registry: AtomRegistry.AtomRegistry) => void,
  handlers: Partial<RegistryHandlers> = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({ ...HANDLERS, ...handlers });

    before?.(registry);

    // Kept mounted, so the render reads their answers.
    registry.mount(triggersAtom(scope));
    registry.mount(environmentsAtom);
    registry.mount(fireLogAtom("t1"));
    registry.mount(sessionsAtom);
    yield* settled(registry, sessionsAtom);
    yield* settled(registry, triggersAtom(scope));
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, fireLogAtom("t1"));

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <TriggersSection scope={scope} />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

describe("the Triggers section", () => {
  it("keeps its description while it loads", () => {
    const registry = registryWith({ ...HANDLERS, listTriggers: () => Effect.never });

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <TriggersSection scope="work" />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    expect(markup).toContain(">Triggers</h1>");
    expect(markup).toContain("Each of this environment&#x27;s triggers");
    expect(markup).toContain("Loading…");
  });

  it.effect("shows a notice once a trigger was saved but not scheduled", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", (registry) => {
        registry.set(triggerNoticeAtom("work"), "The trigger is saved, but …");
      });

      expect(markup).toContain('role="status"');
      expect(markup).toContain("The trigger is saved, but …");
      expect(markup).toContain("New trigger");
    }),
  );

  it.effect("lists every Environment's Triggers at Global, under its name, with their Fires", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(markup).toContain('<section aria-label="Work"');
      expect(markup).toContain('<section aria-label="Home"');
      expect(markup).toContain("Weekly report");
      expect(markup).toContain("0 9 * * 1 · America/Chicago");
      expect(markup).toContain("Last fire: ");
      expect(markup).toContain("Started a session");
      expect(markup).toContain("Next fire: ");
      expect(markup).toContain("Paused");
      expect(markup).toContain("Last fire: unknown, its object didn&#x27;t answer");
      expect(markup).toContain("No next fire");
      expect(markup).toContain("Resume");
      expect(markup).toContain("New trigger");
    }),
  );

  it.effect("lists only an Environment's own Triggers there", () =>
    Effect.gen(function* () {
      const markup = yield* render("work");

      expect(markup).toContain("Weekly report");
      expect(markup).not.toContain("Nightly");
    }),
  );

  it.effect("shows a fire log that is open, linking the Session a Fire started", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", (registry) => {
        registry.set(fireLogOpenAtom("t1"), true);
      });

      expect(markup).toContain('aria-label="Fire log"');
      expect(markup).toContain('href="/sessions/s-fired"');
      expect(markup).toContain("Fire now");
      expect(markup).toContain("Skipped: overlap");
    }),
  );

  it.effect(
    "previews the next 5 Fires of the form's Schedule, and holds Create until it can be saved",
    () =>
      Effect.gen(function* () {
        const draft = { ...emptyTriggerDraft("work", "America/Chicago"), cron: "0 9 * * 1" };

        const markup = yield* render("work", (registry) => {
          registry.set(triggerFormAtom("work"), { kind: "create", id: "0190-new" });
          registry.set(triggerDraftAtom("work"), draft);
        });

        expect(markup).toContain('aria-label="New trigger"');
        expect(
          markup.match(/<ol aria-label="Next fires"[^]*?<\/ol>/)?.[0].match(/<li>/g),
        ).toHaveLength(5);
        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);

        const ready = yield* render("work", (registry) => {
          registry.set(triggerFormAtom("work"), { kind: "create", id: "0190-new" });
          registry.set(triggerDraftAtom("work"), { ...draft, name: "Weekly", message: "Go." });
        });

        expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);
      }),
  );

  it.effect("shows a webhook Trigger by its format, with no Fire now and no next fire", () =>
    Effect.gen(function* () {
      const markup = yield* render("work");

      expect(markup).toContain("CI failed");
      expect(markup).toContain("Webhook · github");
      // Fire now is the Schedule Trigger's alone.
      expect(markup.match(/Fire now<\/button>/g)).toHaveLength(1);
    }),
  );

  it.effect("asks for no Schedule when editing a webhook Trigger, whose source is fixed", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", (registry) => {
        registry.set(triggerFormAtom("work"), { kind: "edit", opened: WEBHOOK_TRIGGER });
        registry.set(triggerDraftAtom("work"), triggerDraftOf(WEBHOOK_TRIGGER));
      });

      expect(markup).toContain('aria-label="Edit trigger"');
      expect(markup).not.toContain("Time zone");
      expect(markup).not.toContain("5-field cron");
      expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    }),
  );

  it.effect(
    "lists a Workspace trigger under its Workspace's branch, apart from the Environment's",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work");

        expect(markup).toContain("Lint sweep");
        expect(markup).toMatch(/Workspace <span[^>]*>feature\/lint<\/span>/);
        expect(markup.indexOf("Weekly report")).toBeLessThan(markup.indexOf("feature/lint"));
        expect(markup.indexOf("feature/lint")).toBeLessThan(markup.indexOf("Lint sweep"));
        // Its waiting Fire is said, since when and how many more were merged into it.
        expect(markup).toContain("Waiting for the workspace to be idle (since ");
        expect(markup).toContain("2 more merged)");
        expect(markup.match(/Waiting for the workspace/g)).toHaveLength(1);
      }),
  );

  it.effect(
    "says a removed Workspace trigger leaves its Workspace, which nothing keeps any more",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", (registry) => {
          registry.set(removeTriggerDialogAtom("work"), "t3");
        });

        expect(markup).toContain("Remove Lint sweep?");
        expect(markup).toContain("feature/lint</span> stays, with its files");
        expect(markup).toContain("remove it from the Workspaces section");
        expect(markup).not.toContain("deleting its last session removes it");

        // With a Session in it, deleting that Session is what removes it.
        const sessioned = yield* render(
          "work",
          (registry) => {
            registry.set(removeTriggerDialogAtom("work"), "t3");
          },
          // SAFETY: the dialog reads the Session's Workspace id only.
          { listSessions: () => Effect.succeed([{ id: "s1", workspace: "ab12cd34" } as never]) },
        );

        expect(sessioned).toContain("so deleting its last session removes it");

        // Another trigger of the Workspace still keeps it.
        const shared = yield* render(
          "work",
          (registry) => {
            registry.set(removeTriggerDialogAtom("work"), "t3");
          },
          {
            listTriggers: () =>
              Effect.succeed([
                WORKSPACE_OVERVIEW,
                {
                  definition: { ...WORKSPACE_TRIGGER, id: "t4", name: "Weekly lint" },
                  lastFire: null,
                  reached: true,
                },
              ]),
          },
        );

        expect(shared).toContain("stays, kept by trigger");
        expect(shared).toContain("Weekly lint");
        expect(shared).not.toContain("remove it from the Workspaces section");

        const environment = yield* render("work", (registry) => {
          registry.set(removeTriggerDialogAtom("work"), "t1");
        });

        expect(environment).toContain("Remove Weekly report?");
        expect(environment).not.toContain("stays, with");
      }),
  );

  it.effect(
    "shows a Workspace trigger's form without a base or an Environment, offering to wait",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", (registry) => {
          registry.set(triggerFormAtom("*"), { kind: "create", id: "0190-new" });
          registry.set(
            triggerDraftAtom("*"),
            emptyTriggerDraft("work", "America/Chicago", "ab12cd34"),
          );
        });

        expect(markup).toContain("When the workspace is busy");
        expect(markup).toContain("Wait until the workspace is idle");
        expect(markup).not.toContain("Start from");
        expect(markup).not.toContain('id="trigger-environment-*"');

        const environment = yield* render("*", (registry) => {
          registry.set(triggerFormAtom("*"), { kind: "create", id: "0190-new" });
          registry.set(triggerDraftAtom("*"), emptyTriggerDraft("work", "America/Chicago"));
        });

        expect(environment).toContain("Start from");
        expect(environment).toContain('id="trigger-environment-*"');
        expect(environment).not.toContain("Wait until the workspace is idle");
      }),
  );
});
