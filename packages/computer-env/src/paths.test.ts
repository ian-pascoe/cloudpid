import { describe, expect, it } from "vitest";
import { join, resolve } from "./paths.ts";

describe("Workspace paths", () => {
  it("resolve relative paths, dot segments and file URLs against the cwd", () => {
    expect(resolve("/workspace/repo", "src/../README.md")).toBe("/workspace/repo/README.md");
    expect(resolve("/workspace/repo", "/tmp//x/")).toBe("/tmp/x");
    expect(resolve("/workspace", "../../..")).toBe("/");
    expect(resolve("/workspace", "file:///workspace/a%20b.txt")).toBe("/workspace/a b.txt");
  });

  it("join parts, staying relative unless the first part is absolute", () => {
    expect(join(["a", "b/../c"])).toBe("a/c");
    expect(join(["/a", "b"])).toBe("/a/b");
    expect(join(["a", ".."])).toBe(".");
  });
});
