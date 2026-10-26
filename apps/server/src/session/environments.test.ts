// The Session's Environments over a fake Registry: what they read, and what follows a change (the handover to the
// Session's own Workspace, and the Builds' upkeep).
// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { unusedLifecycle } from "./environments.fixture.ts";
import { type EnvironmentsRegistry, sessionEnvironments } from "./environments.ts";
import { workspacePlacement } from "./workspace.ts";

const DEFAULT = { id: "default", name: "Default", repos: [], createdAt: 0 };
const OTHER = { id: "0000abcd", name: "Other", repos: [], createdAt: 0 };

const CHANGE: AgentChange = {
  id: 7,
  scope: "default",
  at: 1,
  actor: "agent",
  session: "s-1",
  conversation: 1,
  tool: "environment_variable_set",
  reason: "r",
  field: "variables.A",
  before: null,
  after: "1",
  reverts: null,
  revertedBy: null,
};

const open = (
  answer: Effect.Success<
    ReturnType<EnvironmentsRegistry["changeEnvironment"]>
  >["status"] = "changed",
) => {
  const handedOver: Array<{ object: string; overrides: Schema.Json }> = [];
  const upkept: string[] = [];
  const asked: unknown[] = [];

  // SAFETY: the calls these tests make are answered; the rest are never reached.
  const registry = {
    listEnvironments: () => Effect.succeed([DEFAULT, OTHER]),
    listBuilds: () =>
      Effect.succeed([{ environment: "default", build: { status: "ready", at: 5 } as const }]),
    getEnvironment: ({ id }: { readonly id: string }) =>
      Effect.succeed(
        Arr.findFirst([DEFAULT, OTHER], (each) => each.id === id).pipe(Option.getOrNull),
      ),
    getEnvironmentSettings: ({ environment }: { readonly environment: string }) =>
      Effect.succeed(
        environment === "default" || environment === "0000abcd"
          ? { settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} }
          : null,
      ),
    listEnvironmentSecrets: () =>
      Effect.succeed([
        { environment: "default", name: "API_KEY", build: true, updatedAt: 0 },
        { environment: null, name: "API_KEY", build: false, updatedAt: 0 },
        { environment: null, name: "NPM_TOKEN", build: false, updatedAt: 0 },
        { environment: "0000abcd", name: "OTHER_KEY", build: false, updatedAt: 0 },
      ]),
    getWorkspace: ({ id }: { readonly id: string }) =>
      Effect.succeed({
        id,
        environment: "default",
        branch: "b",
        base: null,
        repos: [],
        directory: "/workspace",
        createdAt: 0,
      }),
    changeEnvironment: (input: Parameters<EnvironmentsRegistry["changeEnvironment"]>[0]) =>
      Effect.sync(() => {
        asked.push(input);

        const environment = input.environment === "default" ? DEFAULT : OTHER;

        switch (answer) {
          case "changed":
            return {
              status: "changed" as const,
              environment,
              change: CHANGE,
              state: { settings: DEFAULT_CONTAINER_SETTINGS, overrides: { variables: { A: "1" } } },
              newBuild: true,
            };
          case "unchanged":
            return { status: "unchanged" as const, environment, value: null };
          case "rejected":
            return { status: "rejected" as const, message: "no" };
          case "missing":
            return { status: "missing" as const };
        }
      }),
  } as EnvironmentsRegistry;

  const environments = sessionEnvironments({
    registry,
    session: "s-1",
    placement: () => Promise.resolve(workspacePlacement("0a1b2c3d", "/workspace")),
    handOver: (object, overrides) => {
      handedOver.push({ object, overrides });

      return Promise.resolve({ ok: true });
    },
    builds: {
      of: (environment) =>
        Effect.sync(() => {
          upkept.push(environment);
        }),
    },
    lifecycle: unusedLifecycle,
  });

  return { environments, handedOver, upkept, asked };
};

const author = { conversation: 1, tool: "environment_variable_set", reason: "r" };
const change = { field: "variables.A", value: "1" };

describe("the Session's Environments", () => {
  it("are its Workspace's Environment, and list each one with its Build", async () => {
    const { environments } = open();

    expect(await Effect.runPromise(environments.current)).toBe("default");
    expect(await Effect.runPromise(environments.list)).toEqual([
      { id: "default", name: "Default", repos: [], build: { status: "ready", at: 5 } },
      { id: "0000abcd", name: "Other", repos: [], build: { status: "none" } },
    ]);
  });

  it("show an Environment's own Secrets, then those of every Environment it does not override", async () => {
    const { environments } = open();
    const details = await Effect.runPromise(environments.get("default"));

    expect(details?.secrets).toEqual([
      { name: "API_KEY", scope: "environment", build: true },
      { name: "NPM_TOKEN", scope: "every", build: false },
    ]);
    expect(await Effect.runPromise(environments.get("ghost"))).toBeNull();
  });

  it("hand a change of the Session's own Environment to its Workspace, and keep its Build current", async () => {
    const { environments, handedOver, upkept, asked } = open();

    const applied = await Effect.runPromise(
      environments.change({ environment: "default", change, author }),
    );

    expect(asked).toEqual([
      { environment: "default", change, author: { session: "s-1", ...author } },
    ]);
    expect(applied).toEqual({
      status: "changed",
      environment: { id: "default", name: "Default" },
      change: CHANGE,
      newBuild: true,
    });
    expect(handedOver).toEqual([{ object: "ws:0a1b2c3d", overrides: { variables: { A: "1" } } }]);
    expect(upkept).toEqual(["default"]);
  });

  it("leave the Session's Workspace as it is for a change of another Environment", async () => {
    const { environments, handedOver, upkept } = open();

    await Effect.runPromise(environments.change({ environment: "0000abcd", change, author }));

    expect(handedOver).toEqual([]);
    expect(upkept).toEqual(["0000abcd"]);
  });

  it("do nothing after a change that changed nothing or was refused", async () => {
    for (const status of ["unchanged", "rejected", "missing"] as const) {
      const { environments, handedOver, upkept } = open(status);

      expect(
        (await Effect.runPromise(environments.change({ environment: "default", change, author })))
          .status,
      ).toBe(status);
      expect(handedOver).toEqual([]);
      expect(upkept).toEqual([]);
    }
  });
});
