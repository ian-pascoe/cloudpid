// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { readAttributes } from "./attributes.ts";

describe("a repo's root .gitattributes", () => {
  it("sends a repo to the Container's git when it has text, eol, binary or filter rules", () => {
    expect(readAttributes(undefined).compares).toBe(false);
    expect(readAttributes("*.lock linguist-generated\n# text comment\n").compares).toBe(false);
    expect(readAttributes("* text=auto\n").compares).toBe(true);
    expect(readAttributes("*.sh eol=lf\n").compares).toBe(true);
    expect(readAttributes("*.png binary\n").compares).toBe(true);
    expect(readAttributes("*.psd filter=lfs diff=lfs merge=lfs -text\n").compares).toBe(true);
    expect(readAttributes("*.txt -text\n").compares).toBe(true);
    expect(readAttributes("[attr]raw binary\n").compares).toBe(true);
  });

  it("flags generated and vendored files as git matches them, the last line winning", () => {
    const attributes = readAttributes(
      [
        "*.gen.ts linguist-generated",
        "/dist/** linguist-generated=true",
        "vendor/** linguist-vendored",
        "docs/*.md linguist-vendored",
        "src/keep.gen.ts linguist-generated=false",
        "third_party/ linguist-vendored",
        '"with space/*.js" -linguist-vendored',
        "**/fixtures/** linguist-generated !linguist-vendored",
      ].join("\n"),
    );

    expect(attributes.linguist("a/b/x.gen.ts")).toEqual({ generated: true });
    expect(attributes.linguist("src/keep.gen.ts")).toEqual({ generated: false });
    expect(attributes.linguist("dist/a/b.js")).toEqual({ generated: true });
    expect(attributes.linguist("app/dist/b.js")).toEqual({});
    expect(attributes.linguist("vendor/lib/x.c")).toEqual({ vendored: true });
    expect(attributes.linguist("docs/a.md")).toEqual({ vendored: true });
    expect(attributes.linguist("docs/deep/a.md")).toEqual({});
    // A pattern naming a directory matches nothing inside it.
    expect(attributes.linguist("third_party/x.c")).toEqual({});
    expect(attributes.linguist("with space/a.js")).toEqual({ vendored: false });
    expect(attributes.linguist("fixtures/a.json")).toEqual({ generated: true });
    expect(attributes.linguist("src/fixtures/a/b.json")).toEqual({ generated: true });
    expect(attributes.linguist("src/index.ts")).toEqual({});
  });
});
