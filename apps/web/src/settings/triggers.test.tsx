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
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "../environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import {
  fireLogAtom,
  fireLogOpenAtom,
  triggerDraftAtom,
  triggerFormAtom,
  triggersAtom,
} from "../triggers-state.ts";
import { emptyTriggerDraft } from "../triggers.ts";
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
];

const HANDLERS: Partial<RegistryHandlers> = {
  listEnvironments: () =>
    Effect.succeed([environment("work", "Work"), environment("home", "Home")]),
  listTriggers: () => Effect.succeed(TRIGGERS),
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
const render = (scope: string, before?: (registry: AtomRegistry.AtomRegistry) => void) =>
  Effect.gen(function* () {
    const registry = registryWith(HANDLERS);

    before?.(registry);

    // Kept mounted, so the render reads their answers.
    registry.mount(triggersAtom);
    registry.mount(environmentsAtom);
    registry.mount(fireLogAtom("t1"));
    yield* settled(registry, triggersAtom);
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
  it.effect("lists every Environment's Triggers at Global, under its name, with their Fires", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(markup).toContain('<section aria-label="Work"');
      expect(markup).toContain('<section aria-label="Home"');
      expect(markup).toContain("Weekly report");
      expect(markup).toContain("0 9 * * 1 · America/Chicago");
      expect(markup).toContain("Last Fire: ");
      expect(markup).toContain("Started a session");
      expect(markup).toContain("Next Fire: ");
      expect(markup).toContain("Paused");
      expect(markup).toContain("Last Fire: unknown, its object didn&#x27;t answer");
      expect(markup).toContain("No next Fire");
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
          registry.set(triggerFormAtom("work"), { kind: "create" });
          registry.set(triggerDraftAtom("work"), draft);
        });

        expect(markup).toContain('aria-label="New trigger"');
        expect(
          markup.match(/<ol aria-label="Next Fires"[^]*?<\/ol>/)?.[0].match(/<li>/g),
        ).toHaveLength(5);
        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);

        const ready = yield* render("work", (registry) => {
          registry.set(triggerFormAtom("work"), { kind: "create" });
          registry.set(triggerDraftAtom("work"), { ...draft, name: "Weekly", message: "Go." });
        });

        expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);
      }),
  );
});
