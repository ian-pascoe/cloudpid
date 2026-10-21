import { DEFAULT_OFFERED_TOOLS } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { badOfferedEntries, offeredFromText, offeredToText } from "./offered-tools.ts";

describe("the offered tools text", () => {
  it("round-trips the default offered tools", () => {
    expect(offeredFromText(offeredToText(DEFAULT_OFFERED_TOOLS))).toEqual(DEFAULT_OFFERED_TOOLS);
  });

  it("takes one name or pattern per line, and drops blank lines, spaces, and repeats", () => {
    expect(offeredFromText("read\n\n  context_*  \nread\nbash\n")).toEqual([
      "read",
      "context_*",
      "bash",
    ]);
  });

  it("also splits at commas, for a pasted list", () => {
    expect(offeredFromText("read, bash,edit")).toEqual(["read", "bash", "edit"]);
  });

  it("is an empty list for an empty box, which defers every tool but tool_search", () => {
    expect(offeredFromText("")).toEqual([]);
    expect(offeredFromText("  \n ")).toEqual([]);
  });
});

describe("the offered tools the settings would refuse", () => {
  it("are the entries that are not snake_case names or patterns", () => {
    expect(badOfferedEntries(offeredFromText("read\nWeb Fetch\ncontext_*\nbash;"))).toEqual([
      "Web Fetch",
      "bash;",
    ]);
    expect(badOfferedEntries(DEFAULT_OFFERED_TOOLS)).toEqual([]);
  });
});
