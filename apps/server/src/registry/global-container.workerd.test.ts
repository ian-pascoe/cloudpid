// The Container settings at Global and each Environment's Overrides (ADR-0027; `docs/architecture/container.md` →
// Container settings), over real Durable Object SQLite: what Environments stored before Global held their Container
// settings resolve exactly as they did, so a deploy hands every Workspace the same settings and asks for no Build, and
// the Agent changes recorded before then are marked inherited where they recorded the default (migration 26).
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off cryptoRandomUUID:off
import { runInDurableObject } from "cloudflare:test";
import {
  resolveContainerOverridesLeniently,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { buildKey } from "../workspace/build-record.ts";
import { GLOBAL_DOCUMENT, globalSettingsOf, workspaceOverridesOf } from "./global.ts";
import { openAgentChanges } from "./agent-changes.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { MIGRATIONS, migrate, openRegistryStore, type RegistryStore } from "./store.ts";

/** What Environments stored before Global held Container settings: each a shape a release saved, as text. */
const STORED: ReadonlyArray<{
  readonly id: string;
  readonly repos: ReadonlyArray<string>;
  readonly settings: string;
}> = [
  // Nothing saved: every default.
  { id: "0000000a", repos: [], settings: "{}" },
  // A size under the name it had before the rename.
  { id: "0000000b", repos: ["app"], settings: '{"instance":"custom-2"}' },
  // A size above the default limit, saved before there was a limit: its size is its limit.
  { id: "0000000c", repos: [], settings: '{"instance":"standard-3"}' },
  { id: "0000000d", repos: [], settings: '{"spareWorkspace":false,"idleMinutes":30}' },
  {
    id: "0000000e",
    repos: ["app", "api"],
    settings: JSON.stringify({
      instance: "standard-3",
      maxInstance: "standard-4",
      ignore: ["/data", "**/node_modules"],
      setupScript: "apt-get install -y jq",
      startScript: "redis-server --daemonize yes",
      toolchains: '[tools]\nnode = "22"',
    }),
  },
  // Variables of its own over the Global ones, and overrides a later release no longer accepts.
  {
    id: "0000000f",
    repos: [],
    settings: JSON.stringify({
      variables: { A: "own", B: "own" },
      idleMinutes: "5m",
      retired: true,
    }),
  },
];

/** What every Environment stored resolves to: what its Workspaces are handed, its Build key, and whether it keeps a spare. */
type Resolved = {
  readonly handed: Schema.Json | null;
  readonly key: string;
  readonly spare: boolean;
};

/**
 * The settings a Build of `environment` is made with, as the Build upkeep resolves them: what `buildWork` hands it,
 * resolved as `buildSettingsOf` does (`builds.ts` itself does not load here).
 */
const buildSettings = (store: RegistryStore, environment: string) =>
  resolveEnvironmentContainerSettings(
    globalSettingsOf(store),
    resolveContainerOverridesLeniently(store.getEnvironmentSettings(environment) ?? {}).overrides,
  );

const resolveStored = () =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);

      store.putDocument(
        GLOBAL_DOCUMENT,
        JSON.stringify({ variables: { A: "global", C: "global" } }),
        1_000,
      );

      for (const { id, repos, settings } of STORED) {
        store.createEnvironment(id, `Environment ${id}`, 1_000);

        for (const repo of repos) {
          store.addRepo(id, { name: repo, url: `https://github.com/o/${repo}.git` });
        }

        state.storage.sql.exec("UPDATE environments SET settings = ? WHERE id = ?", settings, id);
        // A Session lately, so the upkeep makes a spare for each Environment that keeps one.
        store.createSession(
          {
            id: `s-${id}`,
            title: null,
            workspace: {
              kind: "new",
              id: id.replace("0000", "1111"),
              environment: id,
              branch: `cloudpid/${id}`,
              base: null,
            },
          },
          2_000,
        );
      }

      const spares = new Set(
        store
          .upkeepSpares(
            STORED.map(({ id }) => id),
            () => crypto.randomUUID().slice(0, 8),
            3_000,
            globalSettingsOf(store),
          )
          .made.map((made) => made.environment),
      );

      const resolved: Record<string, Resolved> = {};

      for (const { id } of STORED) {
        const record = store.getEnvironment(id);

        resolved[id] = {
          handed: workspaceOverridesOf(store, id)?.overrides ?? null,
          key: await buildKey({
            repos: record?.repos ?? [],
            settings: buildSettings(store, id),
            image: "img-1",
          }),
          spare: spares.has(id),
        };
      }

      return {
        resolved,
        defaultHanded: workspaceOverridesOf(store, DEFAULT_ENVIRONMENT)?.overrides,
      };
    },
  );

describe("Environments stored before Global held their Container settings", () => {
  it("resolve as they did: the same settings handed, the same Build keys, the same spares", async () => {
    const { resolved, defaultHanded } = await resolveStored();

    expect(defaultHanded).toEqual({ variables: { A: "global", C: "global" } });
    // Recorded from the release before Global held Container settings: what each Environment resolved to then.
    const globalVariables = { A: "global", C: "global" };
    const noRepoKey = "663552dcc537ada3ea242f3bf2b087f0fda554d60dd87e8f56620ba86ed8a2ab";

    expect(resolved).toEqual({
      "0000000a": { handed: { variables: globalVariables }, key: noRepoKey, spare: true },
      "0000000b": {
        handed: { instance: "cpu-2", variables: globalVariables },
        key: "d3e67f4ccec0ea50425f9a4e7def7900ce806294befc0a7545d6307c391c5568",
        spare: true,
      },
      "0000000c": {
        handed: { instance: "standard-3", maxInstance: "standard-3", variables: globalVariables },
        key: noRepoKey,
        spare: true,
      },
      "0000000d": {
        handed: { idleMinutes: 30, variables: globalVariables, spareWorkspace: false },
        key: noRepoKey,
        spare: false,
      },
      "0000000e": {
        handed: {
          instance: "standard-3",
          maxInstance: "standard-4",
          ignore: ["/data", "**/node_modules"],
          variables: globalVariables,
          setupScript: "apt-get install -y jq",
          startScript: "redis-server --daemonize yes",
          toolchains: '[tools]\nnode = "22"',
        },
        key: "2b20ec421a37e909edcaaaca8357eba52f88d2748528f0d2de9f1f30b63b77f7",
        spare: true,
      },
      "0000000f": {
        handed: { variables: { A: "own", B: "own", C: "global" } },
        key: "6d42d6090e398f86cf62c009ceca49231d61b7793321c7a0e9c4fb51ab0d9950",
        spare: true,
      },
    });
  });
});

describe("Agent changes recorded before Global held Container settings", () => {
  it("mark a Container setting's value that was the default then as inherited, keeping every value", async () => {
    const listed = await runInDurableObject(
      env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
      async (_: TestRegistry, state) => {
        const { storage } = state;
        const { sql } = storage;

        for (const { name } of sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray()) {
          sql.exec(`DROP TABLE "${name}"`);
        }

        // The tables as they were before migration 26, with what a release before it recorded.
        migrate(storage, MIGRATIONS.slice(0, 25));

        const rows: ReadonlyArray<readonly [string, string, string | null, string | null]> = [
          ["default", "maxInstance", '"custom-2"', '"custom-3"'],
          ["default", "idleMinutes", "2", "30"],
          ["default", "setupScript", '"apt-get install -y jq"', '""'],
          ["default", "spareWorkspace", "true", "false"],
          ["default", "variables.A", null, '"x"'],
          ["default", "instance", '"cpu-2"', '"standard-3"'],
          ["*", "variables.B", null, '"y"'],
        ];

        for (const [scope, field, before, after] of rows) {
          sql.exec(
            `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts, approved)
             VALUES (?, 1, 'agent', 's-1', 1, 'tool', 'why', ?, ?, ?, NULL, 0)`,
            scope,
            field,
            before,
            after,
          );
        }

        migrate(storage);

        const changes = openAgentChanges(storage);

        return [...changes.list("default"), ...changes.list("*")].map(
          ({ field, before, after, beforeInherited, afterInherited }) => ({
            field,
            before,
            after,
            beforeInherited: beforeInherited === true,
            afterInherited: afterInherited === true,
          }),
        );
      },
    );

    expect(listed).toEqual([
      {
        field: "instance",
        before: "cpu-2",
        beforeInherited: false,
        after: "standard-3",
        afterInherited: false,
      },
      {
        field: "variables.A",
        before: null,
        beforeInherited: false,
        after: "x",
        afterInherited: false,
      },
      {
        field: "spareWorkspace",
        before: true,
        beforeInherited: true,
        after: false,
        afterInherited: false,
      },
      {
        field: "setupScript",
        before: "apt-get install -y jq",
        beforeInherited: false,
        after: "",
        afterInherited: true,
      },
      { field: "idleMinutes", before: 2, beforeInherited: true, after: 30, afterInherited: false },
      {
        field: "maxInstance",
        before: "cpu-2",
        beforeInherited: true,
        after: "cpu-3",
        afterInherited: false,
      },
      {
        field: "variables.B",
        before: null,
        beforeInherited: false,
        after: "y",
        afterInherited: false,
      },
    ]);
  });
});
