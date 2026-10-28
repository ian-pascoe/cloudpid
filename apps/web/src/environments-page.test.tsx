// The Environments page's Edit dialog (`docs/architecture/container.md` → Container settings), rendered with
// `react-dom/server` over the fake Registry: its Container fields show the Spare Workspace setting as saved, with the
// trade-off it makes.

import { type ContainerSettings, DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { EditEnvironmentDialog } from "./environments-page.tsx";
import {
  environmentDraftAtom,
  environmentsAtom,
  environmentSettingsAtom,
  globalSettingsAtom,
} from "./environments-state.ts";
import { registryWith, settled } from "./registry.testing.ts";

const WORK = { id: "work", name: "Work", repos: [], createdAt: 1 };

/** The Edit dialog of Environment `work`, whose saved settings are `settings`, once they have answered. */
const render = (settings: ContainerSettings, draft?: { readonly spareWorkspace: boolean }) =>
  Effect.gen(function* () {
    const registry = registryWith({
      listEnvironments: () => Effect.succeed([WORK]),
      getEnvironmentSettings: () =>
        Effect.succeed({ settings, global: DEFAULT_CONTAINER_SETTINGS, overrides: {} }),
      getGlobalContainerSettings: () =>
        Effect.succeed({
          settings: DEFAULT_CONTAINER_SETTINGS,
          overrides: {},
          overriddenIn: {},
        }),
    });

    registry.mount(environmentsAtom);
    registry.mount(environmentSettingsAtom(WORK.id));
    registry.mount(globalSettingsAtom);
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, environmentSettingsAtom(WORK.id));
    yield* settled(registry, globalSettingsAtom);

    if (draft !== undefined) {
      registry.set(environmentDraftAtom(WORK.id), {
        ...registry.get(environmentDraftAtom(WORK.id)),
        ...draft,
      });
    }

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <EditEnvironmentDialog environment={WORK} otherNames={[]} />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

/** The Save button's own tag in `markup`. */
const saveButton = (markup: string): string =>
  markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";

/** The Spare Workspace checkbox's own tag in `markup`. */
const spareBox = (markup: string): string =>
  markup.match(/<input id="spare-work"[^>]*>/)?.[0] ?? "";

describe("the Edit dialog", () => {
  it.effect(
    "shows the Spare Workspace on by default, with the trade-off between new Sessions and Container time",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(DEFAULT_CONTAINER_SETTINGS);

        expect(spareBox(markup)).toContain('type="checkbox"');
        expect(spareBox(markup)).toContain("checked");
        expect(markup).toContain("Keep a Spare Workspace ready");
        expect(markup).toContain("without waiting for the clones and Setup Scripts");
        expect(markup).toContain("Container time each spare takes to prepare");
      }),
  );

  it.effect("shows the Spare Workspace off when it was saved off", () =>
    Effect.gen(function* () {
      const markup = yield* render({ ...DEFAULT_CONTAINER_SETTINGS, spareWorkspace: false });

      expect(spareBox(markup)).not.toBe("");
      expect(spareBox(markup)).not.toContain("checked");
    }),
  );

  it.effect("can save once the Spare Workspace is switched, and not before", () =>
    Effect.gen(function* () {
      const untouched = yield* render(DEFAULT_CONTAINER_SETTINGS);
      const switched = yield* render(DEFAULT_CONTAINER_SETTINGS, { spareWorkspace: false });

      expect(saveButton(untouched)).toContain(' disabled=""');
      expect(spareBox(switched)).not.toContain("checked");
      expect(saveButton(switched)).not.toBe("");
      expect(saveButton(switched)).not.toContain(' disabled=""');
    }),
  );
});
