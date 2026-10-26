// `container_restart` and `container_resize` (docs/spec.md → Container and Toolchains → Restart by the agent, Resize by
// the agent), over a fake Workspace Container.
// @effect-diagnostics asyncFunction:off
import type { InstanceType } from "@cloudpid/config";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import {
  type ContainerControl,
  type ContainerResizeOutcome,
  ContainerTools,
  describeRestart,
  MAX_CONTAINER_REASON,
  WorkspaceContainer,
} from "./container.ts";

/**
 * A Workspace Container that records each restart and resize, answers `wasRunning` to a restart and `resized` to a
 * resize, or fails with `failure`.
 */
const fakeContainer = (
  wasRunning: boolean,
  failure?: Error,
  resized: ContainerResizeOutcome = {
    outcome: "resized",
    wasRunning,
    previous: "cpu-1",
    next: "cpu-2",
    environment: "cpu-1",
    snapshotted: wasRunning,
  },
) => {
  const restarts: Array<{ readonly fresh: boolean }> = [];
  const resizes: Array<{ readonly size: InstanceType }> = [];
  /** The conversations the calls were for. */
  const targets: unknown[] = [];

  const control: ContainerControl = {
    restart: async ({ target, ...options }) => {
      restarts.push(options);
      targets.push(target.conversationId);

      if (failure !== undefined) throw failure;

      return { wasRunning };
    },
    resize: async ({ target, ...options }) => {
      resizes.push(options);
      targets.push(target.conversationId);

      if (failure !== undefined) throw failure;

      return resized;
    },
  };

  return { control, restarts, resizes, targets };
};

const toolsOver = async (control: ContainerControl): Promise<ReadonlyArray<ToolRegistration>> => {
  const extension = await Effect.runPromise(
    ContainerTools.pipe(Effect.provideService(WorkspaceContainer, control)),
  );

  return extension.tools ?? [];
};

const toolOver = async (control: ContainerControl, name: string): Promise<ToolRegistration> => {
  const tool = Arr.findFirst(await toolsOver(control), (candidate) => candidate.name === name);

  if (Option.isNone(tool)) throw new Error(`no ${name}`);

  return tool.value;
};

// The tools read only the calling conversation from the invocation's API: its Workspace's Container is the one stopped.
const api: ToolExecutionApi = Object.assign(Object.create(null), { conversationId: "child" });

/** A call's arguments, as the model sends them: what the tool takes, or less, to see it refused. */
type Args = { readonly reason?: string; readonly fresh?: boolean; readonly size?: string };

const run = (tool: ToolRegistration, args: Args) =>
  // SAFETY: the arguments are the tool's JSON parameters, or deliberately not, to see them refused.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Awaited<ReturnType<ToolRegistration["execute"]>>): string =>
  Arr.join(
    Arr.map(result.output ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );

describe("the container extension", () => {
  it("has container_restart and container_resize, never replayed after an eviction, each run alone in its conversation", async () => {
    const extension = await Effect.runPromise(
      ContainerTools.pipe(Effect.provideService(WorkspaceContainer, fakeContainer(true).control)),
    );

    expect(extension.name).toBe("container");
    expect(Arr.map(extension.tools ?? [], (tool) => tool.name)).toEqual([
      "container_restart",
      "container_resize",
    ]);

    for (const tool of extension.tools ?? []) {
      expect(tool.replay, tool.name).toBe("unsafe");
      expect(tool.executionMode, tool.name).toBe("sequential");
    }
  });

  it("acts on the Container of the calling conversation's Workspace, so a subagent's stops only its own", async () => {
    const container = fakeContainer(true);

    await run(await toolOver(container.control, "container_restart"), { reason: "hung" });
    await run(await toolOver(container.control, "container_resize"), {
      reason: "memory",
      size: "cpu-2",
    });

    expect(container.targets).toEqual(["child", "child"]);
  });
});

describe("container_restart", () => {
  const restartOver = (control: ContainerControl) => toolOver(control, "container_restart");

  it("asks for a reason, and says when to use it, what it ends and what the next command starts from", async () => {
    const tool = await restartOver(fakeContainer(true).control);

    expect(tool.parameters).toMatchObject({
      required: ["reason"],
      properties: { reason: { type: "string" }, fresh: { type: "boolean" } },
    });
    expect(tool.description).toMatch(/stops answering/);
    expect(tool.description).toMatch(/`echo` included/);
    expect(tool.description).toMatch(/every command running there ends/);
    expect(tool.description).toMatch(/files in \/workspace stay/);
    expect(tool.description).toMatch(/last snapshot/);
    expect(tool.description).toMatch(/`fresh`.*Build or the image/s);
    expect(tool.description).toMatch(/same size/);
  });

  it("restarts from the snapshot by default, and says the running commands ended", async () => {
    const container = fakeContainer(true);
    const tool = await restartOver(container.control);

    const result = await run(tool, { reason: "echo hung for minutes" });

    expect(container.restarts).toEqual([{ fresh: false }]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(describeRestart(false, true));
    expect(text(result)).toMatch(
      /^Stopped the container: the commands that were running there have ended/,
    );
    expect(text(result)).toMatch(/last snapshot/);
    expect(result.details).toEqual({ fresh: false, wasRunning: true });
  });

  it("forgets the snapshot when asked to start fresh", async () => {
    const container = fakeContainer(true);
    const tool = await restartOver(container.control);

    const result = await run(tool, {
      reason: "the snapshot's node_modules is broken",
      fresh: true,
    });

    expect(container.restarts).toEqual([{ fresh: true }]);
    expect(text(result)).toMatch(/Build or the image/);
    expect(text(result)).toMatch(/Setup Scripts run again/);
  });

  it("says so when no container was running", async () => {
    const tool = await restartOver(fakeContainer(false).control);

    expect(text(await run(tool, { reason: "just in case" }))).toMatch(
      /^No container was running, so none was stopped\. The next container command/,
    );
    expect(text(await run(tool, { reason: "just in case", fresh: true }))).toMatch(
      /^No container was running, so none was stopped\. The snapshot is forgotten\./,
    );
  });

  it("answers an error the model can read when the Workspace cannot be reached", async () => {
    const tool = await restartOver(fakeContainer(true, new Error("Workspace unavailable")).control);

    const result = await run(tool, { reason: "hung" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Could not restart the container: Workspace unavailable");
  });

  it("refuses a call without a reason, or with one too long, and restarts nothing", async () => {
    const container = fakeContainer(true);
    const tool = await restartOver(container.control);

    for (const args of [{}, { reason: "" }, { reason: "x".repeat(MAX_CONTAINER_REASON + 1) }]) {
      const result = await run(tool, args);

      expect(result.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }

    expect(container.restarts).toEqual([]);
  });
});

describe("container_resize", () => {
  const resizeOver = (control: ContainerControl) => toolOver(control, "container_resize");

  it("asks for a size and a reason, and says what it stops, what comes back and how long the size lasts", async () => {
    const tool = await resizeOver(fakeContainer(true).control);

    expect(tool.parameters).toMatchObject({
      required: ["size", "reason"],
      properties: {
        size: {
          enum: [
            "lite",
            "basic",
            "cpu-1",
            "standard-1",
            "mem-4",
            "standard-2",
            "cpu-2",
            "mem-8",
            "standard-3",
            "cpu-3",
            "mem-12",
            "standard-4",
          ],
        },
        reason: { type: "string" },
      },
    });
    // Each size with what it offers, smallest memory first.
    expect(tool.description).toMatch(/cpu-1: 1 vCPU, 3 GiB memory/);
    expect(tool.description).toMatch(/cpu-3: 3 vCPU, 9 GiB memory, 12 GB disk/);
    expect(tool.description).toMatch(/mem-12: 2 vCPU, 12 GiB memory, 12 GB disk/);
    expect(tool.description.indexOf("standard-3:")).toBeLessThan(
      tool.description.indexOf("cpu-3:"),
    );
    expect(tool.description.indexOf("cpu-1:")).toBeLessThan(
      tool.description.indexOf("standard-1:"),
    );
    expect(tool.description).toMatch(/memory guard/);
    expect(tool.description).toMatch(/size limit/);
    expect(tool.description).toMatch(/every command running there ends/);
    expect(tool.description).toMatch(/snapshot/);
    expect(tool.description).toMatch(/idle/);
  });

  it("snapshots and stops a running container, and says what ended and what the next command starts on", async () => {
    const container = fakeContainer(true);
    const tool = await resizeOver(container.control);

    const result = await run(tool, { size: "cpu-2", reason: "tsc ran out of memory" });

    expect(container.resizes).toEqual([{ size: "cpu-2" }]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(
      /^Stopped the container \(it ran on cpu-1\): the commands that were running there have ended, other Sessions' in this Workspace too/,
    );
    expect(text(result)).toMatch(/starts a new container on cpu-2 \(2 vCPU, 6 GiB memory/);
    expect(text(result)).toMatch(/from the snapshot just taken/);
    expect(text(result)).toMatch(/until the container is stopped for being idle.*cpu-1/s);
    expect(result.details).toEqual({
      size: "cpu-2",
      outcome: "resized",
      wasRunning: true,
      previous: "cpu-1",
      next: "cpu-2",
      environment: "cpu-1",
      snapshotted: true,
    });
  });

  it("says the next container starts from the last snapshot when this one could not be taken", async () => {
    const tool = await resizeOver(
      fakeContainer(true, undefined, {
        outcome: "resized",
        wasRunning: true,
        previous: "cpu-1",
        next: "cpu-2",
        environment: "cpu-1",
        snapshotted: false,
      }).control,
    );

    const result = await run(tool, { size: "cpu-2", reason: "more memory" });

    expect(text(result)).toMatch(/snapshot could not be taken/);
    expect(text(result)).not.toMatch(/snapshot just taken/);
  });

  it("only records the size when no container runs", async () => {
    const tool = await resizeOver(fakeContainer(false).control);

    const result = await run(tool, { size: "cpu-2", reason: "the build needs 5 GB" });

    expect(text(result)).toMatch(
      /^No container was running, so none was stopped\. The next container command starts a new container on cpu-2/,
    );
  });

  it("says the Environment's own size is back when it resizes to it", async () => {
    const tool = await resizeOver(
      fakeContainer(true, undefined, {
        outcome: "resized",
        wasRunning: true,
        previous: "cpu-2",
        next: "cpu-1",
        environment: "cpu-1",
        snapshotted: true,
      }).control,
    );

    const result = await run(tool, { size: "cpu-1", reason: "the build is done" });

    expect(text(result)).toMatch(/cpu-1 is the Environment's own size/);
    expect(text(result)).not.toMatch(/idle/);
  });

  it("warns when the new size's disk is smaller, since the snapshot may not fit", async () => {
    const tool = await resizeOver(
      fakeContainer(true, undefined, {
        outcome: "resized",
        wasRunning: true,
        previous: "cpu-2",
        next: "standard-1",
        environment: "cpu-1",
        snapshotted: true,
      }).control,
    );

    const result = await run(tool, { size: "standard-1", reason: "cheaper" });

    expect(text(result)).toMatch(/standard-1's disk \(8 GB\) is smaller than cpu-2's \(12 GB\)/);
    expect(text(result)).toMatch(/from the image/);
  });

  it("does not stop a container that already runs on that size, and says so", async () => {
    const tool = await resizeOver(
      fakeContainer(true, undefined, { outcome: "unchanged", size: "cpu-2" }).control,
    );

    const result = await run(tool, { size: "cpu-2", reason: "more memory" });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/already runs on cpu-2/);
    expect(text(result)).toMatch(/not stopped/);
  });

  it("refuses a size above the Environment's size limit, naming the limit and who can raise it", async () => {
    const tool = await resizeOver(
      fakeContainer(true, undefined, { outcome: "refused", limit: "cpu-2" }).control,
    );

    const result = await run(tool, { size: "standard-4", reason: "more memory" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/standard-4 is above this Environment's size limit, cpu-2/);
    expect(text(result)).toMatch(/owner can raise/);
    expect(text(result)).toMatch(/Nothing was stopped/);
  });

  it("answers an error the model can read when the Workspace cannot be reached", async () => {
    const tool = await resizeOver(fakeContainer(true, new Error("Workspace unavailable")).control);

    const result = await run(tool, { size: "cpu-2", reason: "more memory" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Could not resize the container: Workspace unavailable");
  });

  it("refuses a size that is not one, or a missing or too long reason, and resizes nothing", async () => {
    const container = fakeContainer(true);
    const tool = await resizeOver(container.control);

    for (const args of [
      { reason: "more" },
      { size: "huge", reason: "more" },
      { size: "cpu-2" },
      { size: "cpu-2", reason: "" },
      { size: "cpu-2", reason: "x".repeat(MAX_CONTAINER_REASON + 1) },
    ]) {
      const result = await run(tool, args);

      expect(result.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }

    expect(container.resizes).toEqual([]);
  });
});
