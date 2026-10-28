// The install target picker, rendered with `react-dom/server` over the fake Registry (ADR-0026): open for the Skills a
// page named, it offers Every environment first and then each Environment, and says what it installs.

import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "./environments-state.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { InstallSkillsDialog } from "./skills-install-dialog.tsx";
import { skillsToInstallAtom, type SkillsToInstall } from "./skills-state.ts";

const render = (pending: SkillsToInstall | null) =>
  Effect.gen(function* () {
    const registry = registryWith({
      listEnvironments: () =>
        Effect.succeed([
          { id: "default", name: "Default", repos: [], createdAt: 1 },
          { id: "work", name: "Work", repos: [], createdAt: 1 },
        ]),
    });

    registry.mount(environmentsAtom);
    yield* settled(registry, environmentsAtom);
    registry.set(skillsToInstallAtom, pending);

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <InstallSkillsDialog />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

describe("the install target picker", () => {
  it.effect("offers Every environment first, then each Environment, for one picked Skill", () =>
    Effect.gen(function* () {
      const markup = yield* render({ source: "mattpocock/skills", skills: ["grill-me"] });

      expect(markup).toContain("Install grill-me");
      expect(markup).toMatch(
        /<option value="\*"[^>]*>Every environment<\/option><option value="default"[^>]*>Default<\/option><option value="work"[^>]*>Work<\/option>/,
      );
      expect(markup).toContain("mattpocock/skills");
      expect(markup).toContain("Only this skill is");
      expect(markup).toContain("no approval is asked");
      expect(markup).toContain(">Install</button>");
    }),
  );

  it.effect("says which ref it installs from, or the default branch", () =>
    Effect.gen(function* () {
      const named = yield* render({ source: "o/skills", skills: ["a"], ref: "v2" });
      const none = yield* render({ source: "o/skills", skills: ["a"] });

      expect(named).toContain("latest commit of <span");
      expect(named).toContain(">v2</span>");
      expect(none).toContain("its default branch");
    }),
  );

  it.effect("says how many Skills it installs when several are picked", () =>
    Effect.gen(function* () {
      const markup = yield* render({ source: "o/skills", skills: ["a", "b"] });

      expect(markup).toContain("Install 2 skills");
      expect(markup).toContain("Only the picked skills are");
    }),
  );

  it.effect("shows nothing while no Skill is being installed", () =>
    Effect.gen(function* () {
      expect(yield* render(null)).not.toContain("Every environment");
    }),
  );
});
