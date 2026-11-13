// docs/architecture/mcp-apps.md → The bridge (hostContext, hostCapabilities). What an App View is told of its host.
import { describe, expect, it } from "vite-plus/test";
import {
  INLINE_INITIAL_HEIGHT_PX,
  hostCapabilities,
  hostContextOf,
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
      availableDisplayModes: ["inline", "fullscreen"],
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
    expect(context).not.toHaveProperty("safeAreaInsets");
  });

  it("describes an App Pane: fullscreen, both axes fixed, and a sheet's safe area only when it is one", () => {
    const pane = { mode: "fullscreen", height: 720 } as const;

    expect(hostContextOf(env, tool, pane)).toMatchObject({
      displayMode: "fullscreen",
      containerDimensions: { width: 600, height: 720 },
    });
    expect(hostContextOf(env, tool, pane)).not.toHaveProperty("safeAreaInsets");
    expect(hostContextOf(env, tool, pane).containerDimensions).not.toHaveProperty("maxHeight");

    const insets = { top: 47, right: 0, bottom: 34, left: 0 };

    expect(
      hostContextOf({ ...env, mobile: true }, tool, { ...pane, safeAreaInsets: insets }),
    ).toMatchObject({ platform: "mobile", safeAreaInsets: insets });
  });
});

describe("hostCapabilities", () => {
  it("advertises the sandbox's CSP, and the server calls it serves only when it has a client to serve them, with no listChanged", () => {
    expect(hostCapabilities(undefined)).toEqual({ sandbox: {} });
    expect(hostCapabilities({ connectDomains: ["https://a.example"] })).toEqual({
      sandbox: { csp: { connectDomains: ["https://a.example"] } },
    });
    expect(hostCapabilities(undefined, true)).toEqual({
      sandbox: {},
      serverTools: {},
      serverResources: {},
      logging: {},
    });
  });

  it("advertises only reads, no tool calls, to a View that may only read", () => {
    expect(hostCapabilities(undefined, true, true)).toEqual({
      sandbox: {},
      serverResources: {},
      logging: {},
    });
    // With no client there is nothing to read with, whatever the View may do.
    expect(hostCapabilities(undefined, false, true)).toEqual({ sandbox: {} });
  });
});

describe("hostCapabilities of what a frame serves", () => {
  it("advertises openLinks, message, updateModelContext (text only) and the clipboard only when the frame serves them", () => {
    expect(hostCapabilities(undefined, false, false, { openLinks: true })).toEqual({
      sandbox: {},
      openLinks: {},
    });

    expect(
      hostCapabilities(undefined, false, false, {
        openLinks: true,
        message: true,
        updateModelContext: true,
        clipboardWrite: true,
      }),
    ).toEqual({
      sandbox: { permissions: { clipboardWrite: {} } },
      openLinks: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    });
  });

  it("grants the clipboard and nothing else of the browser's permissions", () => {
    const granted = hostCapabilities({ connectDomains: ["https://a.example"] }, true, false, {
      clipboardWrite: true,
    }).sandbox;

    expect(granted).toEqual({
      csp: { connectDomains: ["https://a.example"] },
      permissions: { clipboardWrite: {} },
    });
    expect(hostCapabilities(undefined, true, false, { clipboardWrite: false }).sandbox).toEqual({});
  });
});
