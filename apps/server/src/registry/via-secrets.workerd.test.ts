// The Registry's check that a write made over the MCP endpoint keeps no kept Secret's value, over real Durable Object
// SQLite and WebCrypto (`docs/architecture/mcp-endpoint.md` → Secret checks): what it reaches, every encoding it
// catches, the stamp that refuses a check the Secrets outran, and what the worst case costs.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import {
  type KeptVault,
  openKeptVault,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import { DEFAULT_ENVIRONMENT, MAX_ENVIRONMENT_SECRETS, variableField } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  type AgentChangeAuthor,
  changeEnvironment,
  changeGlobal,
  type ContainerFieldChange,
  openAgentChanges,
} from "./agent-changes.ts";
import { keepSecret, type SecretWrite } from "./environment-secrets.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { GLOBAL_SCOPE, openRegistryStore } from "./store.ts";
import {
  checkedViaWrite,
  guardedViaWrite,
  HOLDS_SECRET,
  reachOf,
  SECRETS_CHANGED,
  SECRETS_UNCHECKABLE,
} from "./via-secrets.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const VALUE = "sk-live-0123456789abcdef";

const endpoint: AgentChangeAuthor = {
  via: { auth: "oauth", client: { name: "pi" } },
  tool: "environment_variable_set",
  reason: "The tests need it",
};

const session: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_variable_set",
  reason: "The tests need it",
};

const setVariable = (name: string, value: string): ContainerFieldChange => ({
  field: variableField(name),
  value,
});

const rejected = (message: string) => ({ status: "rejected" as const, message });

/** Run `body` over a fresh Registry's store, Agent changes and vault. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly keys: KeptVault;
    /** Keep `value` as Secret `name` of `environment` (null: Global). */
    readonly keep: (
      name: string,
      environment: string | null,
      value?: string,
      at?: number,
    ) => Promise<SecretWrite>;
    /** Change a variable of `environment` by `author`, through the check, as the Registry does. */
    readonly set: (
      environment: string,
      change: ContainerFieldChange,
      author?: AgentChangeAuthor,
      vault?: Effect.Effect<KeptVault, SecretVaultError>,
    ) => Promise<ReturnType<typeof changeEnvironment> | ReturnType<typeof rejected>>;
    /** Change a variable at Global by `author`, through the check, as the Registry does. */
    readonly setGlobal: (
      change: ContainerFieldChange,
      author?: AgentChangeAuthor,
    ) => Promise<ReturnType<typeof changeGlobal> | ReturnType<typeof rejected>>;
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const changes = openAgentChanges(state.storage);
      const keys = await Effect.runPromise(openKeptVault(MASTER, "registry"));

      const guarded = (vault: Effect.Effect<KeptVault, SecretVaultError> = Effect.succeed(keys)) =>
        guardedViaWrite({ storage: state.storage, store, vault });

      return body({
        store,
        storage: state.storage,
        changes,
        keys,
        keep: (name, environment, value = VALUE, at = 1_000) =>
          Effect.runPromise(keepSecret(store, keys, { environment, name, value }, at)),
        set: (environment, change, author = endpoint, vault) =>
          Effect.runPromise(
            guarded(vault)(
              { author, input: { environment, change, author }, reach: reachOf(environment) },
              rejected,
              () =>
                changeEnvironment(
                  state.storage,
                  store,
                  changes,
                  { environment, change, author },
                  2_000,
                ),
            ),
          ),
        setGlobal: (change, author = endpoint) =>
          Effect.runPromise(
            guarded()({ author, input: { change, author }, reach: "every" }, rejected, () =>
              changeGlobal(state.storage, store, changes, { change, author }, 2_000),
            ),
          ),
      });
    },
  );

describe("an endpoint-authored write", () => {
  it("is made when none of its texts holds a kept Secret", async () => {
    const [outcome, listed] = await inRegistry(async ({ keep, set, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("API_URL", "https://example.test")),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toMatchObject({ status: "changed" });
    expect(listed).toMatchObject([{ via: { auth: "oauth" } }]);
  });

  it("is refused, with nothing saved or recorded, when a text holds the Environment's own kept Secret", async () => {
    const [outcome, saved, listed] = await inRegistry(async ({ keep, set, store, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("API_KEY_COPY", `Bearer ${VALUE}`)),
        store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toEqual({ status: "rejected", message: HOLDS_SECRET });
    // The refusal never holds the value it refuses.
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    expect(saved).toEqual({});
    expect(listed).toEqual([]);
  });

  it("is refused when a text holds a Secret kept Global", async () => {
    const outcome = await inRegistry(async ({ keep, set }) => {
      await keep("DEPLOY_TOKEN", null);

      return set(DEFAULT_ENVIRONMENT, setVariable("A", VALUE));
    });

    expect(outcome).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
  });

  it("is refused when its reason holds one", async () => {
    const [outcome, listed] = await inRegistry(async ({ keep, set, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("A", "1"), {
          ...endpoint,
          reason: `The key is ${VALUE}`,
        }),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
    expect(listed).toEqual([]);
  });

  it("is refused when a name or a client's name holds one", async () => {
    const [byField, byClient] = await inRegistry(async ({ keep, set }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(DEFAULT_ENVIRONMENT, { field: `variables.${VALUE}`, value: "1" }),
        await set(DEFAULT_ENVIRONMENT, setVariable("A", "1"), {
          ...endpoint,
          via: { auth: "oauth", client: { name: VALUE } },
        }),
      ];
    });

    expect(byField).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
    expect(byClient).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
  });

  it("is checked against the Environment's Secrets and Global's alone, not another Environment's", async () => {
    const [other, own] = await inRegistry(async ({ keep, set, store }) => {
      store.createEnvironment("0000beef", "Other", 500);
      await keep("OTHER_KEY", "0000beef");

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("A", VALUE)),
        await set("0000beef", setVariable("A", VALUE)),
      ];
    });

    expect(other).toMatchObject({ status: "changed" });
    expect(own).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
  });

  it("is checked against every Scope's Secrets when it is made at Global", async () => {
    const [atGlobal, listed] = await inRegistry(async ({ keep, setGlobal, store, changes }) => {
      store.createEnvironment("0000beef", "Other", 500);
      await keep("OTHER_KEY", "0000beef");

      return [await setGlobal(setVariable("A", VALUE)), changes.list(GLOBAL_SCOPE)];
    });

    expect(atGlobal).toEqual({ status: "rejected", message: HOLDS_SECRET });
    expect(listed).toEqual([]);
  });

  it.each([
    ["as written", "sk-live-0123456789abcdef", (value: string) => `token=${value}`],
    [
      "JSON-escaped",
      'pa"ss\\w0rd-xyz',
      (value: string) => JSON.stringify({ password: value }).replace(/^{"password":"|"}$/g, ""),
    ],
    ["percent-encoded", "pa ss/w0rd=1&x", (value: string) => `?q=${encodeURIComponent(value)}`],
    [
      "hex",
      "sk-live-0123456789abcdef",
      (value: string) =>
        Array.from(new TextEncoder().encode(value), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
    ],
    [
      "upper-case hex",
      "sk-live-0123456789abcdef",
      (value: string) =>
        Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase(),
    ],
    ["base64", "sk-live-0123456789abcdef", (value: string) => btoa(value)],
    [
      "base64url",
      "sk-live>>>?????0123456789",
      (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_"),
    ],
    // Inside a longer payload, at each of the three alignments (an HTTP Basic header's `user:password`).
    ["base64 after one byte", "sk-live-0123456789abcdef", (value: string) => btoa(`u:${value}`)],
    ["base64 after two bytes", "sk-live-0123456789abcdef", (value: string) => btoa(`us:${value}`)],
    [
      "base64 after three bytes",
      "sk-live-0123456789abcdef",
      (value: string) => btoa(`usr:${value}`),
    ],
  ])("is refused when a text holds a Secret %s", async (_how, value, encode) => {
    const [outcome, listed] = await inRegistry(async ({ keep, set, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT, value);

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("A", `a ${encode(value)} b`)),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toMatchObject({ status: "rejected", message: HOLDS_SECRET });
    expect(listed).toEqual([]);
  });

  it("is refused, saying to try again, when the kept Secrets change while they are checked", async () => {
    const [outcome, saved, listed] = await inRegistry(
      async ({ keep, set, store, changes, keys }) => {
        await keep("API_KEY", DEFAULT_ENVIRONMENT);

        let raced = false;

        // A vault whose first open is when the owner keeps another Secret.
        const racing: KeptVault = {
          ...keys,
          open: (binding, sealed) =>
            Effect.tap(keys.open(binding, sealed), () =>
              Effect.promise(async () => {
                if (raced) return;

                raced = true;
                await keep("NEW_KEY", DEFAULT_ENVIRONMENT, "another-value-1234", 1_500);
              }),
            ),
        };

        return [
          await set(DEFAULT_ENVIRONMENT, setVariable("A", "1"), endpoint, Effect.succeed(racing)),
          store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
          changes.list(DEFAULT_ENVIRONMENT),
        ];
      },
    );

    expect(outcome).toEqual({ status: "rejected", message: SECRETS_CHANGED });
    expect(saved).toEqual({});
    expect(listed).toEqual([]);
  });

  it("is refused when a Secret is deleted while they are checked", async () => {
    const outcome = await inRegistry(async ({ keep, set, store, keys }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);
      await keep("OTHER_KEY", DEFAULT_ENVIRONMENT, "another-value-1234");

      let raced = false;

      const racing: KeptVault = {
        ...keys,
        open: (binding, sealed) =>
          Effect.tap(keys.open(binding, sealed), () =>
            Effect.sync(() => {
              if (raced) return;

              raced = true;
              store.deleteEnvironmentSecret(DEFAULT_ENVIRONMENT, "OTHER_KEY");
            }),
          ),
      };

      return set(DEFAULT_ENVIRONMENT, setVariable("A", "1"), endpoint, Effect.succeed(racing));
    });

    expect(outcome).toEqual({ status: "rejected", message: SECRETS_CHANGED });
  });

  it("is refused when the kept Secrets cannot be opened to check it", async () => {
    const [outcome, listed] = await inRegistry(async ({ keep, set, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(
          DEFAULT_ENVIRONMENT,
          setVariable("A", "1"),
          endpoint,
          // A malformed master key fails the vault.
          openKeptVault("too short", "registry"),
        ),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toEqual({ status: "rejected", message: SECRETS_UNCHECKABLE });
    expect(listed).toEqual([]);
  });

  it("is made without opening the vault when no Secret is kept in the Scopes it reaches", async () => {
    const outcome = await inRegistry(async ({ set }) =>
      set(DEFAULT_ENVIRONMENT, setVariable("A", VALUE), endpoint, Effect.die("never opened")),
    );

    expect(outcome).toMatchObject({ status: "changed" });
  });
});

describe("a Session's write", () => {
  it("is never checked, and holds whatever the agent wrote", async () => {
    const [outcome, listed] = await inRegistry(async ({ keep, set, changes }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      return [
        await set(DEFAULT_ENVIRONMENT, setVariable("A", VALUE), session),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toMatchObject({ status: "changed" });
    expect(listed).toMatchObject([{ session: "s-1", after: VALUE }]);
  });
});

describe("the check before a write that fetches first", () => {
  it("answers the refusal, or none when the texts hold no kept Secret", async () => {
    const [held, clear, unchecked] = await inRegistry(async ({ keep, storage, store, keys }) => {
      await keep("API_KEY", DEFAULT_ENVIRONMENT);

      const check = checkedViaWrite({ storage, store, vault: Effect.succeed(keys) });
      const reach = reachOf(DEFAULT_ENVIRONMENT);

      return [
        await Effect.runPromise(check({ author: endpoint, input: { source: VALUE }, reach })),
        await Effect.runPromise(check({ author: endpoint, input: { source: "o/r" }, reach })),
        await Effect.runPromise(check({ author: session, input: { source: VALUE }, reach })),
      ];
    });

    expect(held).toBe(HOLDS_SECRET);
    expect(clear).toBeUndefined();
    expect(unchecked).toBeUndefined();
  });
});

describe("the worst case", () => {
  it("opens every Secret of every Scope for a write at Global, in a time the Registry's turn can bear", async () => {
    // 100 Secrets in each of 20 Environments and at Global: the estimate's worst case is 100 × (Environments + 1).
    const environments = 20;

    const [timing, clear, refused, count] = await inRegistry(
      async ({ store, storage, changes, keys }) => {
        const ids = [
          null,
          ...Array.from(
            { length: environments },
            (_, index) => `0000${index.toString(16).padStart(4, "0")}`,
          ),
        ];

        for (const id of ids) {
          if (id !== null) store.createEnvironment(id, `Environment ${id}`, 500);

          const sealed = await Effect.runPromise(
            Effect.forEach(
              Array.from({ length: MAX_ENVIRONMENT_SECRETS }, (_, index) => index),
              (index) =>
                keys.seal(
                  { owner: id ?? GLOBAL_SCOPE, name: `S${index}` },
                  `value-${id ?? "global"}-${index}-0123456789`,
                ),
              { concurrency: 32 },
            ),
          );

          sealed.forEach((value, index) =>
            store.putEnvironmentSecret(
              { environment: id, name: `S${index}`, sealed: value },
              1_000,
            ),
          );
        }

        const guard = guardedViaWrite({ storage, store, vault: Effect.succeed(keys) });

        /**
         * A write at Global whose input holds 100 KB of text (what a Skill's files can add up to) and `extra` too, through
         * the check, and how long it took.
         */
        const run = async (extra: string) => {
          const change = setVariable("A", "1");
          const text = `${"x ".repeat(50_000)}${extra}`;
          const started = performance.now();

          const answered = await Effect.runPromise(
            guard(
              { author: endpoint, input: { change, text, author: endpoint }, reach: "every" },
              rejected,
              () => changeGlobal(storage, store, changes, { change, author: endpoint }, 2_000),
            ),
          );

          return [performance.now() - started, answered] as const;
        };

        // The last Environment's last Secret: the one the check meets last.
        const [clearMs, clear] = await run("");
        const last = (environments - 1).toString(16).padStart(4, "0");
        const [heldMs, held] = await run(` value-0000${last}-99-0123456789 `);

        // The numbers the estimate wants: they are in the test's output.
        // @effect-diagnostics-next-line globalConsole:off
        console.log(
          `worst case: ${(environments + 1) * MAX_ENVIRONMENT_SECRETS} Secrets opened, a 100 KB text checked: ${clearMs.toFixed(0)} ms when it holds none, ${heldMs.toFixed(0)} ms when it holds one`,
        );

        return [
          Math.max(clearMs, heldMs),
          clear,
          held,
          store.sealedSecretsIn("every").length,
        ] as const;
      },
    );

    expect(count).toBe((environments + 1) * MAX_ENVIRONMENT_SECRETS);
    expect(clear).toMatchObject({ status: "changed" });
    expect(refused).toEqual({ status: "rejected", message: HOLDS_SECRET });
    // Generous, for a slow shared machine: the budget is the logged numbers.
    expect(timing).toBeLessThan(10_000);
  }, 60_000);
});
