// What `environment_delete`'s card says deleting an Environment takes (`sessionEnvironmentRemoval`'s footprint), over a
// fake Registry: its Workspaces, their Sessions, its kept Secrets and its Triggers.
// @effect-diagnostics asyncFunction:off newPromise:off
import type { EnvironmentSecretRecord, TriggerDefinition } from "@cloudpid/protocol";
import type { SessionRecord, WorkspaceRecord } from "../registry/store.ts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  type EnvironmentRemovalRegistry,
  sessionEnvironmentRemoval,
} from "./environment-removal.ts";

const trigger = (id: string, environment: string): TriggerDefinition => ({
  id,
  revision: 1,
  kind: "environment",
  environment,
  name: id,
  message: "m",
  source: { type: "schedule", cron: "@daily", zone: "UTC" },
  whenBusy: "skip",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});

const unused = () => Effect.die("not used here");

// SAFETY: the footprint reads only the fields given of each record.
const workspace = (id: string, environment: string) => ({ id, environment }) as WorkspaceRecord;

// SAFETY: as above.
const session = (id: string, workspace: string) => ({ id, workspace }) as SessionRecord;

// SAFETY: as above.
const secret = (environment: string, name: string) =>
  ({ environment, name }) as EnvironmentSecretRecord;

const registry: EnvironmentRemovalRegistry = {
  getEnvironment: ({ id }) =>
    Effect.succeed(id === "0000abcd" ? { id, name: "Web", repos: [], createdAt: 0 } : null),
  listWorkspaces: () => Effect.succeed([workspace("w1", "0000abcd"), workspace("w2", "default")]),
  listSessions: () => Effect.succeed([session("s1", "w1"), session("s2", "w2")]),
  listEnvironmentSecrets: () => Effect.succeed([secret("0000abcd", "A")]),
  listTriggers: ({ environment }) =>
    Effect.succeed(
      Arr.filter(
        [trigger("t1", "0000abcd"), trigger("t2", "0000abcd"), trigger("t3", "default")],
        (each) => each.environment === environment,
      ),
    ),
  getSession: unused,
  deleteSession: unused,
  deleteWorkspace: unused,
  deleteWorkspaceWithTriggers: unused,
  listSubagentWorkspaces: unused,
  getSpare: unused,
  forgetSpare: unused,
  deleteEnvironmentWithTriggers: unused,
  agentDeleteSecret: unused,
  listEnvironments: unused,
};

const removal = sessionEnvironmentRemoval({
  registry,
  session: "s-9",
  objects: {
    workspaces: { destroy: () => Promise.reject(new Error("not used here")) },
    sessions: { destroy: unused },
    triggers: { remove: unused },
  },
  builds: { of: unused },
});

describe("what deleting an Environment takes", () => {
  it("counts its Triggers beside its Workspaces, Sessions and kept Secrets", async () => {
    expect(await Effect.runPromise(removal.footprint("0000abcd"))).toEqual({
      workspaces: 1,
      sessions: 1,
      secrets: 1,
      triggers: 2,
    });
    expect(await Effect.runPromise(removal.footprint("0000ffff"))).toBeNull();
  });
});
