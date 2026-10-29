// Settings at two Scopes over real Durable Object SQLite (ADR-0027, `docs/architecture/overview.md` → Settings): an
// Environment's Overrides saved explicitly (even equal to Global) and reset, the Environments Global names as overriding
// each field, the agent's changes of them recorded under the Environment with whether the field was inherited, and the
// owner's revert of those. And the deploy: Settings stored before resolve the same for every Session.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_SETTINGS, resolveLeniently, resolveOverridesLeniently } from "@cloudpid/config";
import { DEFAULT_ENVIRONMENT, SETTINGS_SCOPE } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import {
  putEnvironmentInstructions,
  readSettings,
  readSettingsOverrides,
  sessionSettingsSource,
  SETTINGS_DOCUMENT,
  settingsOverriddenIn,
  updateSettingsOverrides,
  writeSettings,
} from "./settings.ts";
import {
  changeSettings,
  changeSettingsOverrides,
  revertSettingsChange,
  type SettingsFieldChange,
} from "./settings-changes.ts";
import { noSkills, type TestRegistry } from "./store.fixture.ts";
import { MIGRATIONS, migrate, openRegistryStore } from "./store.ts";

const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";

const STAGING = "5a5a5a5a";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "settings_model_set",
  reason: "This Environment's work is small",
};

/** Run `body` over a fresh Registry's store, Agent changes and storage, with an Environment `STAGING` beside Default. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly update: (
      environment: string,
      change: { readonly set?: Schema.Json; readonly reset?: ReadonlyArray<string> },
    ) => ReturnType<typeof updateSettingsOverrides>;
    readonly setGlobal: (overrides: Schema.Json) => void;
    readonly change: (
      changes: ReadonlyArray<SettingsFieldChange>,
      environment?: string,
      at?: number,
    ) => ReturnType<typeof changeSettingsOverrides>;
    readonly revert: (id: number, environment?: string) => ReturnType<typeof revertAgentChange>;
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
      update: (environment, change) => updateSettingsOverrides(storage, store, environment, change),
      setGlobal: (overrides) => {
        if (Result.isFailure(writeSettings(store, overrides, 5))) throw new Error("bad Global");
      },
      change: (wanted, environment = STAGING, at = 1_000) =>
        changeSettingsOverrides(
          storage,
          store,
          changes,
          { environment, changes: wanted, author },
          at,
        ),
      revert: (id, environment = STAGING) =>
        revertAgentChange(storage, store, changes, { environment, id }, 2_000, noSkills(storage)),
    });
  });

const saved = <A>(result: Result.Result<A, { readonly message: string }> | null): A => {
  if (result === null) throw new Error("No such Environment");

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

describe("an Environment's Settings Overrides", () => {
  it("inherit Global until set, stay pinned when set equal to Global, and inherit again once reset", () =>
    inRegistry(({ update, setGlobal, store }) => {
      setGlobal({ model: SONNET });

      expect(readSettingsOverrides(store, STAGING)).toEqual({
        environment: STAGING,
        settings: { ...DEFAULT_SETTINGS, model: SONNET },
        global: { ...DEFAULT_SETTINGS, model: SONNET },
        overrides: {},
        instructions: "",
      });

      expect(saved(update(STAGING, { set: { model: SONNET } })).overrides).toEqual({
        model: SONNET,
      });

      setGlobal({ model: HAIKU });
      expect(readSettingsOverrides(store, STAGING)?.settings.model).toBe(SONNET);
      expect(readSettingsOverrides(store, DEFAULT_ENVIRONMENT)?.settings.model).toBe(HAIKU);

      expect(saved(update(STAGING, { reset: ["model"] })).settings.model).toBe(HAIKU);
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
    }));

  it("override Roles one by one and extension options key by key", () =>
    inRegistry(({ update, setGlobal }) => {
      setGlobal({ extensions: { subagents: { readToolset: ["read"] } } });

      const state = saved(
        update(STAGING, {
          set: {
            roles: { small: { model: OPUS } },
            extensions: { subagents: { maxSubagentDepth: 1 } },
          },
        }),
      );

      expect(state.overrides).toEqual({
        roles: { small: { model: OPUS, hint: DEFAULT_SETTINGS.roles.small.hint } },
        extensions: { subagents: { maxSubagentDepth: 1 } },
      });
      expect(state.settings.roles.medium).toEqual(DEFAULT_SETTINGS.roles.medium);
      expect(state.settings.extensions["subagents"]).toEqual({
        readToolset: ["read"],
        maxSubagentDepth: 1,
      });
    }));

  it("refuse values the settings do not take, saving nothing", () =>
    inRegistry(({ update, store }) => {
      saved(update(STAGING, { set: { thinkingLevel: "low" } }));

      const refused = update(STAGING, { set: { model: "openai/gpt-1", compaction: { bogus: 1 } } });

      expect(refused !== null && Result.isFailure(refused) && refused.failure.message).toContain(
        "model",
      );
      const roles = update(STAGING, { reset: ["roles"] });

      expect(roles !== null && Result.isFailure(roles)).toBe(true);
      expect(store.getSettingsOverrides(STAGING)).toEqual({ thinkingLevel: "low" });
      expect(update("0badc0de", { reset: ["model"] })).toBeNull();
    }));

  it("are named at Global for each field they override, and go with their Environment", () =>
    inRegistry(({ update, store }) => {
      store.createEnvironment("6b6b6b6b", "Prod", 20);
      saved(update(STAGING, { set: { model: SONNET, spendLimit: { perSession: null } } }));
      saved(update("6b6b6b6b", { set: { model: HAIKU } }));
      saved(update(DEFAULT_ENVIRONMENT, { set: {} }));

      expect(settingsOverriddenIn(store)).toEqual({
        model: [
          { id: "6b6b6b6b", name: "Prod" },
          { id: STAGING, name: "Staging" },
        ],
        "spendLimit.perSession": [{ id: STAGING, name: "Staging" }],
      });

      expect(store.deleteEnvironment("6b6b6b6b")).toBe("deleted");
      expect(settingsOverriddenIn(store)["model"]).toEqual([{ id: STAGING, name: "Staging" }]);
    }));

  it("leave out an Override a release no longer takes, which then inherits, and say so", () =>
    inRegistry(({ store }) => {
      store.putSettingsOverrides(STAGING, {
        model: "anthropic/claude-retired-1",
        thinkingLevel: "low",
      });

      const state = readSettingsOverrides(store, STAGING);

      expect(state?.settings.model).toBe(DEFAULT_SETTINGS.model);
      expect(state?.settings.thinkingLevel).toBe("low");
      expect(state?.overrides).toEqual({ thinkingLevel: "low" });
      expect(state?.problem).toContain("model");
    }));
});

describe("the agent's change of an Environment's Settings", () => {
  it("is recorded under the Environment, inherited before, even when the value equals Global", () =>
    inRegistry(({ change, changes, setGlobal }) => {
      setGlobal({ model: SONNET });

      const made = change([{ field: "model", value: SONNET }]);

      expect(made).toMatchObject({
        status: "changed",
        changes: [
          {
            scope: STAGING,
            field: "model",
            before: SONNET,
            after: SONNET,
            beforeInherited: true,
            tool: "settings_model_set",
          },
        ],
      });
      expect(made.status === "changed" && made.changes[0]?.afterInherited).toBeUndefined();
      expect(change([{ field: "model", value: SONNET }])).toEqual({ status: "unchanged" });
      expect(changes.list(STAGING)).toHaveLength(1);
      expect(changes.list(SETTINGS_SCOPE)).toEqual([]);
    }));

  it("resets a field, recorded as inherited after, and records nothing for one that inherits", () =>
    inRegistry(({ change }) => {
      change([{ field: "thinkingLevel", value: "low" }]);

      expect(change([{ field: "thinkingLevel", value: null, reset: true }])).toMatchObject({
        status: "changed",
        changes: [{ field: "thinkingLevel", before: "low", after: "high", afterInherited: true }],
      });
      expect(change([{ field: "thinkingLevel", value: null, reset: true }])).toEqual({
        status: "unchanged",
      });
    }));

  it("keeps an Override of no spend limit, and takes an extension option's Override away for null", () =>
    inRegistry(({ change, setGlobal, store }) => {
      setGlobal({ spendLimit: { perSession: 10 } });
      change([
        { field: "spendLimit.perSession", value: null },
        { field: "extensions.web.provider", value: "exa" },
      ]);

      expect(readSettingsOverrides(store, STAGING)?.settings.spendLimit.perSession).toBeNull();
      expect(change([{ field: "extensions.web.provider", value: null }])).toMatchObject({
        status: "changed",
        changes: [{ before: "exa", after: null, afterInherited: true }],
      });
      expect(store.getSettingsOverrides(STAGING)).toEqual({ spendLimit: { perSession: null } });
    }));

  it("is made against what the owner approved: its value and whether it was inherited", () =>
    inRegistry(({ change, setGlobal }) => {
      setGlobal({ spendLimit: { perSession: 5 } });

      // The card showed $5 inherited; the Environment has its own $5 now.
      change([{ field: "spendLimit.perSession", value: 5 }]);

      expect(
        change([
          {
            field: "spendLimit.perSession",
            value: 20,
            expected: { value: 5, inherited: true },
          },
        ]),
      ).toEqual({
        status: "changed-since",
        field: "spendLimit.perSession",
        current: 5,
        inherited: false,
      });

      expect(
        change([
          {
            field: "spendLimit.perSession",
            value: 20,
            expected: { value: 5, inherited: false },
          },
        ]),
      ).toMatchObject({ status: "changed", changes: [{ after: 20 }] });
    }));

  it("refuses a field an Environment does not override, and an Environment that does not exist", () =>
    inRegistry(({ change }) => {
      expect(change([{ field: "roles.small.model", value: SONNET }])).toMatchObject({
        status: "rejected",
      });
      expect(change([{ field: "model", value: SONNET }], "0badc0de")).toEqual({
        status: "missing",
      });
    }));
});

describe("the owner's revert of an Environment's Settings change", () => {
  it("resets a field that was inherited before, and is recorded as the owner's", () =>
    inRegistry(({ change, revert, store }) => {
      const made = change([{ field: "model", value: HAIKU }]);
      const id = made.status === "changed" ? (made.changes[0]?.id ?? 0) : 0;

      expect(revert(id)).toMatchObject({
        status: "reverted",
        change: {
          actor: "owner",
          scope: STAGING,
          field: "model",
          before: HAIKU,
          after: DEFAULT_SETTINGS.model,
          afterInherited: true,
          reverts: id,
        },
      });
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
    }));

  it("puts an Override back that a reset removed", () =>
    inRegistry(({ change, revert, store }) => {
      change([{ field: "roles.small", value: { model: SONNET, hint: "mine" } }]);

      const reset = change([{ field: "roles.small", value: null, reset: true }]);
      const id = reset.status === "changed" ? (reset.changes[0]?.id ?? 0) : 0;

      expect(revert(id)).toMatchObject({ status: "reverted", change: { beforeInherited: true } });
      expect(store.getSettingsOverrides(STAGING)).toEqual({
        roles: { small: { model: SONNET, hint: "mine" } },
      });
    }));

  it("is refused when the field has changed since, or was overridden since it was reset", () =>
    inRegistry(({ change, revert }) => {
      const set = change([{ field: "model", value: HAIKU }]);
      const setId = set.status === "changed" ? (set.changes[0]?.id ?? 0) : 0;

      change([{ field: "model", value: SONNET }]);
      expect(revert(setId)).toEqual({ status: "changed-since", field: "model", current: SONNET });

      const reset = change([{ field: "model", value: null, reset: true }]);
      const resetId = reset.status === "changed" ? (reset.changes[0]?.id ?? 0) : 0;

      // Equal to what it inherits, but an Override: not as the reset left it.
      change([{ field: "model", value: DEFAULT_SETTINGS.model }]);
      expect(revert(resetId)).toMatchObject({ status: "changed-since", field: "model" });
    }));
});

describe("an Environment's Instructions", () => {
  it("are its own text, kept apart from its Overrides, which Global's do not replace", () =>
    inRegistry(({ store, setGlobal }) => {
      setGlobal({ instructions: "Answer in French." });

      const state = saved(putEnvironmentInstructions(store, STAGING, "Answer in German."));

      expect(state).toMatchObject({
        instructions: "Answer in German.",
        // The settings in force carry Global's: the two add up rather than one replacing the other.
        settings: { instructions: "Answer in French." },
        overrides: {},
      });
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
      expect(readSettingsOverrides(store, DEFAULT_ENVIRONMENT)?.instructions).toBe("");
      expect(settingsOverriddenIn(store)).toEqual({});
    }));

  it("are what a Session in the Environment reads, with its name, beside Global's", () =>
    inRegistry(({ store, storage }) => {
      saved(putEnvironmentInstructions(store, STAGING, "Answer in German."));
      storage.sql.exec(
        "INSERT INTO sessions (id, environment, workspace, status, created_at, updated_at) VALUES ('s-staging', ?, 'w-1', 'idle', 5, 5)",
        STAGING,
      );

      expect(sessionSettingsSource(store, "s-staging").instructions).toEqual({
        name: "Staging",
        text: "Answer in German.",
      });
      expect(sessionSettingsSource(store, "s-unlisted").instructions).toBeNull();
    }));

  it("take at most 64 KiB of UTF-8, and need an Environment", () =>
    inRegistry(({ store }) => {
      const refused = putEnvironmentInstructions(store, STAGING, "é".repeat(32_769));

      expect(refused !== null && Result.isFailure(refused) ? refused.failure.message : "").toBe(
        "instructions: is longer than 64 KiB of UTF-8",
      );
      expect(readSettingsOverrides(store, STAGING)?.instructions).toBe("");
      expect(putEnvironmentInstructions(store, "0badc0de", "Hi.")).toBeNull();
    }));

  it("are changed by the agent against the text approved, recorded under the Environment, and reverted by the owner", () =>
    inRegistry(({ change, revert, store }) => {
      const wanted = { field: "instructions", value: "Answer in German.", expected: { value: "" } };

      expect(change([{ ...wanted, expected: { value: "Be terse." } }])).toEqual({
        status: "changed-since",
        field: "instructions",
        current: "",
      });

      const made = change([wanted]);

      expect(made).toMatchObject({
        status: "changed",
        changes: [
          {
            scope: STAGING,
            actor: "agent",
            field: "instructions",
            before: "",
            after: "Answer in German.",
          },
        ],
        state: { instructions: "Answer in German." },
      });
      expect(change([{ field: "instructions", value: "Answer in German." }])).toEqual({
        status: "unchanged",
      });
      expect(store.getSettingsOverrides(STAGING)).toEqual({});

      const id = made.status === "changed" ? (made.changes[0]?.id ?? 0) : 0;

      expect(revert(id)).toMatchObject({
        status: "reverted",
        change: {
          actor: "owner",
          scope: STAGING,
          field: "instructions",
          before: "Answer in German.",
          after: "",
          reverts: id,
        },
      });
      expect(readSettingsOverrides(store, STAGING)?.instructions).toBe("");
    }));

  it("refuse a revert once the text has changed since, and a change over the cap or beside other fields", () =>
    inRegistry(({ change, revert, store }) => {
      const made = change([{ field: "instructions", value: "Answer in German." }]);
      const id = made.status === "changed" ? (made.changes[0]?.id ?? 0) : 0;

      saved(putEnvironmentInstructions(store, STAGING, "Answer in Dutch."));

      expect(revert(id)).toEqual({
        status: "changed-since",
        field: "instructions",
        current: "Answer in Dutch.",
      });
      expect(change([{ field: "instructions", value: "é".repeat(32_769) }])).toEqual({
        status: "rejected",
        message: "instructions: is longer than 64 KiB of UTF-8",
      });
      expect(
        change([
          { field: "instructions", value: "Hi." },
          { field: "model", value: SONNET },
        ]),
      ).toMatchObject({ status: "rejected" });
      expect(store.getSettingsOverrides(STAGING)).toEqual({});
    }));
});

describe("the agent's change of the Global Settings", () => {
  it("changes a Role whole, and is reverted under the scope settings as before", () =>
    inRegistry(({ storage, store, changes }) => {
      const made = changeSettings(
        storage,
        store,
        changes,
        {
          changes: [{ field: "roles.small", value: { model: SONNET, hint: "mine" } }],
          author: { ...author, tool: "settings_role_set" },
        },
        1_000,
      );

      expect(made).toMatchObject({
        status: "changed",
        changes: [
          {
            scope: SETTINGS_SCOPE,
            field: "roles.small",
            before: DEFAULT_SETTINGS.roles.small,
            after: { model: SONNET, hint: "mine" },
          },
        ],
      });

      const id = made.status === "changed" ? (made.changes[0]?.id ?? 0) : 0;

      expect(revertSettingsChange(storage, store, changes, { id }, 2_000)).toMatchObject({
        status: "reverted",
      });
      expect(readSettings(store).overrides).toEqual({});
    }));

  it("resets a field to its default", () =>
    inRegistry(({ storage, store, changes, setGlobal }) => {
      setGlobal({ compaction: { enabled: false } });

      expect(
        changeSettings(
          storage,
          store,
          changes,
          { changes: [{ field: "compaction.enabled", value: null, reset: true }], author },
          1_000,
        ),
      ).toMatchObject({ status: "changed", changes: [{ before: false, after: true }] });
      expect(readSettings(store).overrides).toEqual({});
    }));
});

describe("the Settings stored before Environments had Overrides", () => {
  it("resolve the same for every Session after the migration, and their Agent changes read as before", () =>
    runInDurableObject(
      env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
      (_: TestRegistry, state) => {
        const { storage } = state;
        const { sql } = storage;

        for (const { name } of sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray()) {
          sql.exec(`DROP TABLE "${name}"`);
        }

        // The release before: migrations up to the Container settings at Global, a Global document with a value a release
        // dropped.
        migrate(storage, MIGRATIONS.slice(0, 26));

        const before = {
          model: SONNET,
          thinkingLevel: "minimal",
          roles: { small: { model: OPUS }, medium: { model: "anthropic/claude-retired-1" } },
          tools: { offered: ["read", "restart_container"] },
          spendLimit: { perSession: 4 },
          extensions: { subagents: { maxSubagentDepth: 3 } },
        };

        sql.exec(
          "INSERT INTO documents (name, body, updated_at) VALUES (?, ?, 1)",
          SETTINGS_DOCUMENT,
          JSON.stringify(before),
        );
        sql.exec(
          "INSERT INTO environments (id, name, repos, settings, created_at) VALUES (?, 'Staging', '[]', '{\"idleMinutes\":5}', 5)",
          STAGING,
        );

        for (const [id, environment] of [
          ["s-default", DEFAULT_ENVIRONMENT],
          ["s-staging", STAGING],
        ]) {
          sql.exec(
            "INSERT INTO sessions (id, environment, workspace, status, created_at, updated_at) VALUES (?, ?, ?, 'idle', 5, 5)",
            id,
            environment,
            `w-${id}`,
          );
        }

        sql.exec(
          `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts, approved)
         VALUES ('settings', 3, 'agent', 's-default', 1, 'settings_model_set', 'r', 'model', '"anthropic/claude-opus-5-5"', '"anthropic/claude-sonnet-5-5"', NULL, 0)`,
        );
        // A Role's model changed at Global before a Role was one field: its own record, `roles.small.model`.
        sql.exec(
          `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts, approved)
         VALUES ('settings', 4, 'agent', 's-default', 1, 'settings_role_set', 'r', 'roles.small.model', '"anthropic/claude-sonnet-5-5"', '"anthropic/claude-opus-5-5"', NULL, 0)`,
        );

        const store = openRegistryStore(storage);
        const expected = resolveLeniently(before).settings;

        for (const session of ["s-default", "s-staging", "s-unlisted"]) {
          const { global, overrides } = sessionSettingsSource(store, session);

          expect(resolveOverridesLeniently(global, overrides).settings).toEqual(expected);
        }

        expect(readSettingsOverrides(store, STAGING)?.settings).toEqual(expected);
        // An Environment stored before Environments had Instructions has none.
        expect(readSettingsOverrides(store, STAGING)?.instructions).toBe("");
        expect(settingsOverriddenIn(store)).toEqual({});

        const changes = openAgentChanges(storage);
        const [role, old] = changes.list(SETTINGS_SCOPE);

        expect(role).toMatchObject({
          field: "roles.small.model",
          before: SONNET,
          after: OPUS,
        });

        // Its revert still puts the Role's model back, and records the field as it was recorded.
        expect(
          revertSettingsChange(storage, store, changes, { id: role?.id ?? 0 }, 6),
        ).toMatchObject({
          status: "reverted",
          change: { field: "roles.small.model", before: OPUS, after: SONNET, actor: "owner" },
        });
        expect(readSettings(store).settings.roles.small.model).toBe(SONNET);

        expect(old).toEqual({
          id: old?.id,
          scope: SETTINGS_SCOPE,
          at: 3,
          actor: "agent",
          session: "s-default",
          conversation: 1,
          tool: "settings_model_set",
          reason: "r",
          field: "model",
          before: OPUS,
          after: SONNET,
          reverts: null,
          revertedBy: null,
        });
      },
    ));
});
