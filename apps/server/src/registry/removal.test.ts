// The Environment delete's progress (`./removal.ts`, `StepProgress`), over a fake Registry: `onStep` runs after each
// Workspace and after the spare and the Build, a step that dies (a run that lost its lease) stops the delete with the
// record kept, and the delete run again finishes what the cut one left (`docs/architecture/mcp-endpoint.md` → Approvals with no Session; #688 C2).
// @effect-diagnostics asyncFunction:off newPromise:off
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { type RemovalRegistry, removals } from "./removal.ts";
import type { WorkspaceRecord } from "./store.ts";

const ENVIRONMENT = "0000abcd";

const unused = () => Effect.die("not used here");

/** A Registry holding Environment `ENVIRONMENT` with Workspaces `workspaces` (no Sessions), and what was done, in order. */
const fakeRegistry = (workspaces: ReadonlyArray<string>) => {
  const done: Array<string> = [];
  const held = new Set(workspaces);
  let environment = true;

  const registry: RemovalRegistry = {
    getEnvironment: ({ id }) =>
      Effect.succeed(
        environment && id === ENVIRONMENT ? { id, name: "Web", repos: [], createdAt: 0 } : null,
      ),
    listWorkspaces: () =>
      Effect.sync(() =>
        // SAFETY: the delete reads only the id and the Environment of each record.
        Arr.map([...held], (id) => ({ id, environment: ENVIRONMENT }) as WorkspaceRecord),
      ),
    listSessions: () => Effect.succeed([]),
    deleteWorkspaceTriggers: () => Effect.succeed([]),
    deleteWorkspaceWithTriggers: ({ id }) =>
      Effect.sync(() => {
        done.push(`forget ${id}`);
        held.delete(id);

        return { deletion: "deleted" as const, triggers: [] };
      }),
    getSpare: () => Effect.succeed(null),
    deleteEnvironmentWithTriggers: () =>
      Effect.sync(() => {
        done.push("forget environment");
        environment = false;

        return { deletion: "deleted" as const, triggers: [] };
      }),
    getSession: unused,
    deleteSessionWithTriggers: unused,
    deleteSessionTriggers: unused,
    deleteWorkspace: unused,
    workspaceKept: unused,
    listSubagentWorkspaces: unused,
    forgetSpare: unused,
  };

  const objects = {
    workspaces: {
      destroy: (name: string) =>
        new Promise<void>((resolve) => {
          done.push(`wipe ${name}`);
          resolve();
        }),
    },
    sessions: { destroy: unused },
    triggers: { remove: unused },
  };

  return { removal: removals(registry, objects), done };
};

describe("an Environment's delete, step by step", () => {
  it("runs onStep after each Workspace, and after the spare and the Build", async () => {
    const { removal, done } = fakeRegistry(["w1", "w2"]);

    const onStep = Effect.sync(() => {
      done.push("step");
    });

    await Effect.runPromise(removal.deleteEnvironment(ENVIRONMENT, { onStep }));

    expect(done).toEqual([
      "wipe ws:w1",
      "forget w1",
      "step",
      "wipe ws:w2",
      "forget w2",
      "step",
      `wipe build:${ENVIRONMENT}`,
      `wipe test-build:${ENVIRONMENT}`,
      "step",
      "forget environment",
      `wipe build:${ENVIRONMENT}`,
      `wipe test-build:${ENVIRONMENT}`,
    ]);
  });

  it("stops where a step dies, keeping the record, and finishes when it runs again", async () => {
    const { removal, done } = fakeRegistry(["w1", "w2"]);

    const lost = new Error("The run lost its lease");

    const cut = await Effect.runPromise(
      removal
        .deleteEnvironment(ENVIRONMENT, { onStep: Effect.die(lost) })
        .pipe(Effect.catchDefect((defect) => Effect.succeed(defect))),
    );

    expect(cut).toBe(lost);
    expect(done).toEqual(["wipe ws:w1", "forget w1"]);

    await Effect.runPromise(removal.deleteEnvironment(ENVIRONMENT));

    // Only what the cut run left: w1 is gone, so it is not wiped again.
    expect(done.slice(2)).toEqual([
      "wipe ws:w2",
      "forget w2",
      `wipe build:${ENVIRONMENT}`,
      `wipe test-build:${ENVIRONMENT}`,
      "forget environment",
      `wipe build:${ENVIRONMENT}`,
      `wipe test-build:${ENVIRONMENT}`,
    ]);
  });
});
