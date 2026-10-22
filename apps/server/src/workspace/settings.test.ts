// A Workspace's own settings in its Durable Object's storage (docs/spec.md → Container and Toolchains → Size and idle).
// @effect-diagnostics asyncFunction:off
import { DEFAULT_MACHINE_SETTINGS } from "@cloudpid/config";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { workspaceSettingsStore } from "./settings.ts";

const open = (initial?: Schema.Json) => {
  const kept = new Map<string, Schema.Json>();

  if (initial !== undefined) kept.set("cloudpid:workspace-settings", initial);

  const store = workspaceSettingsStore({
    // SAFETY: the store asks for the one key it keeps, and reads it as the JSON it wrote.
    get: async <T>(key: string) => kept.get(key) as T | undefined,
    put: async (key: string, value: Schema.Json) => {
      kept.set(key, value);
    },
  });

  return { store, kept };
};

describe("workspaceSettingsStore", () => {
  it("reads the defaults from a Workspace that saved nothing", async () => {
    const { store } = open();

    expect(await store.read()).toEqual({ settings: DEFAULT_MACHINE_SETTINGS, overrides: {} });
  });

  it("saves overrides and reads them back as the settings in force", async () => {
    const { store } = open();

    const answer = await store.write({ instance: "standard-4", idleMinutes: 45 });

    expect(answer).toEqual({
      ok: true,
      state: {
        settings: { instance: "standard-4", idleMinutes: 45, ignore: [] },
        overrides: { instance: "standard-4", idleMinutes: 45 },
      },
    });
    expect((await store.read()).settings).toEqual({
      instance: "standard-4",
      idleMinutes: 45,
      ignore: [],
    });
  });

  it("keeps only what differs from the defaults, so a setting left alone follows later defaults", async () => {
    const { store, kept } = open();

    await store.write({ instance: "custom-2", idleMinutes: 15 });

    expect(kept.get("cloudpid:workspace-settings")).toEqual({ idleMinutes: 15 });
  });

  it("keeps standard-2, the former default, as a saved size once it is chosen", async () => {
    const { store, kept } = open();

    await store.write({ instance: "standard-2", idleMinutes: 5 });

    expect(kept.get("cloudpid:workspace-settings")).toEqual({ instance: "standard-2" });
    expect((await store.read()).settings.instance).toBe("standard-2");
  });

  it("refuses overrides that do not resolve, one problem per line, and saves nothing", async () => {
    const { store, kept } = open();

    const answer = await store.write({ instance: "huge", idleMinutes: 0 });

    expect(answer.ok).toBe(false);

    if (!answer.ok) expect(answer.message.split("\n")).toHaveLength(2);

    expect(kept.size).toBe(0);
  });

  it("reads overrides a later release no longer accepts leniently, and says what it left out", async () => {
    const { store } = open({ instance: "retired-1", idleMinutes: 30 });

    const state = await store.read();

    expect(state.settings).toEqual({ instance: "custom-2", idleMinutes: 30, ignore: [] });
    expect(state.problem).toContain("instance");
  });
});
