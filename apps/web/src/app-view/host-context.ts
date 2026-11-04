// docs/architecture/mcp-apps.md → The bridge (hostContext, hostCapabilities). What cloudpid tells an App View of its host:
// the context `ui/initialize` answers and `host-context-changed` updates, and the capabilities it advertises. Pure over a
// `HostEnvironment` the component reads from the page, so a test gives it any.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- small native tables of CSS variables.
import type { McpAppTool } from "@cloudpid/protocol";
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiResourceCsp,
  McpUiStyleVariableKey,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps";

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

/** The system font stacks the host's fonts are (`--font-sans`, `--font-mono`; apps/web/DESIGN.md). */
export const FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * cloudpid's design tokens (`styles.css`) by the spec's style variable they stand for. Each is read as its resolved value
 * from the page; one the page does not define is left out, never guessed.
 */
const TOKENS: ReadonlyArray<readonly [McpUiStyleVariableKey, string]> = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--muted"],
  ["--color-background-tertiary", "--accent"],
  ["--color-background-inverse", "--foreground"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-inverse", "--background"],
  ["--color-text-danger", "--destructive"],
  ["--color-text-success", "--success"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--input"],
  ["--color-border-danger", "--destructive"],
  ["--color-border-success", "--success"],
  ["--color-ring-primary", "--ring"],
  ["--color-ring-danger", "--destructive"],
  ["--color-ring-success", "--success"],
];

/** The radii (apps/web/DESIGN.md: 4, 6, 8, 10 px, and a pill) and weights, which are constants of the design. */
const CONSTANTS: ReadonlyArray<readonly [McpUiStyleVariableKey, string]> = [
  ["--font-sans", FONT_SANS],
  ["--font-mono", FONT_MONO],
  ["--font-weight-normal", "400"],
  ["--font-weight-medium", "500"],
  ["--font-weight-semibold", "600"],
  ["--border-radius-xs", "4px"],
  ["--border-radius-sm", "6px"],
  ["--border-radius-md", "8px"],
  ["--border-radius-lg", "10px"],
  ["--border-radius-full", "9999px"],
  ["--border-width-regular", "1px"],
];

/**
 * The style variables of the host: cloudpid's tokens as the page resolves them (`read` gives a custom property's value, or
 * an empty string), and its constants. Unmapped ones are omitted.
 */
export const hostStyleVariables = (read: (property: string) => string): McpUiStyles => {
  const variables: Partial<Record<McpUiStyleVariableKey, string>> = {};

  for (const [key, property] of TOKENS) {
    const value = read(property).trim();

    if (value !== "") variables[key] = value;
  }

  for (const [key, value] of CONSTANTS) variables[key] = value;

  // SAFETY: the spec types the record with every key, though a host sends the ones it has (the generated schema is partial).
  return variables as McpUiStyles;
};

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
 * `prefers-color-scheme`, the mapped design tokens and system font stacks, the display mode (only `inline` is offered
 * here), the container's dimensions (width fixed, height flexible up to `maxHeight`), the locale, the time zone, the
 * platform and the device's capabilities. `safeAreaInsets` is a sheet's, which the App Pane adds.
 */
export const hostContextOf = (env: HostEnvironment, tool: AppToolInfo): McpUiHostContext => ({
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
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  containerDimensions: { width: env.width, maxHeight: env.maxHeight },
  locale: env.locale,
  timeZone: env.timeZone,
  userAgent: env.userAgent,
  platform: env.mobile ? "mobile" : "web",
  deviceCapabilities: { touch: env.touch, hover: env.hover },
});

/**
 * The capabilities cloudpid advertises to a View, and nothing it does not do: the sandbox's CSP (the one the View
 * declared, which the proxy enforces as a header), and, when the frame has a Session's client to serve them (`serverCalls`),
 * the View's calls of its own server's tools and resources (`requests.ts`), without `listChanged` (the host sends no
 * list-changed notification). Links, logging, clipboard and messages are added by the tickets that serve them.
 */
export const hostCapabilities = (
  csp: McpUiResourceCsp | undefined,
  serverCalls = false,
): McpUiHostCapabilities => {
  const sandbox = csp === undefined ? {} : { csp };

  return serverCalls ? { sandbox, serverTools: {}, serverResources: {} } : { sandbox };
};

/**
 * What of `next` differs from `before`, by top-level key, for `host-context-changed` (which carries only what changed);
 * undefined when nothing does. Values are compared as the JSON they are sent as.
 */
export const changedContext = (
  before: McpUiHostContext,
  next: McpUiHostContext,
): McpUiHostContext | undefined => {
  const changed: McpUiHostContext = {};

  for (const key of Object.keys(next)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) changed[key] = next[key];
  }

  return Object.keys(changed).length === 0 ? undefined : changed;
};
