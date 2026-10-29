// The owner's Instructions and the Project instructions in a Session's system prompt, through the Session's own
// extensions on a real Workspace (docs/architecture/workspace.md → Instructions): the Instructions come first, so the
// Project instructions after them win where the two disagree. workerd's APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";

describe("a Session's instruction sections", () => {
  it("show the owner's Instructions just before the Project instructions, as the Session installs them", async () => {
    const slug = uniqueWorkspace();

    await sessionOn(slug).run([
      call("write", { path: "demo/AGENTS.md", content: "Run the focused checks only." }),
    ]);

    const { sections } = await sessionOn(slug, "demo").runFull([]);
    const keys = Object.keys(sections);

    expect(sections["project_context"]).toContain("Run the focused checks only.");
    // The Workspace tests keep no Instructions: the section is there, and empty.
    expect(sections["owner_instructions"]).toBe("");
    expect(keys.indexOf("owner_instructions")).toBe(keys.indexOf("project_context") - 1);
  });
});
