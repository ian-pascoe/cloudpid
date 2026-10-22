// Deleting a Workspace's object from the main Worker: wipe, then reset in a call of its own.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import {
  type LifecycleHost,
  WORKSPACE_DELETED_REASON,
  workspaceObjectsRemote,
} from "./lifecycle.ts";

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

    const { asked, remote } = namespace({
      destroy: async () => {
        calls.push("destroy");
      },
      reset: async () => {
        calls.push("reset");

        throw new Error(WORKSPACE_DELETED_REASON);
      },
    });

    await expect(remote.destroy("cloudpid")).resolves.toBeUndefined();

    expect(calls).toEqual(["destroy", "reset"]);
    expect(asked).toEqual(["cloudpid"]);
  });

  it("fails with the wipe's failure and does not reset", async () => {
    const calls: string[] = [];

    const { remote } = namespace({
      destroy: async () => {
        calls.push("destroy");
        throw new Error("storage unavailable");
      },
      reset: async () => {
        calls.push("reset");
      },
    });

    await expect(remote.destroy("cloudpid")).rejects.toThrow("storage unavailable");

    expect(calls).toEqual(["destroy"]);
  });
});
