// docs/architecture/mcp-apps.md → The bridge (hostContext, hostCapabilities). What cloudpid tells an App View of its host:
// the context `ui/initialize` answers and `host-context-changed` updates, and the capabilities it advertises. Pure over a
// `HostEnvironment` the component reads from the page, so a test gives it any.
// The style variables and the context diff are the frame's, shared with Visuals (`sandbox-frame/host-context.ts`).
// @effect-diagnostics missingPipeableSignature:off -- plain functions over small values.
import type { McpAppTool } from "@cloudpid/protocol";
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiResourceCsp,
} from "@modelcontextprotocol/ext-apps";
import type * as Types from "effect/Types";
import { hostStyleVariables } from "../sandbox-frame/host-context.ts";

/** The host's name and version, as `ui/initialize` answers them. */
export const HOST_INFO = { name: "cloudpid", version: "1" } as const;

/** The tallest an inline App View grows, and the share of its scroller (`docs/architecture/mcp-apps.md` → App Panes: Sizing). */
export const INLINE_MAX_HEIGHT_PX = 640;
export const INLINE_MAX_HEIGHT_SHARE = 0.7;

/** Its height until its first `size-changed`. */
export const INLINE_INITIAL_HEIGHT_PX = 160;

/**
 * The height an inline card gives a View that reports `reported` px: at most min(640 px, 70 % of the scroller), and at least
 * a line, so a View that reports nothing sensible is still there. Before any report it is {@link INLINE_INITIAL_HEIGHT_PX}.
 */
export const inlineHeight = (reported: number | undefined, scrollerHeight: number): number => {
  if (reported === undefined) return INLINE_INITIAL_HEIGHT_PX;

  return Math.max(24, Math.min(Math.ceil(reported), inlineMaxHeight(scrollerHeight)));
};

/** The most an inline View may grow to in a scroller `scrollerHeight` px tall (0 when it is not known: the 640 px cap). */
export const inlineMaxHeight = (scrollerHeight: number): number =>
  scrollerHeight > 0
    ? Math.floor(Math.min(INLINE_MAX_HEIGHT_PX, scrollerHeight * INLINE_MAX_HEIGHT_SHARE))
    : INLINE_MAX_HEIGHT_PX;

/** What the page tells the host context of itself and the card. */
export interface HostEnvironment {
  readonly dark: boolean;
  /** A custom property's value on the page's root element, or an empty string. */
  readonly readProperty: (property: string) => string;
  readonly locale: string;
  readonly timeZone: string;
  readonly userAgent: string;
  /** Below `md`: a phone. */
  readonly mobile: boolean;
  readonly touch: boolean;
  readonly hover: boolean;
  /** The card's width in px, which is fixed for an inline View, and the most height it may grow to. */
  readonly width: number;
  readonly maxHeight: number;
}

/** How an App View is shown: in its card (`inline`) or in an App Pane (`fullscreen`): docs/architecture/mcp-apps.md → App Panes. */
export type DisplayMode = "inline" | "fullscreen";

/** The display modes cloudpid offers: `pip` is refused. */
export const AVAILABLE_DISPLAY_MODES: ReadonlyArray<DisplayMode> = ["inline", "fullscreen"];

/** How a View is shown, for the host context. */
export interface DisplayContext {
  readonly mode: DisplayMode;
  /** An App Pane's height in px: both its axes are fixed there (an inline card's height is the View's own, up to `maxHeight`). */
  readonly height?: number | undefined;
  /** An App Pane on a phone is a sheet: the insets the device keeps clear, in px. */
  readonly safeAreaInsets?: McpUiHostContext["safeAreaInsets"];
}

/** The tool an App View is shown for, as `toolInfo` names it: the server's own name for the tool. */
export interface AppToolInfo {
  readonly callId: string;
  readonly name: string;
  readonly title?: string | undefined;
  /** The tool's `inputSchema` when the inventory carries it (bounded: `MAX_MCP_APP_SCHEMA_CHARS`); else a bare object schema. */
  readonly inputSchema?: McpAppTool["inputSchema"] | undefined;
}

/**
 * The host context of an inline App View (`docs/architecture/mcp-apps.md` → The bridge): the tool, the theme from
 * `prefers-color-scheme`, the mapped design tokens and system font stacks, the display mode (`inline` in a card,
 * `fullscreen` in an App Pane), the container's dimensions (inline: width fixed, height flexible up to `maxHeight`; in a
 * Pane, both fixed), the locale, the time zone, the platform and the device's capabilities. `safeAreaInsets` is a sheet's:
 * only an App Pane on a phone gives it.
 */
export const hostContextOf = (
  env: HostEnvironment,
  tool: AppToolInfo,
  display: DisplayContext = { mode: "inline" },
): McpUiHostContext => {
  const context: McpUiHostContext = {
    toolInfo: {
      id: tool.callId,
      tool: {
        name: tool.name,
        title: tool.title,
        // An object schema, whatever the server declared: `type` is what the spec requires of one.
        inputSchema: { ...tool.inputSchema, type: "object" },
      },
    },
    theme: env.dark ? "dark" : "light",
    styles: { variables: hostStyleVariables(env.readProperty) },
    displayMode: display.mode,
    availableDisplayModes: [...AVAILABLE_DISPLAY_MODES],
    containerDimensions:
      display.mode === "fullscreen" && display.height !== undefined
        ? { width: env.width, height: display.height }
        : { width: env.width, maxHeight: env.maxHeight },
    locale: env.locale,
    timeZone: env.timeZone,
    userAgent: env.userAgent,
    platform: env.mobile ? "mobile" : "web",
    deviceCapabilities: { touch: env.touch, hover: env.hover },
  };

  if (display.safeAreaInsets !== undefined) context.safeAreaInsets = display.safeAreaInsets;

  return context;
};

/** What a frame serves of a View's asks besides its server's calls; each is advertised only when the frame does it. */
export interface HostServes {
  /** `ui/open-link`: a confirmation in the card (every frame has one). */
  readonly openLinks?: boolean;
  /** `ui/message`: the composer holds the View's message as a chip. */
  readonly message?: boolean;
  /** `ui/update-model-context`: the Session holds the View's context for the model. */
  readonly updateModelContext?: boolean;
  /** The View declared `permissions.clipboardWrite`, which the frame and the proxy grant (nothing else is granted). */
  readonly clipboardWrite?: boolean;
}

/**
 * The capabilities cloudpid advertises to a View, and nothing it does not do: the sandbox's CSP (the one the View
 * declared, which the proxy enforces as a header) and its permission (`clipboardWrite`, only when declared), `openLinks`,
 * `message` and `updateModelContext` (text only) when the frame serves them (`serves`), and, when the frame has a Session's
 * client to serve them (`serverCalls`), the View's calls of its own server's tools and resources (`requests.ts`), without
 * `listChanged` (the host sends no list-changed notification), and its log lines (`logging`, which the Session takes for
 * telemetry).
 */
export const hostCapabilities = (
  csp: McpUiResourceCsp | undefined,
  serverCalls = false,
  readOnly = false,
  serves: HostServes = {},
): McpUiHostCapabilities => {
  const sandbox: Types.Mutable<NonNullable<McpUiHostCapabilities["sandbox"]>> = {};

  if (csp !== undefined) sandbox.csp = csp;

  if (serves.clipboardWrite === true) sandbox.permissions = { clipboardWrite: {} };

  const capabilities: Types.Mutable<McpUiHostCapabilities> = { sandbox };

  if (serves.openLinks === true) capabilities.openLinks = {};

  if (serves.message === true) capabilities.message = { text: {} };

  if (serves.updateModelContext === true) capabilities.updateModelContext = { text: {} };

  if (!serverCalls) return capabilities;

  // A View that may only read (an archived Session's reopened View) is not offered the server's tools.
  if (!readOnly) capabilities.serverTools = {};

  capabilities.serverResources = {};
  capabilities.logging = {};

  return capabilities;
};
