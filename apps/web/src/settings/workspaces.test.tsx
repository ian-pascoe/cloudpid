// The Workspaces section of the Settings page, rendered with `react-dom/server` over the fake Registry: the queries it
// reads are settled first. It covers what Workspace triggers add (docs/architecture/triggers.md → The owner's UI): a New
// trigger per Workspace, a Workspace kept only by a trigger, and the Remove dialog naming the triggers that go with it.

import type {
  EnvironmentRecord,
  TriggerDefinition,
  TriggerOverview,
  WorkspaceRecord,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentDialogAtom, environmentsAtom, workspacesAtom } from "../environments-state.ts";
import { registryWith, settled } from "../registry.testing.ts";
import { WorkspaceFate } from "../session-menu.tsx";
import { sessionsAtom } from "../sessions.ts";
import {
  triggerDraftAtom,
  triggerFormAtom,
  triggerNoticeAtom,
  triggersAtom,
  workspaceFormKey,
} from "../triggers-state.ts";
import { emptyTriggerDraft } from "../triggers.ts";
import { WorkspacesSection } from "./workspaces.tsx";

const environment: EnvironmentRecord = { id: "work", name: "Work", repos: [], createdAt: 1 };

const workspace = (id: string, branch: string): WorkspaceRecord => ({
  id,
  environment: "work",
  branch,
  base: null,
  repos: ["app"],
  directory: "/workspace/app",
  createdAt: 1,
});

const trigger = (id: string, name: string, workspaceId: string): TriggerDefinition => ({
  id,
  revision: 1,
  kind: "workspace",
  environment: "work",
  workspace: { id: workspaceId, branch: `branch-${workspaceId}` },
  name,
  message: "Lint it.",
  source: { type: "schedule", cron: "0 3 * * *", zone: "UTC" },
  whenBusy: "wait",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});

const TRIGGERS: ReadonlyArray<TriggerOverview> = [
  { definition: trigger("t1", "Nightly lint", "w1"), lastFire: null, reached: true },
  { definition: trigger("t2", "Dependency bump", "w1"), lastFire: null, reached: true },
];

const HANDLERS = {
  listEnvironments: () => Effect.succeed([environment]),
  listWorkspaces: () =>
    Effect.succeed([workspace("w1", "feature/a"), workspace("w2", "feature/b")]),
  listSessions: () => Effect.succeed([]),
  listTriggers: () => Effect.succeed(TRIGGERS),
};

/** The section at Scope "work", once its queries answered; `before` sets atoms first. */
const render = (before?: (registry: AtomRegistry.AtomRegistry) => void) =>
  Effect.gen(function* () {
    const registry = registryWith(HANDLERS);

    before?.(registry);

    // Kept mounted, so the render reads their answers.
    registry.mount(workspacesAtom);
    registry.mount(sessionsAtom);
    registry.mount(environmentsAtom);
    registry.mount(triggersAtom("work"));
    yield* settled(registry, workspacesAtom);
    yield* settled(registry, sessionsAtom);
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, triggersAtom("work"));

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <WorkspacesSection scope="work" />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

describe("the Workspaces section's Workspace triggers", () => {
  it.effect("offers a New trigger on each Workspace and names the triggers that keep one", () =>
    Effect.gen(function* () {
      const markup = yield* render();

      expect(markup).toContain('aria-label="New trigger for the feature/a workspace"');
      expect(markup).toContain('aria-label="New trigger for the feature/b workspace"');
      expect(markup).toContain("Kept by triggers “Nightly lint” and “Dependency bump”");
      expect(markup.match(/Kept by trigger/g)).toHaveLength(1);
      // Kept without a session, it is still listed.
      expect(markup).toContain("no sessions");
    }),
  );

  it.effect(
    "still lists a Workspace no session or trigger is left in, for the owner to remove",
    () =>
      Effect.gen(function* () {
        const markup = yield* render();

        // w2 has neither: its row is there, with no "Kept by", and can be removed.
        expect(markup).toContain('aria-label="Remove the feature/b workspace"');
        expect(markup).toContain("feature/b");
      }),
  );

  it.effect("shows the Workspace trigger form of a row that opened it, without a base", () =>
    Effect.gen(function* () {
      const key = workspaceFormKey("w2");

      const markup = yield* render((registry) => {
        registry.set(triggerFormAtom(key), { kind: "create", id: "0190-new" });
        registry.set(triggerDraftAtom(key), emptyTriggerDraft("work", "UTC", "w2"));
      });

      expect(markup).toContain("New trigger for feature/b");
      expect(markup).toContain("The workspace stays while the trigger exists");
      expect(markup).toContain("Wait until the workspace is idle");
      expect(markup).not.toContain("Start from");
    }),
  );

  it.effect("shows a notice for a trigger saved but not scheduled", () =>
    Effect.gen(function* () {
      const markup = yield* render((registry) => {
        registry.set(triggerNoticeAtom(workspaceFormKey("w1")), "The trigger is saved, but …");
      });

      expect(markup).toContain("The trigger is saved, but …");
    }),
  );

  it.effect("names the triggers that go with a Workspace when it is removed", () =>
    Effect.gen(function* () {
      const markup = yield* render((registry) => {
        registry.set(environmentDialogAtom("work"), { removeWorkspace: "w1" });
      });

      expect(markup).toContain("Remove the feature/a workspace?");
      expect(markup).toContain("Its triggers");
      expect(markup).toContain("“Nightly lint” and “Dependency bump”");
      expect(markup).toContain("their fire logs");

      const free = yield* render((registry) => {
        registry.set(environmentDialogAtom("work"), { removeWorkspace: "w2" });
      });

      expect(free).toContain("Remove the feature/b workspace?");
      expect(free).not.toContain("fire log");
    }),
  );
});

describe("deleting the last Session of a Workspace", () => {
  const fate = (handlers: Partial<typeof HANDLERS>, ready: boolean) =>
    Effect.gen(function* () {
      const registry = registryWith({ ...HANDLERS, ...handlers });

      registry.mount(triggersAtom("*"));

      if (ready) yield* settled(registry, triggersAtom("*"));

      // SAFETY: the dialog reads the Session's Workspace id only.
      const session = { workspace: "w1" } as never;

      const markup = renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <WorkspaceFate session={session} environmentName="Work" />
        </RegistryContext.Provider>,
      );

      registry.dispose();

      return markup;
    });

  it.effect("says the Workspace stays when a Workspace trigger keeps it", () =>
    Effect.gen(function* () {
      const markup = yield* fate({}, true);

      expect(markup).toContain("The workspace stays: triggers");
      expect(markup).toContain("“Nightly lint” and “Dependency bump”");
      expect(markup).toContain("the next fire starts a new session in it");
      expect(markup).not.toContain("is removed with it");
    }),
  );

  it.effect(
    "says it is removed with the Session when no trigger keeps it, or none is known yet",
    () =>
      Effect.gen(function* () {
        const none = yield* fate({ listTriggers: () => Effect.succeed([]) }, true);

        expect(none).toContain("which is removed with it");

        const unknown = yield* fate({ listTriggers: () => Effect.never }, false);

        expect(unknown).toContain("which is removed with it");
      }),
  );
});
