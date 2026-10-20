// The `bash` tool's backend argument, through a real Harness with a scripted model: the call reaches the environment's
// Worker Shell or Container as asked, and the model's description of the two is what tells it which to pick.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { describe, expect, it } from "vitest";
import { type BackendCall, openCodingHarness } from "./coding-tools.fixture.ts";

describe("bash", () => {
  it("runs on the environment's default backend when no backend is asked for", async () => {
    const { call, calls } = await openCodingHarness({ backends: true });

    expect(await call("bash", { command: "echo hi" })).toEqual({
      text: "default: echo hi",
      isError: false,
    });
    expect(calls).toEqual<BackendCall[]>([{ backend: undefined, command: "echo hi" }]);
  });

  it.each(["worker", "container"] as const)(
    "runs on the %s backend when asked",
    async (backend) => {
      const { call, calls } = await openCodingHarness({ backends: true });

      expect(await call("bash", { command: "uname", backend })).toEqual({
        text: `${backend}: uname`,
        isError: false,
      });
      expect(calls).toEqual<BackendCall[]>([{ backend, command: "uname" }]);
    },
  );

  it("keeps the exit status and timeout of a container call", async () => {
    const { call, calls } = await openCodingHarness({ backends: true, exitCode: 3 });

    const result = await call("bash", { command: "false", backend: "container", timeout: 5 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Command exited with code 3");
    expect(calls).toEqual<BackendCall[]>([{ backend: "container", command: "false", timeout: 5 }]);
  });

  it("refuses a backend the schema does not list, and runs nothing", async () => {
    const { call, calls } = await openCodingHarness({ backends: true });

    const result = await call("bash", { command: "ls", backend: "gpu" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("tells the model when its environment has no Container, and runs nothing", async () => {
    const { call, calls } = await openCodingHarness({ backends: false });

    const result = await call("bash", { command: "ls", backend: "container" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("container");
    expect(calls).toEqual([]);
  });

  it("still runs the default backend in an environment without backends", async () => {
    const { call, calls } = await openCodingHarness({ backends: false });

    expect(await call("bash", { command: "echo hi", backend: "worker" })).toEqual({
      text: "default: echo hi",
      isError: false,
    });
    expect(calls).toEqual<BackendCall[]>([{ backend: undefined, command: "echo hi" }]);
  });

  it("describes both backends to the model", async () => {
    const { tool } = await openCodingHarness({ backends: true });

    expect(tool("bash")?.description).toMatch(/worker/i);
    expect(tool("bash")?.description).toMatch(/container/i);
    expect(tool("bash")?.description).toMatch(/ELF|native binar/i);
    expect(JSON.stringify(tool("bash")?.parameters)).toContain("container");
  });
});
