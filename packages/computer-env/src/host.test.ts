// `WorkspaceEnvHost.readEnv`: the environment code inside the Workspace DO reads files through. Paths resolve against
// its `cwd` as `ComputerExecutionEnv`'s do, so the same paths reach the same files.
// @effect-diagnostics asyncFunction:off
import type { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { WorkspaceEnvHost } from "./host.ts";

/** A Workspace whose files are `files` (absolute path to text), and the paths it was asked to read. */
const hostOf = (files: Readonly<Record<string, string>>) => {
  const read: string[] = [];

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `readEnv`'s `readTextFile` uses only `fs.readFile`, which the fake answers.
  const workspace = {
    fs: {
      readFile: async (path: string) => {
        read.push(path);

        const text = files[path];

        if (text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });

        return new Response(text).body;
      },
    },
  } as unknown as Workspace;

  return { host: new WorkspaceEnvHost(workspace), read };
};

describe("WorkspaceEnvHost.readEnv", () => {
  it("resolves a relative path against its cwd, and normalizes an absolute one", async () => {
    const { host, read } = hostOf({
      "/workspace/repo/a/SKILL.md": "relative",
      "/workspace/b/SKILL.md": "absolute",
    });

    const env = host.readEnv("/workspace/repo");

    expect(getOrThrow(await env.readTextFile("a/./SKILL.md", BACKGROUND_CONTEXT))).toBe("relative");
    expect(
      getOrThrow(await env.readTextFile("/workspace//x/../b/SKILL.md", BACKGROUND_CONTEXT)),
    ).toBe("absolute");
    expect(read).toEqual(["/workspace/repo/a/SKILL.md", "/workspace/b/SKILL.md"]);
  });
});
