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
import * as Option from "effect/Option";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "../environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import { sessionsAtom } from "../sessions.ts";
import {
  fireLogAtom,
  fireLogOpenAtom,
  hookAtom,
  rotateAskAtom,
  triggerDeliveriesAtom,
  triggerDraftAtom,
  triggerFormAtom,
  removeTriggerDialogAtom,
  triggerNoticeAtom,
  triggersAtom,
} from "../triggers-state.ts";
import { emptyTriggerDraft, triggerDraftOf, withSource } from "../triggers.ts";
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
  source: {
    type: "webhook",
    format: "github",
    match: { event: ["workflow_run"], "workflow_run.conclusion": ["failure", "timed_out"] },
  },
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
  {
    definition: {
      ...definition("t3", "work", "Check the build"),
      kind: "session",
      session: "s-owner",
      whenBusy: "queue",
    },
    lastFire: { ...STARTED, key: "t3:1", outcome: { type: "sent", delivery: "queued" } },
    reached: true,
  },
  { definition: WEBHOOK_TRIGGER, lastFire: null, reached: true },
];

const WORKSPACE_TRIGGER: TriggerDefinition = {
  ...definition("t5", "work", "Lint sweep"),
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
  triggerDeliveries: () =>
    Effect.succeed({
      counts: [
        { day: "2025-01-05", outcome: "filtered", n: 3 },
        { day: "2025-01-05", outcome: "unauthorized", n: 1 },
      ],
      lastDeliveryAt: Date.parse("2025-01-06T15:00:05Z"),
      pingAt: Date.parse("2025-01-01T10:00:00Z"),
    }),
  revealTrigger: () =>
    Effect.succeed({
      origin: "https://cloudpid.example",
      path: "/hooks/0190-t3/abcDEF",
      secret: "s3cr3t-value",
    }),
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

/** The markup of the row of the Trigger named `name`, from its Remove button's list item. */
const rowOf = (markup: string, name: string): string =>
  Arr.findFirst(markup.split("<li "), (row) => row.includes(`aria-label="Remove ${name}"`)).pipe(
    Option.getOrElse(() => ""),
  );

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
    registry.mount(triggerDeliveriesAtom("t3"));
    registry.mount(sessionsAtom);
    yield* settled(registry, sessionsAtom);
    yield* settled(registry, triggersAtom(scope));
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, fireLogAtom("t1"));
    yield* settled(registry, triggerDeliveriesAtom("t3"));

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

      // Fire now is the Schedule triggers' alone: the webhook's row has none, the others' do (a Session trigger's too).
      const rows = markup.split("<li ");

      const rowOf = (name: string) =>
        Arr.findFirst(rows, (row) => row.includes(`aria-label="Remove ${name}"`)).pipe(
          Option.getOrElse(() => ""),
        );

      expect(rowOf("CI failed")).not.toBe("");
      expect(rowOf("CI failed")).not.toContain("Fire now</button>");
      expect(rowOf("Weekly report")).toContain("Fire now</button>");
      expect(rowOf("Lint sweep")).toContain("Fire now</button>");
      expect(rowOf("Check the build")).toContain("Fire now</button>");
    }),
  );

  it.effect(
    "shows a webhook Trigger's match, last delivery and GitHub's ping, and Fire again",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work");
        const row = rowOf(markup, "CI failed");

        expect(row).toContain(
          "Match: event is workflow_run; workflow_run.conclusion is failure or timed_out",
        );
        expect(row).toContain("Last delivery: ");
        expect(row).toContain("GitHub reached this trigger (");
        expect(row).toContain("Fire again</button>");
        expect(row).not.toContain("Fire now</button>");
        expect(row).not.toContain("No next fire");
        expect(rowOf(markup, "Weekly report")).not.toContain("Last delivery");
        expect(rowOf(markup, "Weekly report")).not.toContain("Fire again");
      }),
  );

  it.effect("keeps the URL and Signing secret hidden until the owner asks", () =>
    Effect.gen(function* () {
      const hidden = rowOf(yield* render("work"), "CI failed");

      expect(hidden).toContain("Show URL and signing secret");
      expect(hidden).not.toContain("abcDEF");
      expect(hidden).not.toContain("s3cr3t-value");
    }),
  );

  it.effect(
    "shows a revealed URL (the stage's origin first) and secret with Copy, New URL and New signing secret",
    () =>
      Effect.gen(function* () {
        const registry = registryWith(HANDLERS);

        registry.mount(hookAtom("t3"));
        registry.mount(triggersAtom("work"));
        registry.mount(environmentsAtom);
        registry.mount(sessionsAtom);
        registry.mount(triggerDeliveriesAtom("t3"));
        registry.set(hookAtom("t3"), { kind: "reveal" });
        yield* settled(registry, hookAtom("t3"));
        yield* settled(registry, triggersAtom("work"));
        yield* settled(registry, environmentsAtom);
        yield* settled(registry, sessionsAtom);
        yield* settled(registry, triggerDeliveriesAtom("t3"));

        const markup = renderToStaticMarkup(
          <RegistryContext.Provider value={registry}>
            <TriggersSection scope="work" />
          </RegistryContext.Provider>,
        );

        const row = rowOf(markup, "CI failed");

        expect(row).toContain("https://cloudpid.example/hooks/0190-t3/abcDEF");
        expect(row).toContain("s3cr3t-value");
        expect(row).toContain('aria-label="Copy trigger url"');
        expect(row).toContain('aria-label="Copy signing secret"');
        expect(row).toContain("New URL");
        expect(row).toContain("New signing secret");
        expect(row).toContain("Hide");
        expect(row).not.toContain("Show URL and signing secret");
        // Nothing is replaced until the owner confirms.
        expect(row).not.toContain("stops working at once");

        registry.set(rotateAskAtom("t3"), "url");

        const asking = rowOf(
          renderToStaticMarkup(
            <RegistryContext.Provider value={registry}>
              <TriggersSection scope="work" />
            </RegistryContext.Provider>,
          ),
          "CI failed",
        );

        expect(asking).toContain("The old URL stops working at once");
        expect(asking).toContain('role="alertdialog"');

        registry.dispose();
      }),
  );

  it.effect("shows the refused and filtered deliveries per day in an open fire log", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", (registry) => {
        registry.set(fireLogOpenAtom("t3"), true);
        registry.mount(fireLogAtom("t3"));
      });

      expect(markup).toContain('aria-label="Refused and filtered deliveries"');
      expect(markup).toContain("2025-01-05");
      expect(markup).toContain("3 filtered out by the match, 1 unauthorized (401)");
    }),
  );

  it.effect("makes a webhook Trigger from the form: its format, match rows, and no schedule", () =>
    Effect.gen(function* () {
      const draft = withSource(
        {
          ...emptyTriggerDraft("work", "America/Chicago"),
          name: "CI",
          message: "Look.",
          match: [{ path: "event", values: "push" }],
        },
        false,
      );

      const markup = yield* render("work", (registry) => {
        registry.set(triggerFormAtom("work"), { kind: "create", id: "0190-new" });
        registry.set(triggerDraftAtom("work"), draft);
      });

      expect(markup).toContain("Fires on");
      expect(markup).toContain('<option value="webhook" selected="">A webhook</option>');
      expect(markup).toContain("Standard Webhooks");
      expect(markup).toContain('aria-label="Match path 1"');
      expect(markup).toContain('aria-label="Match values 1"');
      expect(markup).toContain("Add a path");
      expect(markup).not.toContain("Time zone");
      expect(markup).not.toContain('aria-label="Next fires"');
      expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);

      // A path with no values can't be saved, and says why.
      const bad = yield* render("work", (registry) => {
        registry.set(triggerFormAtom("work"), { kind: "create", id: "0190-new" });
        registry.set(triggerDraftAtom("work"), { ...draft, match: [{ path: "a", values: "" }] });
      });

      expect(bad).toContain("lists no values");
      expect(bad).toMatch(/<button[^>]*disabled=""[^>]*>Create trigger/);

      // A new Trigger asks which source; an existing one does not.
      expect(markup).toContain('id="trigger-source-work"');
    }),
  );

  it.effect("edits a webhook Trigger's match, with its format fixed and no source to choose", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", (registry) => {
        registry.set(triggerFormAtom("work"), { kind: "edit", opened: WEBHOOK_TRIGGER });
        registry.set(triggerDraftAtom("work"), triggerDraftOf(WEBHOOK_TRIGGER));
      });

      expect(markup).not.toContain('id="trigger-source-work"');
      expect(markup).toMatch(/<select[^>]*id="trigger-format-work"[^>]*disabled=""/);
      expect(markup).toContain('aria-label="Match path 2"');
      expect(markup).toContain("workflow_run.conclusion");
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
          registry.set(removeTriggerDialogAtom("work"), "t5");
        });

        expect(markup).toContain("Remove Lint sweep?");
        expect(markup).toContain("feature/lint</span> stays, with its files");
        expect(markup).toContain("remove it from the Workspaces section");
        expect(markup).not.toContain("deleting its last session removes it");

        // With a Session in it, deleting that Session is what removes it.
        const sessioned = yield* render(
          "work",
          (registry) => {
            registry.set(removeTriggerDialogAtom("work"), "t5");
          },
          // SAFETY: the dialog reads the Session's Workspace id only.
          { listSessions: () => Effect.succeed([{ id: "s1", workspace: "ab12cd34" } as never]) },
        );

        expect(sessioned).toContain("so deleting its last session removes it");

        // Another trigger of the Workspace still keeps it.
        const shared = yield* render(
          "work",
          (registry) => {
            registry.set(removeTriggerDialogAtom("work"), "t5");
          },
          {
            listTriggers: () =>
              Effect.succeed([
                WORKSPACE_OVERVIEW,
                {
                  definition: { ...WORKSPACE_TRIGGER, id: "t6", name: "Weekly lint" },
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
  it.effect("marks a Session trigger and links its Session", () =>
    Effect.gen(function* () {
      const markup = yield* render("work");

      expect(markup).toContain("Check the build");
      expect(markup).toContain("Session trigger");
      expect(markup).toContain('href="/sessions/s-owner"');
      expect(markup).toContain("Last fire: ");
      expect(markup).toContain("Sent (queued)");
      expect(markup.match(/Session trigger/g)).toHaveLength(1);
    }),
  );

  it.effect(
    "edits a Session trigger's when-busy choice only, with no base, model or thinking",
    () =>
      Effect.gen(function* () {
        const opened = TRIGGERS[2]?.definition;

        if (opened === undefined) return;

        const markup = yield* render("work", (registry) => {
          registry.set(triggerFormAtom("work"), { kind: "edit", opened });
          registry.set(triggerDraftAtom("work"), triggerDraftOf(opened));
        });

        expect(markup).toContain('aria-label="Edit trigger"');
        expect(markup).toContain("When its session is busy");
        expect(markup).toContain(">Queue it after the run<");
        expect(markup).toContain(">Steer the run with it<");
        expect(markup).toContain(">Skip this fire<");
        expect(markup).not.toContain("Start another session");
        expect(markup).not.toContain("Start from");
        expect(markup).not.toContain('for="trigger-model-work"');
        expect(markup).not.toContain('for="trigger-thinking-work"');
      }),
  );

  it.effect("keeps the whole form for an Environment trigger", () =>
    Effect.gen(function* () {
      const opened = TRIGGERS[0]?.definition;

      if (opened === undefined) return;

      const markup = yield* render("work", (registry) => {
        registry.set(triggerFormAtom("work"), { kind: "edit", opened });
        registry.set(triggerDraftAtom("work"), triggerDraftOf(opened));
      });

      expect(markup).toContain(">Start another session<");
      expect(markup).toContain("Start from");
      expect(markup).not.toContain(">Queue it after the run<");
    }),
  );
});
