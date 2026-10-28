// The read of a Workspace's unpushed work in the Workspace DO (docs/architecture/agent-capabilities.md → Subagents),
// over clones real git made (`changes.setup.ts`) and written into a Workspace as computer's sync would: what it reads
// itself through computer's provider, compared with what the Container's `workStateScript` printed for the same clones.
// The test Worker has no Container: a fake one counts what is asked of it.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { parseWorkState, workStateScript } from "@cloudpid/sandbox-image/workspaces";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { type RepoFiles, WORK_STATE_BRANCH } from "./changes.repos.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const workState = inject("workStateRepos");
const changesRepos = inject("changesRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

let made = 0;

/** A Workspace of its own, its fake Container stopped. */
const workspace = async (): Promise<DurableObjectStub<TestWorkspace>> => {
  const stub = env.WORKSPACES.getByName(`work-state-${Date.now()}-${made++}`);

  await stub.fakeContainer({ running: false });

  return stub;
};

/** Write `files` into the Workspace as `/workspace/<name>`. */
const place = (stub: DurableObjectStub<TestWorkspace>, name: string, files: RepoFiles) =>
  stub.putFiles(
    Object.entries(files).map(([path, base64]) => [`/workspace/${name}/${path}`, bytesOf(base64)]),
  );

describe("the Workspace DO's read of unpushed work", () => {
  it("answers as the Container's git did, and leaves a stopped Container stopped", async () => {
    const stub = await workspace();

    for (const [name, files] of Object.entries(workState.files)) await place(stub, name, files);

    const read = await stub.workState(WORK_STATE_BRANCH, workState.repos);

    expect(read).toEqual(parseWorkState(workState.stdout, workState.repos));
    expect(read).toEqual([
      // The commit `mine` and the merge of the remote's newer `main`; a.txt and the untracked new/.
      {
        repo: "ahead",
        cloned: true,
        uncommitted: 2,
        unpushed: 2,
        onRemote: true,
        head: WORK_STATE_BRANCH,
      },
      {
        repo: "fresh",
        cloned: true,
        uncommitted: 0,
        unpushed: 0,
        onRemote: false,
        head: WORK_STATE_BRANCH,
      },
      { repo: "missing", cloned: false, uncommitted: 0, unpushed: 0, onRemote: false, head: null },
    ]);
    expect(await stub.fakeContainerState()).toEqual({ running: false, scripts: [] });
  });

  it("asks the Container's git for a repo it cannot read, starting it", async () => {
    const stub = await workspace();

    // Root `.gitattributes` rules git applies when it compares.
    await place(stub, "attributed", changesRepos.attributed ?? {});
    await stub.fakeContainer({ running: false, outputs: ["attributed\t1\t0\t0\t0\tmain\n"] });

    expect(await stub.workState("main", ["attributed"])).toEqual([
      {
        repo: "attributed",
        cloned: true,
        uncommitted: 0,
        unpushed: 0,
        onRemote: false,
        head: "main",
      },
    ]);
    expect(await stub.fakeContainerState()).toEqual({
      running: true,
      scripts: [workStateScript(["attributed"], "main")],
    });
  });
});
