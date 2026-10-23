// `restart_container` (docs/spec.md → Container and Toolchains → Restart by the agent), over a fake Workspace Container.
// @effect-diagnostics asyncFunction:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  type ContainerControl,
  ContainerTools,
  describeRestart,
  MAX_RESTART_REASON,
  WorkspaceContainer,
} from "./container.ts";

/** A Workspace Container that records each restart and answers `wasRunning`, or fails with `failure`. */
const fakeContainer = (wasRunning: boolean, failure?: Error) => {
  const restarts: Array<{ readonly fresh: boolean }> = [];

  const control: ContainerControl = {
    restart: async (options) => {
      restarts.push(options);

      if (failure !== undefined) throw failure;

      return { wasRunning };
    },
  };

  return { control, restarts };
};

const toolOver = async (control: ContainerControl): Promise<ToolRegistration> => {
  const extension = await Effect.runPromise(
    ContainerTools.pipe(Effect.provideService(WorkspaceContainer, control)),
  );

  const [tool] = extension.tools ?? [];

  if (tool === undefined) throw new Error("no tool");

  return tool;
};

// The tool reads nothing from the invocation's API.
const api: ToolExecutionApi = Object.create(null);

/** A call's arguments, as the model sends them: what the tool takes, or less, to see it refused. */
type Args = { readonly reason?: string; readonly fresh?: boolean };

const run = (tool: ToolRegistration, args: Args) =>
  // SAFETY: the arguments are the tool's JSON parameters, or deliberately not, to see them refused.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Awaited<ReturnType<ToolRegistration["execute"]>>): string =>
  Arr.join(
    Arr.map(result.output ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );

describe("restart_container", () => {
  it("is one tool, never replayed after an eviction, run alone in its conversation", async () => {
    const extension = await Effect.runPromise(
      ContainerTools.pipe(Effect.provideService(WorkspaceContainer, fakeContainer(true).control)),
    );

    expect(extension.name).toBe("container");
    expect(Arr.map(extension.tools ?? [], (tool) => tool.name)).toEqual(["restart_container"]);

    const [tool] = extension.tools ?? [];

    expect(tool?.replay).toBe("unsafe");
    expect(tool?.executionMode).toBe("sequential");
  });

  it("asks for a reason, and says when to use it, what it ends and what the next command starts from", async () => {
    const tool = await toolOver(fakeContainer(true).control);

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
  });

  it("restarts from the snapshot by default, and says the running commands ended", async () => {
    const container = fakeContainer(true);
    const tool = await toolOver(container.control);

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
    const tool = await toolOver(container.control);

    const result = await run(tool, {
      reason: "the snapshot's node_modules is broken",
      fresh: true,
    });

    expect(container.restarts).toEqual([{ fresh: true }]);
    expect(text(result)).toMatch(/Build or the image/);
    expect(text(result)).toMatch(/Setup Scripts run again/);
  });

  it("says so when no container was running", async () => {
    const tool = await toolOver(fakeContainer(false).control);

    expect(text(await run(tool, { reason: "just in case" }))).toMatch(
      /^No container was running, so none was stopped\. The next container command/,
    );
    expect(text(await run(tool, { reason: "just in case", fresh: true }))).toMatch(
      /^No container was running, so none was stopped\. The snapshot is forgotten\./,
    );
  });

  it("answers an error the model can read when the Workspace cannot be reached", async () => {
    const tool = await toolOver(fakeContainer(true, new Error("Workspace unavailable")).control);

    const result = await run(tool, { reason: "hung" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Could not restart the container: Workspace unavailable");
  });

  it("refuses a call without a reason, or with one too long, and restarts nothing", async () => {
    const container = fakeContainer(true);
    const tool = await toolOver(container.control);

    for (const args of [{}, { reason: "" }, { reason: "x".repeat(MAX_RESTART_REASON + 1) }]) {
      const result = await run(tool, args);

      expect(result.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }

    expect(container.restarts).toEqual([]);
  });
});
