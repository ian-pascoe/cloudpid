// Agent changes to kept Secrets over real Durable Object SQLite (docs/spec.md → Secrets, Agent changes): a Secret the
// owner keeps in a `secret_ask` form is saved and recorded by name only, the Build mark the agent sets is recorded with
// the mark before and after, and the history of the Secrets kept for every Environment is the scope `*`.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import { openKeptVault } from "@cloudpid/extensions/secrets/core";
import { DEFAULT_ENVIRONMENT, secretBuildField } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import { keepSecretAs, openEnvironmentSecrets, type SecretKept } from "./environment-secrets.ts";
import { markSecretBuildAs } from "./secret-changes.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { EVERY_ENVIRONMENT_SCOPE, openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const VALUE = "sk-live-0123456789abcdef";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_secret_build",
  reason: "A Setup Script needs it",
};

const asked: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "secret_ask",
  reason: "The user chose to keep the Secret in the form the agent asked it in: deploys",
};

/** Run `body` over a fresh Registry's store, Agent changes and vault. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly keep: (
      name: string,
      environment: string | null,
      at?: number,
      value?: string,
    ) => Promise<SecretKept>;
    readonly mark: (
      environment: string,
      name: string,
      build: boolean,
      at?: number,
    ) => ReturnType<typeof markSecretBuildAs>;
    readonly revert: (
      environment: string,
      id: number,
      at?: number,
    ) => ReturnType<typeof revertAgentChange>;
    /** Every row of the Registry's tables that could hold a value, as JSON. */
    readonly dump: () => string;
    readonly open: (environment: string) => Promise<ReadonlyArray<{ name: string; value: string }>>;
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const changes = openAgentChanges(state.storage);
      const keys = await Effect.runPromise(openKeptVault(MASTER, "registry"));

      const keepOne = (name: string, environment: string | null, at: number, value: string) =>
        Effect.runPromise(
          keepSecretAs(
            state.storage,
            store,
            changes,
            keys,
            { environment, name, value, sessionEnvironment: DEFAULT_ENVIRONMENT, author: asked },
            at,
          ),
        );

      return body({
        store,
        changes,
        keep: (name, environment, at = 1_000, value = VALUE) =>
          keepOne(name, environment, at, value),
        mark: (environment, name, build, at = 2_000) =>
          markSecretBuildAs(
            state.storage,
            store,
            changes,
            { environment, name, build, author },
            at,
          ),
        revert: (environment, id, at = 3_000) =>
          revertAgentChange(state.storage, store, changes, { environment, id }, at),
        dump: () =>
          JSON.stringify([
            state.storage.sql.exec("SELECT * FROM agent_changes").toArray(),
            state.storage.sql.exec("SELECT * FROM environment_secrets").toArray(),
          ]),
        open: (environment) => Effect.runPromise(openEnvironmentSecrets(store, keys, environment)),
      });
    },
  );

describe("a Secret the owner keeps in a secret_ask form", () => {
  it("is saved sealed for the Environment and recorded by name only", async () => {
    const [kept, listed, opened, dump] = await inRegistry(async ({ keep, changes, open, dump }) => [
      await keep("API_KEY", DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
      await open(DEFAULT_ENVIRONMENT),
      dump(),
    ]);

    expect(kept).toMatchObject({
      status: "kept",
      record: { environment: DEFAULT_ENVIRONMENT, name: "API_KEY", build: false },
      shadowed: false,
    });
    expect(listed).toEqual([
      {
        id: 1,
        scope: DEFAULT_ENVIRONMENT,
        at: 1_000,
        actor: "agent",
        session: "s-1",
        conversation: 1,
        tool: "secret_ask",
        reason: asked.reason,
        field: "secrets.API_KEY",
        before: null,
        after: "kept",
        reverts: null,
        revertedBy: null,
      },
    ]);
    expect(opened).toEqual([{ name: "API_KEY", value: VALUE, scope: "environment", build: false }]);
    expect(dump).not.toContain(VALUE);
  });

  it("is recorded in the history of every Environment, scope *, when kept for all of them", async () => {
    const [kept, everyHistory, environmentHistory] = await inRegistry(async ({ keep, changes }) => [
      await keep("NPM_TOKEN", null),
      changes.list(EVERY_ENVIRONMENT_SCOPE),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(kept).toMatchObject({ status: "kept", record: { environment: null } });
    expect(everyHistory).toMatchObject([
      { scope: "*", field: "secrets.NPM_TOKEN", before: null, after: "kept" },
    ]);
    expect(environmentHistory).toEqual([]);
  });

  it("records a replaced value as kept before, and keeps the Build mark it had", async () => {
    const [second, listed, marks] = await inRegistry(async ({ keep, mark, changes, store }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);
      mark(DEFAULT_ENVIRONMENT, "API_KEY", true);

      return [
        await keep("API_KEY", DEFAULT_ENVIRONMENT, 4_000, "sk-live-replaced-value-1"),
        changes
          .list(DEFAULT_ENVIRONMENT)
          .map(({ field, before, after }) => ({ field, before, after })),
        store.listEnvironmentSecrets(),
      ];
    });

    expect(second).toMatchObject({ status: "kept", record: { build: true } });
    expect(listed[0]).toEqual({ field: "secrets.API_KEY", before: "kept", after: "kept" });
    expect(marks).toMatchObject([{ name: "API_KEY", build: true }]);
  });

  it("says when the Environment's own Secret of the name wins over one kept for every Environment", async () => {
    const [every, own] = await inRegistry(async ({ keep }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [await keep("API_KEY", null), await keep("OTHER", null)];
    });

    expect(every).toMatchObject({ status: "kept", shadowed: true });
    expect(own).toMatchObject({ status: "kept", shadowed: false });
  });

  it("is refused with the owner's messages, recording nothing and naming no value", async () => {
    const [name, value, missing, listed] = await inRegistry(async ({ keep, changes }) => [
      await keep("api_key", DEFAULT_ENVIRONMENT),
      await keep("API_KEY", DEFAULT_ENVIRONMENT, 1_000, "a\u0000b"),
      await keep("API_KEY", "ffff0000"),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(name).toMatchObject({ status: "rejected" });
    expect(value).toMatchObject({ status: "rejected", message: expect.stringContaining("NUL") });
    expect(missing).toEqual({ status: "rejected", message: "The Environment does not exist" });
    expect(listed).toEqual([]);
  });

  it("has no revert: the history holds no value to bring back", async () => {
    const [reverted] = await inRegistry(async ({ keep, revert }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [revert(DEFAULT_ENVIRONMENT, 1)];
    });

    expect(reverted).toMatchObject({
      status: "refused",
      message: expect.stringContaining("Keeping a secret is not reverted"),
    });
  });
});

describe("the agent's change of a kept Secret's Build mark", () => {
  it("is saved and recorded with the mark before and after", async () => {
    const [marked, listed, stored] = await inRegistry(async ({ keep, mark, changes, store }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        mark(DEFAULT_ENVIRONMENT, "API_KEY", true),
        changes.list(DEFAULT_ENVIRONMENT)[0],
        store.listEnvironmentSecrets(),
      ];
    });

    expect(marked).toMatchObject({
      status: "changed",
      environment: { id: DEFAULT_ENVIRONMENT, name: "Default" },
      change: { field: secretBuildField("API_KEY"), before: false, after: true },
    });
    expect(listed).toMatchObject({
      actor: "agent",
      tool: "environment_secret_build",
      reason: "A Setup Script needs it",
      at: 2_000,
    });
    expect(stored).toMatchObject([{ name: "API_KEY", build: true, updatedAt: 2_000 }]);
  });

  it("changes a Secret kept for every Environment with the scope *, recorded in its history", async () => {
    const [marked, every, own] = await inRegistry(async ({ keep, mark, changes }) => {
      await keep("NPM_TOKEN", null);

      return [
        mark(EVERY_ENVIRONMENT_SCOPE, "NPM_TOKEN", true),
        changes.list(EVERY_ENVIRONMENT_SCOPE).map(({ field }) => field),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(marked).toMatchObject({
      status: "changed",
      environment: { id: "*", name: "every Environment" },
    });
    expect(every).toEqual(["secrets.NPM_TOKEN.build", "secrets.NPM_TOKEN"]);
    expect(own).toEqual([]);
  });

  it("records nothing for a mark the Secret has, and says when none is kept there or the Environment is unknown", async () => {
    const [same, absent, wrongScope, missing, listed] = await inRegistry(
      async ({ keep, mark, changes }) => {
        await keep("NPM_TOKEN", null);

        return [
          mark(EVERY_ENVIRONMENT_SCOPE, "NPM_TOKEN", false),
          mark(DEFAULT_ENVIRONMENT, "GHOST", true),
          mark(DEFAULT_ENVIRONMENT, "NPM_TOKEN", true),
          mark("ffff0000", "NPM_TOKEN", true),
          changes.list(DEFAULT_ENVIRONMENT),
        ];
      },
    );

    expect(same).toMatchObject({ status: "unchanged", build: false });
    expect(absent).toMatchObject({ status: "absent" });
    // A Secret kept for every Environment is not the Environment's own.
    expect(wrongScope).toMatchObject({ status: "absent" });
    expect(missing).toEqual({ status: "missing" });
    expect(listed).toEqual([]);
  });

  it("is reverted by the owner, recorded, and not twice", async () => {
    const [reverted, mark, again, history] = await inRegistry(
      async ({ keep, mark, revert, store, changes }) => {
        await keep("API_KEY", DEFAULT_ENVIRONMENT);
        mark(DEFAULT_ENVIRONMENT, "API_KEY", true);

        return [
          revert(DEFAULT_ENVIRONMENT, 2),
          store.listEnvironmentSecrets()[0]?.build,
          revert(DEFAULT_ENVIRONMENT, 2),
          changes.list(DEFAULT_ENVIRONMENT)[0],
        ];
      },
    );

    expect(reverted).toMatchObject({
      status: "reverted",
      change: {
        actor: "owner",
        reverts: 2,
        field: "secrets.API_KEY.build",
        before: true,
        after: false,
      },
    });
    expect(mark).toBe(false);
    expect(again).toMatchObject({ status: "refused" });
    expect(history).toMatchObject({ actor: "owner", reverts: 2 });
  });

  it("is reverted for a Secret kept for every Environment, through the scope *", async () => {
    const [reverted, mark] = await inRegistry(async ({ keep, mark, revert, store }) => {
      await keep("NPM_TOKEN", null);
      mark(EVERY_ENVIRONMENT_SCOPE, "NPM_TOKEN", true);

      return [revert(EVERY_ENVIRONMENT_SCOPE, 2), store.listEnvironmentSecrets()[0]?.build];
    });

    expect(reverted).toMatchObject({ status: "reverted", change: { scope: "*" } });
    expect(mark).toBe(false);
  });

  it("is refused a revert, saying what the mark is now, when the owner changed it since", async () => {
    const [refused, deleted] = await inRegistry(async ({ keep, mark, revert, store }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);
      mark(DEFAULT_ENVIRONMENT, "API_KEY", true);
      store.setEnvironmentSecretBuild(DEFAULT_ENVIRONMENT, "API_KEY", false, 2_500);

      const first = revert(DEFAULT_ENVIRONMENT, 2);

      // The owner deleted the Secret since.
      store.deleteEnvironmentSecret(DEFAULT_ENVIRONMENT, "API_KEY");

      return [first, revert(DEFAULT_ENVIRONMENT, 2)];
    });

    expect(refused).toEqual({
      status: "changed-since",
      field: "secrets.API_KEY.build",
      current: false,
    });
    expect(deleted).toEqual({
      status: "changed-since",
      field: "secrets.API_KEY.build",
      current: null,
    });
  });
});
