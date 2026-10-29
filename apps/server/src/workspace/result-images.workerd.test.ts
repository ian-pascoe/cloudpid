// Several images in one tool result, through a Session's `codemode` on a real Workspace: a script can show many, each
// within the per-image bound, which together would outgrow the result's one SQLite row. They are kept in order until
// one result's budget is spent, and the rest are noted, in the stored result and in the script's run, which code mode
// stores before it (docs/architecture/workspace.md → Filesystem and tools). The sizes are what is checked: the script
// would need more images than this to pass the 8 MiB a row holds (workerd#7493).
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off globalDate:off
import { MAX_RESULT_IMAGE_CHARACTERS } from "@cloudpid/extensions/images";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { remoteSandbox } from "../session/codemode.ts";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { call, uniqueWorkspace } from "./session.workerd.helpers.ts";

/** The base64 of a PNG's signature and header (1000 x 1000), which a script's `image()` checks for. */
const PNG_HEAD = "iVBORw0KGgoAAAANSUhEUgAAA+gAAAPoCAIAAADCwUOz";

/** A script that shows four images of 640,000 base64 characters: each within the per-image bound, 2.56 M together. */
const SHOW_FOUR = `for (let shown = 0; shown < 4; shown++) image({ type: "image", data: "${PNG_HEAD}" + "A".repeat(${640_000 - PNG_HEAD.length}), mimeType: "image/png" });`;

describe("a tool result's images", () => {
  it("are held to one result's budget when a script shows several, and the rest are noted", async () => {
    const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

    await runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(uniqueWorkspace());
      instance.script([
        call("codemode", {
          code: SHOW_FOUR,
        }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      const images = await instance.toolResultImages();
      const [result] = await instance.toolResults();

      expect(images.map((image) => image.characters)).toEqual([640_000, 640_000]);
      expect(images.reduce((sum, image) => sum + image.characters, 0)).toBeLessThanOrEqual(
        MAX_RESULT_IMAGE_CHARACTERS,
      );
      expect(result).toContain("was left out: one tool result holds at most 1,500,000");
      expect(instance.longestHarnessRow()).toBeLessThan(1_900_000);
    });
  });

  it("are held to the budget in a script's own result, which code mode stores before the tool result", async () => {
    // Code mode keeps the script's result in its run's document, a row of its own, until the call ends.
    const run = remoteSandbox(env.CODEMODE_SANDBOX, "result-images").start(SHOW_FOUR, {
      startedAt: Date.now(),
      seed: 1,
      onCall: () => {},
    });

    const { output } = await run.result;

    expect(
      output.map((item) => (item.type === "image" ? item.data.length : item.text.slice(0, 20))),
    ).toEqual([640_000, 640_000, "[An image (image/png", "[An image (image/png"]);
  });
});
