// The branch summary prompt follows the Session's own settings (ADR-0027): its Environment's, over Global's.

import { DEFAULT_SETTINGS } from "@cloudpid/config";
import type { SessionRecord } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { registryWith, settled } from "../registry.testing.ts";
import { sessionsAtom } from "../sessions.ts";
import { settingsAtom, settingsOverridesAtom } from "../settings.ts";
import { skipSummaryPromptAtom } from "./tree-state.ts";

const STAGING = "5a5a5a5a";

const session = (id: string, environment: string): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  environment,
  workspace: `w-${id}`,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

describe("the branch summary prompt", () => {
  it.effect(
    "is skipped for a Session whose Environment overrides it, and asked for one that inherits Global's",
    () =>
      Effect.gen(function* () {
        const skipping = {
          ...DEFAULT_SETTINGS,
          branchSummary: { skipPrompt: true },
        };

        const registry = registryWith({
          listSessions: () =>
            Effect.succeed([session("s-staging", STAGING), session("s-default", "default")]),
          getSettings: () =>
            Effect.succeed({ settings: DEFAULT_SETTINGS, overrides: {}, overriddenIn: {} }),
          getSettingsOverrides: ({ environment }) =>
            Effect.succeed({
              environment,
              settings: environment === STAGING ? skipping : DEFAULT_SETTINGS,
              global: DEFAULT_SETTINGS,
              overrides: environment === STAGING ? { branchSummary: { skipPrompt: true } } : {},
            }),
        });

        registry.mount(skipSummaryPromptAtom("s-staging"));
        registry.mount(skipSummaryPromptAtom("s-default"));
        yield* settled(registry, sessionsAtom);
        yield* settled(registry, settingsAtom);
        yield* settled(registry, settingsOverridesAtom(STAGING));
        yield* settled(registry, settingsOverridesAtom("default"));

        expect(registry.get(skipSummaryPromptAtom("s-staging"))).toBe(true);
        expect(registry.get(skipSummaryPromptAtom("s-default"))).toBe(false);
      }),
  );
});
