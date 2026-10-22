// Deleting or resetting a Workspace's object from the main Worker: wipe, then reset in a call of its own.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import {
  type LifecycleHost,
  WORKSPACE_DELETED_REASON,
  workspaceObjectsRemote,
} from "./lifecycle.ts";

/** A host whose every method records its name in `calls`; `overrides` replace some. */
const host = (calls: string[], overrides: Partial<LifecycleHost> = {}): LifecycleHost => ({
  destroy: async () => {
    calls.push("destroy");
  },
  clear: async () => {
    calls.push("clear");
  },
  reset: async () => {
    calls.push("reset");

    throw new Error(WORKSPACE_DELETED_REASON);
  },
  restartContainer: async () => {
    calls.push("restartContainer");
  },
  ...overrides,
});

const namespace = (host: LifecycleHost) => {
  const asked: string[] = [];

  return {
    asked,
    remote: workspaceObjectsRemote({
      getByName: (slug) => {
        asked.push(slug);

        return host;
      },
    }),
  };
};

describe("workspaceObjectsRemote", () => {
  it("resets the object after the wipe has answered, and the reset's failure does not fail the deletion", async () => {
    const calls: string[] = [];

    const { asked, remote } = namespace(host(calls));

    await expect(remote.destroy("cloudpid")).resolves.toBeUndefined();

    expect(calls).toEqual(["destroy", "reset"]);
    expect(asked).toEqual(["cloudpid"]);
  });

  it("fails with the wipe's failure and does not reset", async () => {
    const calls: string[] = [];

    const { remote } = namespace(
      host(calls, {
        destroy: async () => {
          calls.push("destroy");
          throw new Error("storage unavailable");
        },
      }),
    );

    await expect(remote.destroy("cloudpid")).rejects.toThrow("storage unavailable");

    expect(calls).toEqual(["destroy"]);
  });

  it("clears the object but its settings, then resets it, as a deletion does", async () => {
    const calls: string[] = [];
    const { remote } = namespace(host(calls));

    await expect(remote.clear("cloudpid")).resolves.toBeUndefined();

    expect(calls).toEqual(["clear", "reset"]);
  });

  it("does not reset an object whose clear failed", async () => {
    const calls: string[] = [];

    const { remote } = namespace(
      host(calls, {
        clear: async () => {
          calls.push("clear");
          throw new Error("storage unavailable");
        },
      }),
    );

    await expect(remote.clear("cloudpid")).rejects.toThrow("storage unavailable");

    expect(calls).toEqual(["clear"]);
  });

  it("restarts the Container without wiping or resetting the object", async () => {
    const calls: string[] = [];
    const { remote } = namespace(host(calls));

    await remote.restartContainer("cloudpid");

    expect(calls).toEqual(["restartContainer"]);
  });
});
