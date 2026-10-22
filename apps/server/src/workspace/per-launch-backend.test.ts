// The Container's backend, built again whenever a launch has other Container-only paths (docs/spec.md → Container and
// Toolchains → Size and idle): computer takes them when its backend is built. computer's backend is a fake.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import { type LaunchedBackend, PerLaunchContainerBackend } from "./per-launch-backend.ts";

// SAFETY: the fake backends never read the host.
const HOST = {} as Parameters<WorkspaceBackend["connect"]>[0];

type State = {
  ignore: readonly string[] | undefined;
  /** The paths of each backend built, in order. */
  built: Array<readonly string[] | undefined>;
  /** Which backend (its index in `built`) each connection and each request went to. */
  connects: number[];
  fetches: number[];
  refuse: boolean;
};

const open = (first: readonly string[] | undefined) => {
  const state: State = { ignore: first, built: [], connects: [], fetches: [], refuse: false };

  const build = (ignore: readonly string[] | undefined): LaunchedBackend => {
    if (state.refuse) throw new Error('`ignore` pattern "x" must start with "/"');

    const index = state.built.push(ignore) - 1;

    return {
      id: "container-shell",
      type: "cloudflare-container",
      description: "A shell in a full Linux container.",
      connect: async () => {
        state.connects.push(index);

        // SAFETY: the tests only compare what comes back.
        return { runtimeId: `run-${index}` } as BackendHandle;
      },
      handleFetch: async () => {
        state.fetches.push(index);

        return new Response(null);
      },
    };
  };

  const backend = new PerLaunchContainerBackend({ build, ignore: async () => state.ignore });

  return { state, backend };
};

describe("PerLaunchContainerBackend", () => {
  it("is computer's backend to the Workspace: the same id, type and description", () => {
    const { backend } = open(["**/node_modules"]);

    expect(backend.id).toBe("container-shell");
    expect(backend.type).toBe("cloudflare-container");
    expect(backend.description).toBe("A shell in a full Linux container.");
  });

  it("connects through a backend built with the Container-only paths of the launch, and keeps it while they hold", async () => {
    const { state, backend } = open(["**/node_modules", "/data"]);

    const first = await backend.connect(HOST);
    const second = await backend.connect(HOST);

    expect(first.runtimeId).toBe(second.runtimeId);
    expect(state.built[state.connects[0] ?? -1]).toEqual(["**/node_modules", "/data"]);
    expect(new Set(state.connects).size).toBe(1);
  });

  it("builds another for a launch with other paths", async () => {
    const { state, backend } = open(["**/node_modules"]);

    await backend.connect(HOST);
    state.ignore = ["**/node_modules", "/data"];
    await backend.connect(HOST);

    expect(state.connects.map((index) => state.built[index])).toEqual([
      ["**/node_modules"],
      ["**/node_modules", "/data"],
    ]);
  });

  it("hands the Container's requests (computerd dialling back) to the backend it connects through", async () => {
    const { state, backend } = open(["**/node_modules"]);

    await backend.connect(HOST);
    state.ignore = ["/data"];
    await backend.connect(HOST);
    await backend.handleFetch(new Request("https://computer.internal/"));

    expect(state.fetches).toEqual([state.connects[1]]);
  });

  it("fails the connection, not the Workspace, when computer refuses the paths", async () => {
    const { state, backend } = open(["**/node_modules"]);

    state.refuse = true;

    await expect(backend.connect(HOST)).rejects.toThrow("must start with");
  });
});
