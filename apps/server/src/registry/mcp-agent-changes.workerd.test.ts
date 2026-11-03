// The agent's ordinary MCP changes in the Registry (`docs/architecture/mcp-configuration.md` → The agent's changes → Scopes and
// layers, Records and revert; `docs/architecture/agent-changes.md` → MCP server changes), over real Durable Object SQLite:
// `mcp.servers.<name>.enabled|exposure|toolExposure` changed at Global and at an Environment (an adjustment of Global's server,
// or a key of the Environment's own entry), recorded with the key's value before and after and whether it is inherited, reverted
// by the owner unless the key has changed since; and `mcpChangeCheck`, which says per Environment whether a change reaches it
// and whether it makes something reachable that was not.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT, SETTINGS_SCOPE } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import { mcpChangeCheck } from "./mcp-change-check.ts";
import { mcpSettingsView } from "./mcp-settings-view.ts";
import { readSettingsOverrides, updateSettingsOverrides, writeSettings } from "./settings.ts";
import {
  changeSettings,
  changeSettingsOverrides,
  revertSettingsChange,
  type SettingsFieldChange,
} from "./settings-changes.ts";
import { noSkills, type TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const STAGING = "5a5a5a5a";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "settings_mcp_disable",
  reason: "Not needed",
};

const FILES = { command: "node", args: ["files.js"] };
const DOCS = { url: "https://docs.example/mcp", toolExposure: { "delete_*": "hidden" } };

const field = (key: string, name = "files") => `mcp.servers.${name}.${key}`;

const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly setGlobal: (overrides: Schema.Json) => void;
    readonly setOverrides: (environment: string, overrides: Schema.Json) => void;
    readonly changeGlobal: (
      changes: ReadonlyArray<SettingsFieldChange>,
    ) => ReturnType<typeof changeSettings>;
    readonly changeAt: (
      environment: string,
      changes: ReadonlyArray<SettingsFieldChange>,
    ) => ReturnType<typeof changeSettingsOverrides>;
    readonly revertGlobal: (id: number) => ReturnType<typeof revertSettingsChange>;
    readonly revertAt: (environment: string, id: number) => ReturnType<typeof revertAgentChange>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const { storage } = state;
    const store = openRegistryStore(storage);
    const changes = openAgentChanges(storage);

    store.createEnvironment(STAGING, "Staging", 10);

    return body({
      store,
      storage,
      changes,
      setGlobal: (overrides) => {
        if (Result.isFailure(writeSettings(store, overrides, 5))) throw new Error("bad Global");
      },
      setOverrides: (environment, overrides) => {
        const saved = updateSettingsOverrides(storage, store, environment, { set: overrides });

        if (saved === null || Result.isFailure(saved)) throw new Error("bad Overrides");
      },
      changeGlobal: (wanted) =>
        changeSettings(storage, store, changes, { changes: wanted, author }, 1_000),
      changeAt: (environment, wanted) =>
        changeSettingsOverrides(
          storage,
          store,
          changes,
          { environment, changes: wanted, author },
          1_000,
        ),
      revertGlobal: (id) => revertSettingsChange(storage, store, changes, { id }, 2_000),
      revertAt: (environment, id) =>
        revertAgentChange(storage, store, changes, { environment, id }, 2_000, noSkills(storage)),
    });
  });

const changed = (answer: { readonly status: string }) => {
  if (answer.status !== "changed") throw new Error(`not changed: ${JSON.stringify(answer)}`);

  // SAFETY: the status was checked just above.
  return answer as Extract<ReturnType<typeof changeSettings>, { status: "changed" }>;
};

describe("the agent's change of a key at Global", () => {
  it("is recorded under the Settings with the key as stored, and reverted while the key is as it left it", () =>
    inRegistry(({ setGlobal, store, changeGlobal, revertGlobal, changes }) => {
      setGlobal({ mcp: { servers: { files: FILES } } });

      const [made] = changed(changeGlobal([{ field: field("enabled"), value: false }])).changes;

      expect(made).toMatchObject({
        scope: SETTINGS_SCOPE,
        field: field("enabled"),
        before: null,
        after: false,
        actor: "agent",
      });

      expect(made?.beforeInherited).toBeUndefined();
      expect(store.getDocument("settings")).toContain('"enabled":false');

      const reverted = revertGlobal(made?.id ?? 0);

      expect(reverted.status).toBe("reverted");
      // The key it did not have is not written back.
      expect(store.getDocument("settings")).not.toContain("enabled");
      expect(changes.get(SETTINGS_SCOPE, made?.id ?? 0)?.revertedBy).not.toBeNull();
    }));

  it("is refused once the key has changed since", () =>
    inRegistry(({ setGlobal, changeGlobal, revertGlobal }) => {
      setGlobal({ mcp: { servers: { files: FILES } } });

      const [made] = changed(changeGlobal([{ field: field("exposure"), value: "direct" }])).changes;

      setGlobal({ mcp: { servers: { files: { ...FILES, exposure: "deferred" } } } });

      expect(revertGlobal(made?.id ?? 0)).toEqual({
        status: "changed-since",
        field: field("exposure"),
        current: "deferred",
      });
    }));

  it("keeps the whole toolExposure map as one value, in order", () =>
    inRegistry(({ setGlobal, changeGlobal, store }) => {
      setGlobal({ mcp: { servers: { docs: DOCS } } });

      const [made] = changed(
        changeGlobal([
          {
            field: field("toolExposure", "docs"),
            value: { "get_*": "direct", "delete_*": "hidden" },
          },
        ]),
      ).changes;

      expect(made?.before).toEqual({ "delete_*": "hidden" });
      expect(made?.after).toEqual({ "get_*": "direct", "delete_*": "hidden" });
      expect(Record.keys(Predicate.isObject(made?.after) ? made.after : {})).toEqual([
        "get_*",
        "delete_*",
      ]);
      expect(store.getDocument("settings")).toContain("get_*");
    }));

  it("rejects a key of a server Global does not define", () =>
    inRegistry(({ changeGlobal }) => {
      expect(changeGlobal([{ field: field("enabled", "ghost"), value: false }]).status).toBe(
        "rejected",
      );
    }));
});

describe("the agent's change of a key at an Environment", () => {
  it("writes an adjustment of Global's server, an Override even when equal to Global's, inherited before and not after", () =>
    inRegistry(({ setGlobal, changeAt, revertAt, store, changes }) => {
      setGlobal({ mcp: { servers: { files: { ...FILES, enabled: false } } } });

      const [made] = changed(
        changeAt(STAGING, [{ field: field("enabled"), value: false }]),
      ).changes;

      expect(made).toMatchObject({
        scope: STAGING,
        before: false,
        after: false,
        beforeInherited: true,
      });

      expect(made?.afterInherited).not.toBe(true);

      expect(store.getSettingsOverrides(STAGING)).toEqual({
        mcp: { servers: { files: { enabled: false } } },
      });

      expect(revertAt(STAGING, made?.id ?? 0).status).toBe("reverted");
      // Resetting the last key removes the adjustment.
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
      expect(changes.get(STAGING, made?.id ?? 0)?.revertedBy).not.toBeNull();
    }));

  it("refuses the revert once the adjustment is another value, or is gone", () =>
    inRegistry(({ setGlobal, changeAt, revertAt, setOverrides }) => {
      setGlobal({ mcp: { servers: { files: FILES } } });

      const [made] = changed(
        changeAt(STAGING, [{ field: field("exposure"), value: "hidden" }]),
      ).changes;

      setOverrides(STAGING, { mcp: { servers: { files: { exposure: "direct" } } } });

      expect(revertAt(STAGING, made?.id ?? 0)).toMatchObject({
        status: "changed-since",
        field: field("exposure"),
        current: "direct",
      });
    }));

  it("writes the key inside the Environment's own entry, never inherited, and reverts it by dropping the key it had not written", () =>
    inRegistry(({ setOverrides, changeAt, revertAt, store }) => {
      setOverrides(STAGING, { mcp: { servers: { files: FILES } } });

      const [made] = changed(
        changeAt(STAGING, [{ field: field("enabled"), value: false }]),
      ).changes;

      expect(made).toMatchObject({
        before: null,
        after: false,
      });

      // Never inherited, though the key it did not write reads as its default.
      expect(made?.beforeInherited).not.toBe(true);
      expect(made?.afterInherited).not.toBe(true);

      expect(store.getSettingsOverrides(STAGING)).toEqual({
        mcp: { servers: { files: { ...FILES, enabled: false } } },
      });

      expect(revertAt(STAGING, made?.id ?? 0).status).toBe("reverted");
      expect(store.getSettingsOverrides(STAGING)).toEqual({ mcp: { servers: { files: FILES } } });
    }));

  it("records the whole toolExposure map of an adjustment and resets it with settings_reset's reset", () =>
    inRegistry(({ setGlobal, changeAt, store }) => {
      setGlobal({ mcp: { servers: { docs: DOCS } } });

      const [made] = changed(
        changeAt(STAGING, [
          {
            field: field("toolExposure", "docs"),
            value: { "get_*": "direct", "delete_*": "hidden" },
          },
        ]),
      ).changes;

      expect(made).toMatchObject({
        before: { "delete_*": "hidden" },
        after: { "get_*": "direct", "delete_*": "hidden" },
        beforeInherited: true,
      });

      expect(made?.afterInherited).not.toBe(true);

      const [reset] = changed(
        changeAt(STAGING, [
          {
            field: field("toolExposure", "docs"),
            value: null,
            reset: true,
            expected: { value: made?.after ?? null, inherited: false },
          },
        ]),
      ).changes;

      expect(reset).toMatchObject({ afterInherited: true, after: { "delete_*": "hidden" } });
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
    }));

  it("answers changed-since for a key that is not as the agent saw it", () =>
    inRegistry(({ setGlobal, changeAt }) => {
      setGlobal({ mcp: { servers: { files: FILES } } });

      expect(
        changeAt(STAGING, [
          {
            field: field("enabled"),
            value: false,
            expected: { value: null, inherited: false },
          },
        ]),
      ).toMatchObject({ status: "changed-since", inherited: true });
    }));
});

describe("mcpChangeCheck", () => {
  it("at Global reaches every Environment but those whose own entry overrides, and finds no widening in a switch-off", () =>
    inRegistry(({ setGlobal, setOverrides, store }) => {
      setGlobal({ mcp: { servers: { files: FILES } } });
      setOverrides(STAGING, { mcp: { servers: { files: { command: "other" } } } });

      const check = mcpChangeCheck(store, {
        environment: undefined,
        name: "files",
        changes: [{ field: field("enabled"), value: false }],
      });

      expect(check?.environments.map((each) => [each.environment.id, each.reached])).toEqual(
        expect.arrayContaining([
          [DEFAULT_ENVIRONMENT, true],
          [STAGING, false],
        ]),
      );

      expect(check?.environments.every((each) => each.widening.length === 0)).toBe(true);
    }));

  it("finds the widening of switching on, unhiding and a reset that falls back to on", () =>
    inRegistry(({ setGlobal, setOverrides, store }) => {
      setGlobal({
        mcp: {
          servers: { files: { ...FILES, enabled: false }, docs: { ...DOCS, exposure: "hidden" } },
        },
      });

      const on = mcpChangeCheck(store, {
        environment: undefined,
        name: "files",
        changes: [{ field: field("enabled"), value: true }],
      });

      expect(on?.environments[0]?.widening).toEqual([{ kind: "switched_on" }]);

      const unhidden = mcpChangeCheck(store, {
        environment: DEFAULT_ENVIRONMENT,
        name: "docs",
        changes: [{ field: field("exposure", "docs"), value: "direct" }],
      });

      expect(unhidden?.environments[0]?.widening).toEqual([{ kind: "exposure_unhidden" }]);

      // An adjustment that switched Global's server off: its reset falls back to on.
      setGlobal({ mcp: { servers: { files: FILES } } });
      setOverrides(STAGING, { mcp: { servers: { files: { enabled: false } } } });

      const reset = mcpChangeCheck(store, {
        environment: STAGING,
        name: "files",
        changes: [{ field: field("enabled"), value: null, reset: true }],
      });

      expect(reset?.environments[0]?.widening).toEqual([{ kind: "switched_on" }]);
    }));

  it("finds none for an orphaned adjustment's reset, and null for an unknown Environment", () =>
    inRegistry(({ setOverrides, store }) => {
      setOverrides(STAGING, { mcp: { servers: { gone: { enabled: false } } } });

      expect(
        mcpChangeCheck(store, {
          environment: STAGING,
          name: "gone",
          changes: [{ field: field("enabled", "gone"), value: null, reset: true }],
        })?.environments,
      ).toEqual([]);

      expect(
        mcpChangeCheck(store, { environment: "00000000", name: "gone", changes: [] }),
      ).toBeNull();

      expect(readSettingsOverrides(store, STAGING)).not.toBeNull();
    }));
});

describe("mcpSettingsView of a name Global does not have", () => {
  it("names the Environments that define it", () =>
    inRegistry(({ setOverrides, store }) => {
      setOverrides(STAGING, { mcp: { servers: { files: FILES } } });

      const view = mcpSettingsView(
        store,
        { get: () => null },
        { environment: undefined, name: "files" },
        1,
      );

      expect(view?.servers).toEqual([]);
      expect(view?.definedIn).toEqual([{ id: STAGING, name: "Staging" }]);
    }));
});
