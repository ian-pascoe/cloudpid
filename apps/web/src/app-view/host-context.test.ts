// docs/architecture/mcp-apps.md → The bridge (hostContext, hostCapabilities). What an App View is told of its host.
import { describe, expect, it } from "vitest";
import {
  INLINE_INITIAL_HEIGHT_PX,
  changedContext,
  hostCapabilities,
  hostContextOf,
  hostStyleVariables,
  inlineHeight,
  inlineMaxHeight,
  type HostEnvironment,
} from "./host-context.ts";

const env: HostEnvironment = {
  dark: true,
  readProperty: (property) => (property === "--background" ? " #000 " : ""),
  locale: "en-GB",
  timeZone: "Europe/London",
  userAgent: "test",
  mobile: false,
  touch: false,
  hover: true,
  width: 600,
  maxHeight: 640,
};

describe("inlineHeight", () => {
  it("is the starting height until the View reports one", () => {
    expect(inlineHeight(undefined, 900)).toBe(INLINE_INITIAL_HEIGHT_PX);
  });

  it("follows the View, rounded up, between a line and the cap", () => {
    expect(inlineHeight(200.2, 900)).toBe(201);
    expect(inlineHeight(0, 900)).toBe(24);
    expect(inlineHeight(5000, 2000)).toBe(640);
  });

  it("caps at 70% of a short scroller, and at 640 px when the scroller is not known", () => {
    expect(inlineMaxHeight(500)).toBe(350);
    expect(inlineMaxHeight(2000)).toBe(640);
    expect(inlineMaxHeight(0)).toBe(640);
    expect(inlineHeight(5000, 500)).toBe(350);
  });
});

describe("hostStyleVariables", () => {
  it("maps the tokens the page defines, trimmed, and leaves out the ones it does not", () => {
    const variables = hostStyleVariables(env.readProperty);

    expect(variables["--color-background-primary"]).toBe("#000");
    expect(variables["--color-text-primary"]).toBeUndefined();
    expect(variables["--border-radius-md"]).toBe("8px");
    expect(variables["--font-sans"]).toContain("system-ui");
  });
});

describe("hostContextOf", () => {
  const tool = { callId: "c1", name: "page", title: "Page" };

  it("gives toolInfo the tool's own input schema when the inventory has it, as an object schema", () => {
    const schema = { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] };

    expect(hostContextOf(env, { ...tool, inputSchema: schema }).toolInfo?.tool.inputSchema).toEqual(
      schema,
    );
    expect(hostContextOf(env, tool).toolInfo?.tool.inputSchema).toEqual({ type: "object" });
    // Whatever `type` it declared, it is an object schema: that is what the spec requires of one.
    expect(
      hostContextOf(env, { ...tool, inputSchema: { type: "string" } }).toolInfo?.tool.inputSchema,
    ).toEqual({ type: "object" });
  });

  it("describes an inline card: the tool, theme, display mode, size, locale and platform", () => {
    const context = hostContextOf(env, tool);

    expect(context).toMatchObject({
      toolInfo: { id: "c1", tool: { name: "page", title: "Page" } },
      theme: "dark",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 600, maxHeight: 640 },
      locale: "en-GB",
      timeZone: "Europe/London",
      platform: "web",
      deviceCapabilities: { touch: false, hover: true },
    });
    expect(hostContextOf({ ...env, dark: false, mobile: true }, tool)).toMatchObject({
      theme: "light",
      platform: "mobile",
    });
  });
});

describe("hostCapabilities", () => {
  it("advertises the sandbox's CSP and nothing the host does not serve", () => {
    expect(hostCapabilities(undefined)).toEqual({ sandbox: {} });
    expect(hostCapabilities({ connectDomains: ["https://a.example"] })).toEqual({
      sandbox: { csp: { connectDomains: ["https://a.example"] } },
    });
  });
});

describe("changedContext", () => {
  const before = hostContextOf(env, { callId: "c1", name: "page", title: undefined });

  it("is only what differs", () => {
    const after = hostContextOf(
      { ...env, dark: false, width: 500 },
      {
        callId: "c1",
        name: "page",
        title: undefined,
      },
    );

    expect(changedContext(before, after)).toEqual({
      theme: "light",
      containerDimensions: { width: 500, maxHeight: 640 },
    });
  });

  it("is undefined when nothing does", () => {
    expect(
      changedContext(before, hostContextOf(env, { callId: "c1", name: "page", title: undefined })),
    ).toBeUndefined();
  });
});
