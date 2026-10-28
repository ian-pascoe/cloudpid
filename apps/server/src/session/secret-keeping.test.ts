// The Session's keeping of the Secrets the owner chose to keep in a `secret_ask` form, over a fake Registry: what it
// hands over, what it records for the Run's Notification, the Builds' upkeep, and that no result holds a value.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { KeepRequest } from "@cloudpid/extensions/secrets";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { KeptAsked } from "../registry/Registry.ts";
import { runChanges } from "./agent-changes.ts";
import { sessionKeepSecrets } from "./secret-keeping.ts";
import type { SettingsKv } from "./settings.ts";

const VALUE = "sk-live-0123456789abcdef";

// Lets the Builds' upkeep, run in the background, finish.
const settle = () => Effect.runPromise(Effect.sleep("5 millis"));

const kv = (): SettingsKv => {
  const rows = new Map<string, unknown>();

  return {
    // SAFETY: the tests read back what they put.
    get: <T>(key: string) => rows.get(key) as T | undefined,
    put: (key, value) => {
      rows.set(key, value);
    },
  };
};

const request = (scope: KeepRequest["scope"] = "environment"): KeepRequest => ({
  ask: {
    id: "ask-1",
    conversationId: 7,
    names: ["API_KEY", "OTHER"],
    reason: "deploys",
  },
  scope,
  secrets: [
    { name: "API_KEY", value: VALUE },
    { name: "OTHER", value: "other-value-123456" },
  ],
});

const open = (answer: KeptAsked) => {
  const calls: unknown[] = [];
  const upkept: string[] = [];
  const state = kv();
  const changes = runChanges(state);

  const keep = sessionKeepSecrets({
    registry: {
      keepAskedSecrets: (input) =>
        Effect.sync(() => {
          calls.push(input);

          return answer;
        }),
      listEnvironments: () =>
        Effect.succeed([
          { id: "default", name: "Default", repos: [], createdAt: 0 },
          { id: "0000abcd", name: "Other", repos: [], createdAt: 0 },
        ]),
    },
    session: "s-1",
    builds: {
      of: (environment) =>
        Effect.sync(() => {
          upkept.push(environment);
        }),
    },
    changes,
  });

  return { keep, calls, upkept, changes };
};

const done = (
  results: Extract<KeptAsked, { status: "done" }>["results"],
  id = "default",
): KeptAsked => ({ status: "done", environment: { id, name: "Default" }, results });

describe("the Session's keeping of Secrets", () => {
  it("hands the Registry the values with the asking Session and conversation, and says how each went", async () => {
    const { keep, calls } = open(
      done([
        { name: "API_KEY", status: "kept", shadowed: false },
        { name: "OTHER", status: "rejected", message: "A Secret's value cannot be empty" },
      ]),
    );

    const results = await Effect.runPromise(keep(request()));

    expect(calls).toEqual([
      {
        session: "s-1",
        conversation: 7,
        scope: "environment",
        reason: "The user chose to keep the Secret in the form the agent asked it in: deploys",
        secrets: request().secrets,
      },
    ]);
    expect(results).toEqual([
      { name: "API_KEY", kept: true, shadowed: false },
      { name: "OTHER", kept: false, problem: "A Secret's value cannot be empty" },
    ]);
    expect(JSON.stringify(results)).not.toContain(VALUE);
  });

  it("records each kept Secret by name for the Run's Notification, and none that was refused", async () => {
    const { keep, changes } = open(
      done([
        { name: "API_KEY", status: "kept", shadowed: false },
        { name: "OTHER", status: "rejected", message: "no" },
      ]),
    );

    await Effect.runPromise(keep(request()));

    const pending = await Effect.runPromise(changes.pending);

    expect(pending).toEqual([
      { tool: "secret_ask", environmentName: "Default", field: "secrets.API_KEY" },
    ]);
    expect(JSON.stringify(pending)).not.toContain(VALUE);
  });

  it("keeps the Builds current afterwards: the Environment's, or each Environment's for a Secret kept for all", async () => {
    const own = open(done([{ name: "API_KEY", status: "kept", shadowed: false }]));

    await Effect.runPromise(own.keep(request()));
    await settle();

    expect(own.upkept).toEqual(["default"]);

    const globalKeep = open(done([{ name: "API_KEY", status: "kept", shadowed: false }], "*"));

    await Effect.runPromise(globalKeep.keep(request("every")));
    await settle();

    expect(globalKeep.upkept).toEqual(["default", "0000abcd"]);
  });

  it("does neither when nothing was kept", async () => {
    const { keep, changes, upkept } = open(
      done([{ name: "API_KEY", status: "rejected", message: "no" }]),
    );

    await Effect.runPromise(keep(request()));
    await settle();

    expect(await Effect.runPromise(changes.pending)).toEqual([]);
    expect(upkept).toEqual([]);
  });

  it("keeps nothing for a Session the Registry does not list, saying so", async () => {
    const { keep, changes } = open({ status: "unknown" });
    const results = await Effect.runPromise(keep(request()));

    expect(results.map(({ kept }) => kept)).toEqual([false, false]);
    expect(await Effect.runPromise(changes.pending)).toEqual([]);
  });

  it("answers that the Registry could not be reached, without failing", async () => {
    const keep = sessionKeepSecrets({
      registry: {
        keepAskedSecrets: () => Effect.die(new Error(`boom ${VALUE}`)),
        listEnvironments: () => Effect.succeed([]),
      },
      session: "s-1",
      builds: { of: () => Effect.void },
      changes: runChanges(kv()),
    });

    const results = await Effect.runPromise(keep(request()));

    expect(results).toEqual([
      { name: "API_KEY", kept: false, problem: "The Registry could not be reached; try again" },
      { name: "OTHER", kept: false, problem: "The Registry could not be reached; try again" },
    ]);
  });
});
