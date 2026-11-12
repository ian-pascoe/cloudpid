// The owner's *Always allow* and *Never* on a Sampling card, written to the Registry the way a Session writes them
// (`docs/architecture/mcp-server-requests.md` → Sampling requests, The card): `rememberSampling` over the Session's
// `sessionSettingsAccess` and `sessionSettingsMcpAccess`, whose Registry is the real store's `changeSettings` (Global) and
// `changeSettingsOverrides` (the Environment's own entry) over Durable Object SQLite. The change is the owner's own: recorded
// with `actor: "owner"` and no Session, conversation or tool, shown in the Settings' Agent changes, refused a revert (with the
// reason for an act of their own, not a revert's), and the Environment's host is handed the new set.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { rememberSampling } from "@cloudpid/extensions/mcp";
import { SETTINGS_SCOPE } from "@cloudpid/protocol";
import { McpApplied } from "@cloudpid/mcp/types";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { openAgentChanges, revertAgentChange } from "../registry/agent-changes.ts";
import { mcpServerNamesOf, pendingMcpPushes, recordMcpPushed } from "../registry/mcp-registry.ts";
import {
  readSettings,
  readSettingsOverrides,
  sessionSettingsSource,
  settingsOverriddenIn,
  updateSettingsOverrides,
  writeSettings,
} from "../registry/settings.ts";
import {
  changeSettings,
  changeSettingsOverrides,
  revertSettingsChange,
} from "../registry/settings-changes.ts";
import { noSkills, type TestRegistry } from "../registry/store.fixture.ts";
import { openRegistryStore } from "../registry/store.ts";
import { sessionSource } from "./change-author.ts";
import { sessionSettingsAccess } from "./settings-access.ts";
import { sessionSettingsMcpAccess } from "./settings-mcp-access.ts";

const STAGING = "5a5a5a5a";
const DOCS = { url: "https://docs.example/mcp" };
const LOCAL = { url: "https://local.example/mcp" };

const servers = (value: Schema.Json): Schema.Json => ({ mcp: { servers: value } });

/** A Registry over the real store, answering the Session's Settings and MCP reads as the Registry DO does. */
const inRegistry = <A>(
  body: (world: {
    readonly storage: DurableObjectStorage;
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly remember: (session: string) => ReturnType<typeof rememberSampling>;
    readonly applied: Array<string>;
  }) => Promise<A>,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const { storage } = state;
    const store = openRegistryStore(storage);
    const changes = openAgentChanges(storage);
    const applied: Array<string> = [];

    store.createEnvironment(STAGING, "Staging", 10);
    store.createSession(
      {
        id: "s-staging",
        title: null,
        workspace: {
          kind: "new",
          id: "0a1b2c3d",
          environment: STAGING,
          branch: "cloudpid/0a1b2c3d",
          base: null,
        },
        origin: null,
        marks: null,
        requestId: undefined,
      },
      20,
    );
    writeSettings(store, servers({ docs: DOCS }), 5);
    updateSettingsOverrides(storage, store, STAGING, { set: servers({ local: LOCAL }) });

    const registry = {
      getSettings: () =>
        Effect.sync(() => ({ ...readSettings(store), overriddenIn: settingsOverriddenIn(store) })),
      getSettingsOverrides: ({ environment }: { readonly environment: string }) =>
        Effect.sync(() => readSettingsOverrides(store, environment)),
      getEnvironment: ({ id }: { readonly id: string }) =>
        Effect.sync(() => store.getEnvironment(id)),
      mcpServerNames: ({ environment }: { readonly environment: string }) =>
        Effect.sync(() => mcpServerNamesOf(store, environment)),
      sessionSettings: ({ session }: { readonly session: string }) =>
        Effect.sync(() => sessionSettingsSource(store, session)),
      changeSettings: ({
        environment,
        changes: wanted,
        author,
      }: Parameters<typeof changeSettings>[3] & { readonly environment?: string }) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            environment === undefined
              ? changeSettings(storage, store, changes, { changes: wanted, author }, now)
              : changeSettingsOverrides(
                  storage,
                  store,
                  changes,
                  { environment, changes: wanted, author },
                  now,
                ),
          ),
        ),
      mcpPending: ({ environment }: { readonly environment: string }) =>
        Effect.sync(() => pendingMcpPushes(store, environment, 30)),
      mcpPushed: (pushed: Parameters<typeof recordMcpPushed>[1]) =>
        Effect.sync(() => recordMcpPushed(store, pushed, 31)),
    };

    const host = {
      apply: (set: { readonly hash: string }) =>
        Effect.sync(() => {
          applied.push(set.hash);

          return McpApplied.make({ hash: set.hash, changed: true });
        }),
    };

    // SAFETY: the Session's access calls these methods only; each answers as the Registry DO's does.
    const remember = (session: string) =>
      rememberSampling({
        settings: sessionSettingsAccess({
          registry: registry as never,
          author: sessionSource(session),
        }),
        mcp: sessionSettingsMcpAccess({
          registry: registry as never,
          author: sessionSource(session),
          host: () => host as never,
        }),
      });

    return body({ storage, store, changes, remember, applied });
  });

const write = (
  remember: ReturnType<typeof rememberSampling>,
  server: string,
  source: { readonly kind: string },
  value: "allow" | "off",
) =>
  Effect.runPromise(
    remember
      .write({ server, source, conversationId: ROOT_CONVERSATION_ID, value })
      .pipe(Effect.result),
  );

describe("the Sampling card's Always allow and Never, written through the Session's access to the Registry", () => {
  it("sets sampling at Global for a Global definition, as the owner's change, which has no revert, and pushes the set", () =>
    inRegistry(async ({ storage, store, changes, remember, applied }) => {
      const result = await write(remember("s-staging"), "docs", { kind: "global" }, "allow");

      expect(Result.isSuccess(result)).toBe(true);

      const [change] = changes.list(SETTINGS_SCOPE);

      expect(change).toMatchObject({
        actor: "owner",
        session: null,
        conversation: null,
        tool: null,
        field: "mcp.servers.docs",
        after: { ...DOCS, sampling: "allow" },
        reverts: null,
      });
      expect(change?.approved).toBeUndefined();
      expect(readSettings(store).settings.mcp.servers).toMatchObject({
        docs: { sampling: "allow" },
      });

      const revert = revertSettingsChange(storage, store, changes, { id: change?.id ?? 0 }, 40);

      expect(revert).toEqual({
        status: "refused",
        message: "This is your own change, which has no revert: change the setting itself",
      });
      // Both Environments' sets changed, and the host of the Session's own was handed its set.
      expect(applied).toHaveLength(1);
    }));

  it("sets off at the Environment for the Environment's own definition, recorded under it, with no revert", () =>
    inRegistry(async ({ storage, store, changes, remember }) => {
      const result = await write(remember("s-staging"), "local", { kind: "environment" }, "off");

      expect(Result.isSuccess(result)).toBe(true);

      const [change] = changes.list(STAGING);

      expect(change).toMatchObject({
        actor: "owner",
        session: null,
        tool: null,
        field: "mcp.servers.local",
        after: { ...LOCAL, sampling: "off" },
      });
      expect(
        revertAgentChange(
          storage,
          store,
          changes,
          { environment: STAGING, id: change?.id ?? 0 },
          40,
          noSkills(storage),
        ),
      ).toEqual({
        status: "refused",
        message: "This is your own change, which has no revert: change the setting itself",
      });
      expect(changes.list(SETTINGS_SCOPE)).toEqual([]);
    }));

  it("is writable only for a Session the Registry lists, with an Environment, and a definition in the Settings", () =>
    inRegistry(async ({ remember }) => {
      const listed = remember("s-staging");
      const unlisted = remember("s-unlisted");

      const writable = (
        access: ReturnType<typeof rememberSampling>,
        source: { readonly kind: string; readonly slug?: string } | undefined,
      ) => Effect.runPromise(access.writable(source));

      expect(await writable(listed, { kind: "global" })).toBe(true);
      expect(await writable(listed, { kind: "environment" })).toBe(true);
      expect(await writable(listed, { kind: "repo", slug: "acme/app" })).toBe(false);
      expect(await writable(listed, undefined)).toBe(false);

      // A Session the Registry does not list has no Environment of its own: nothing to push to, so no write is offered.
      expect(await writable(unlisted, { kind: "global" })).toBe(false);
      expect(await writable(unlisted, { kind: "environment" })).toBe(false);
    }));
});
