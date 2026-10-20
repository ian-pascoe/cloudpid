// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { ComputerExecutionEnv, ComputerFiles } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isMissing, listRepos } from "./repos.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

describe("a Workspace's repos, read from its files", () => {
  it("are none in a new Workspace, and are the directories with a .git once there are some", async () => {
    const workspace = env.WORKSPACES.getByName("repos-listing");
    const files = new ComputerFiles(workspace);

    expect(await listRepos(files)).toEqual([]);

    const executionEnv = new ComputerExecutionEnv({
      workspace,
      id: "computer:repos-listing",
      cwd: "/workspace",
    });

    getOrThrow(
      await executionEnv.createDir(
        "/workspace/with-git/.git",
        { recursive: true },
        BACKGROUND_CONTEXT,
      ),
    );
    getOrThrow(
      await executionEnv.createDir("/workspace/plain", { recursive: true }, BACKGROUND_CONTEXT),
    );
    getOrThrow(await executionEnv.writeFile("/workspace/file.txt", "x", BACKGROUND_CONTEXT));

    expect(await listRepos(files)).toEqual(["with-git"]);
  });

  it("see a path that is not there, as the Workspace DO reports it over RPC, as missing", async () => {
    const files = new ComputerFiles(env.WORKSPACES.getByName("repos-missing"));

    const failure = await files.readdir("/workspace/nothing-here").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(isMissing(failure)).toBe(true);
    expect(isMissing(new Error("stub disconnected"))).toBe(false);
  });
});
