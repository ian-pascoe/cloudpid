// @effect-diagnostics asyncFunction:off
import type { RepoWorkState } from "@cloudpid/extensions/subagents";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { SubagentWorkspaceRefusal, WorkspaceRecord } from "../registry/store.ts";
import { sessionSubagentWorkspaces, spawnWarnings } from "./subagent-workspaces.ts";
import { workspacePlacement } from "./workspace.ts";

const record = (id: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  id,
  environment: "default",
  branch: `cloudpid/${id}`,
  base: null,
  repos: ["app"],
  directory: "/workspace/app",
  createdAt: 0,
  ...overrides,
});

const repo = (overrides: Partial<RepoWorkState> = {}): RepoWorkState => ({
  repo: "app",
  cloned: true,
  uncommitted: 0,
  unpushed: 0,
  onRemote: true,
  head: "feature/parent",
  ...overrides,
});

const setUp = (
  options: {
    readonly session?: string | undefined;
    readonly refusal?: SubagentWorkspaceRefusal;
    readonly states?: ReadonlyArray<RepoWorkState>;
  } = {},
) => {
  const calls: string[] = [];
  const asked: unknown[] = [];

  const records = new Map<string, WorkspaceRecord>([
    ["0a0a0a0a", record("0a0a0a0a", { branch: "feature/parent" })],
  ]);

  const host = sessionSubagentWorkspaces({
    session: "session" in options ? options.session : "s1",
    registry: {
      getWorkspace: ({ id }) => Effect.sync(() => records.get(id) ?? null),
      createSubagentWorkspace: (input) =>
        Effect.sync(() => {
          asked.push(input);

          if (options.refusal !== undefined) return options.refusal;

          const made = record("1b1b1b1b", {
            branch: input.branch ?? "cloudpid/1b1b1b1b",
            base: input.base,
            subagent: { session: input.session, agent: input.agent },
          });

          records.set(made.id, made);

          return made;
        }),
    },
    placement: async () => workspacePlacement("0a0a0a0a", "/workspace/app"),
    objects: {
      workState: async (name, branch, repos) => {
        calls.push(`workState:${name}:${branch}:${Arr.join(repos, ",")}`);

        return options.states ?? [repo()];
      },
    },
    remove: (workspace) =>
      Effect.sync(() => {
        calls.push(`remove:${workspace.id}`);
      }),
    builds: { of: (environment) => Effect.sync(() => void calls.push(`builds:${environment}`)) },
    run: Effect.runPromise,
  });

  return { host, calls, asked, records };
};

const request = {
  agent: "impl",
  parent: null,
  base: undefined,
  branch: undefined,
  limit: 3,
} as const;

describe("a Session's Subagent Workspaces", () => {
  it("registers one from the spawner's branch, keeps the Build current but makes no spare behind it, and reads the spawner's work on that branch", async () => {
    const { host, calls, asked } = setUp();

    const made = await host.create(request);

    expect(asked).toEqual([
      { session: "s1", agent: "impl", branch: null, base: "feature/parent", limit: 3 },
    ]);
    expect(made).toEqual({
      workspace: {
        id: "1b1b1b1b",
        branch: "cloudpid/1b1b1b1b",
        object: "ws:1b1b1b1b",
        directory: "/workspace/app",
      },
      warnings: [],
    });
    // A spare it took is not made again: a Subagent Workspace is no new Session (docs/architecture/workspace.md).
    expect(calls).toEqual(["builds:default", "workState:ws:0a0a0a0a:feature/parent:app"]);
  });

  it("warns of the spawner's work that does not reach the child: unpushed commits on base, uncommitted changes, a base not on origin", async () => {
    const { host } = setUp({
      states: [repo({ unpushed: 2, uncommitted: 1, onRemote: false })],
    });

    const { warnings } = await host.create({ ...request, base: "main" });

    expect(warnings).toEqual([
      "app: origin has no branch main, so the child's clone of it cannot start until you push main.",
      "app: 2 commits on main not pushed, which the child does not have.",
      "app: 1 uncommitted change in your Workspace, which the child does not have.",
    ]);
  });

  it("starts a grandchild from its parent's Subagent Workspace's branch", async () => {
    const { host, asked, records } = setUp();

    records.set("2c2c2c2c", record("2c2c2c2c", { branch: "cloudpid/2c2c2c2c" }));

    await host.create({
      ...request,
      parent: {
        id: "2c2c2c2c",
        branch: "cloudpid/2c2c2c2c",
        object: "ws:2c2c2c2c",
        directory: "/workspace/app",
      },
    });

    expect(asked).toMatchObject([{ base: "cloudpid/2c2c2c2c" }]);
  });

  it("refuses past the limit, naming it and the tool that raises it", async () => {
    const { host, calls } = setUp({ refusal: { refused: "limit", count: 3 } });

    await expect(host.create(request)).rejects.toThrow(
      "This Session has 3 Subagent Workspaces, the Subagent Workspace limit (3): delete one with subagent_delete, or ask for a higher limit with settings_subagent_workspaces_set.",
    );
    expect(calls).toEqual([]);
  });

  it("refuses in a Session the Registry does not list", async () => {
    const { host, asked } = setUp({ session: undefined });

    await expect(host.create(request)).rejects.toThrow("not listed by the Registry");
    expect(asked).toEqual([]);
  });

  it("refuses a branch that is not the agent's to take", async () => {
    const { host, asked } = setUp();

    await expect(host.create({ ...request, branch: "cloudpid/spare" })).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("removes only its own Session's, and nothing for one already gone", async () => {
    const { host, calls, records } = setUp();

    const { workspace } = await host.create(request);

    calls.length = 0;
    await host.remove(workspace);
    expect(calls).toEqual(["remove:1b1b1b1b"]);

    records.set("3d3d3d3d", record("3d3d3d3d", { subagent: { session: "other", agent: "impl" } }));
    await expect(host.remove({ ...workspace, id: "3d3d3d3d" })).rejects.toThrow(
      "not a Subagent Workspace of this Session",
    );

    calls.length = 0;
    await host.remove({ ...workspace, id: "ffffffff" });
    expect(calls).toEqual([]);
  });

  it("says when the spawner's work could not be read", () => {
    expect(spawnWarnings("main", new Error("no Container"))[0]).toContain("no Container");
  });
});
