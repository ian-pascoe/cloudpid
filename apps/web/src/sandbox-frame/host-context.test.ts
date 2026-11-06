// docs/architecture/visuals.md → The frame. What a sandboxed frame is told of its host that App Views and Visuals share: the
// style variables, and the difference between two host contexts.
import { describe, expect, it } from "vitest";
import { changedContext, hostStyleVariables } from "./host-context.ts";

const readProperty = (property: string) => (property === "--background" ? " #000 " : "");

describe("hostStyleVariables", () => {
  it("maps the tokens the page defines, trimmed, and leaves out the ones it does not", () => {
    const variables = hostStyleVariables(readProperty);

    expect(variables["--color-background-primary"]).toBe("#000");
    expect(variables["--color-text-primary"]).toBeUndefined();
    expect(variables["--border-radius-md"]).toBe("8px");
    expect(variables["--font-sans"]).toContain("system-ui");
  });
});

describe("changedContext", () => {
  const before = {
    theme: "dark",
    locale: "en-GB",
    containerDimensions: { width: 600, maxHeight: 640 },
  } as const;

  it("is only what differs", () => {
    const after = {
      ...before,
      theme: "light",
      containerDimensions: { width: 500, maxHeight: 640 },
    } as const;

    expect(changedContext(before, after)).toEqual({
      theme: "light",
      containerDimensions: { width: 500, maxHeight: 640 },
    });
  });

  it("is undefined when nothing does", () => {
    expect(changedContext(before, { ...before })).toBeUndefined();
  });
});
