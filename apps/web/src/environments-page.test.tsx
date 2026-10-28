// The Environments page's Edit dialog (`docs/architecture/container.md` → Container settings), rendered with
// `react-dom/server` over the fake Registry: its Container fields show the Spare Workspace setting as saved, with the
// trade-off it makes, and the variables are the Environment's own, those at Global named apart.

import {
  type ContainerSettings,
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { EditEnvironmentDialog, VariablesSummary } from "./environments-page.tsx";
import {
  environmentDraftAtom,
  environmentsAtom,
  environmentSettingsAtom,
  globalSettingsAtom,
} from "./environments-state.ts";
import { registryWith, settled } from "./registry.testing.ts";

const WORK = { id: "work", name: "Work", repos: [], createdAt: 1 };

/** Global's settings and Environment `work`'s Overrides of them, when a test has some. */
type Scopes = {
  readonly global: ContainerSettings;
  readonly overrides: ContainerSettingsOverrides;
};

/** Global with the variable `SHARED`, and `work` with its own `OWN` over it. */
const WITH_GLOBAL_VARIABLES: Scopes = {
  global: { ...DEFAULT_CONTAINER_SETTINGS, variables: { SHARED: "global" } },
  overrides: { variables: { OWN: "work" } },
};

/** A fake Registry answering `work`'s settings in force `settings`, over `scopes`. */
const registryOf = (
  settings: ContainerSettings,
  { global, overrides }: Scopes = { global: DEFAULT_CONTAINER_SETTINGS, overrides: {} },
) =>
  registryWith({
    listEnvironments: () => Effect.succeed([WORK]),
    getEnvironmentSettings: () => Effect.succeed({ settings, global, overrides }),
    getGlobalContainerSettings: () =>
      Effect.succeed({ settings: global, overrides: {}, overriddenIn: {} }),
  });

/**
 * The Edit dialog of Environment `work`, whose settings in force are `settings` (over `scopes`), once they have
 * answered.
 */
const render = (
  settings: ContainerSettings,
  draft?: { readonly spareWorkspace: boolean },
  scopes?: Scopes,
) =>
  Effect.gen(function* () {
    const registry = registryOf(settings, scopes);

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

  it.effect(
    "shows only the Environment's own variables, and nothing to save while they are untouched",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(
          resolveEnvironmentContainerSettings(
            WITH_GLOBAL_VARIABLES.global,
            WITH_GLOBAL_VARIABLES.overrides,
          ),
          undefined,
          WITH_GLOBAL_VARIABLES,
        );

        expect(markup).toContain("OWN=work");
        expect(markup).not.toContain("SHARED=global");
        expect(saveButton(markup)).toContain(' disabled=""');
      }),
  );
});

describe("the variables of an Environment's card", () => {
  it.effect("names its own, then those it gets from Global", () =>
    Effect.gen(function* () {
      const registry = registryOf(
        resolveEnvironmentContainerSettings(
          WITH_GLOBAL_VARIABLES.global,
          WITH_GLOBAL_VARIABLES.overrides,
        ),
        WITH_GLOBAL_VARIABLES,
      );

      registry.mount(environmentSettingsAtom(WORK.id));
      registry.mount(globalSettingsAtom);
      yield* settled(registry, environmentSettingsAtom(WORK.id));
      yield* settled(registry, globalSettingsAtom);

      const markup = renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <VariablesSummary id={WORK.id} />
        </RegistryContext.Provider>,
      );

      registry.dispose();

      expect(markup).toContain('<p class="font-mono text-xs">OWN</p>');
      expect(markup).toContain('Also from Global: <span class="font-mono">SHARED</span>');
    }),
  );
});
