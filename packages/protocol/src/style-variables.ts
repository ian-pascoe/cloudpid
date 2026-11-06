// docs/architecture/visuals.md → The frame; docs/architecture/mcp-apps.md → The bridge (hostContext). The table that maps
// cloudpid's design tokens (`apps/web/src/styles.css`) onto the ext-apps spec's style variables, which an App View is told in
// its host context and a Visual's frame is given as CSS custom properties. It is data only, so the web client reads it (with
// the page's resolved token values) and the server can check against it; the keys are the spec's `McpUiStyleVariableKey`
// names, kept as literal strings here because `@modelcontextprotocol/*` is imported only by `packages/mcp` and, as types, by
// `apps/web` (`packages/mcp/src/import-rule.test.ts`): the web client checks each against `McpUiStyleVariableKey` when it
// reads the table (`apps/web/src/sandbox-frame/host-context.ts`), so a misspelled name fails its typecheck.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- small native tables of CSS variables.

/** The color schemes a Visual is rendered in: the theme a frame is told and a check renders at. */
export const VISUAL_THEMES = ["light", "dark"] as const;

export type VisualTheme = (typeof VISUAL_THEMES)[number];

/** The system font stacks the host's fonts are (`--font-sans`, `--font-mono`; apps/web/DESIGN.md). */
export const FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * cloudpid's design tokens (`styles.css`) by the spec's style variable they stand for: `[variable, token]`. Each is read as
 * its resolved value from the page; one the page does not define is left out, never guessed.
 */
export const TOKENS = [
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
] as const;

/** The radii (apps/web/DESIGN.md: 4, 6, 8, 10 px, and a pill) and weights, which are constants of the design: `[variable, value]`. */
export const CONSTANTS = [
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
] as const;

/**
 * The resolved values of the tokens `TOKENS` names, in the light and the dark theme: what `visual_check` gives a page that a
 * frame would be given live from the app's own page (`docs/architecture/visuals.md` → Guidance: Style variables). A drift test
 * (`apps/web/src/sandbox-frame/style-values.test.ts`) holds each value to `apps/web/src/styles.css`.
 */
export const TOKEN_VALUES = {
  light: {
    "--background": "oklch(0.992 0.002 250)",
    "--foreground": "oklch(0.2 0.02 250)",
    "--muted": "oklch(0.962 0.006 250)",
    "--muted-foreground": "oklch(0.48 0.02 250)",
    "--border": "oklch(0.915 0.008 250)",
    "--input": "oklch(0.88 0.01 250)",
    "--ring": "oklch(0.55 0.12 255)",
    "--accent": "oklch(0.945 0.012 250)",
    "--destructive": "oklch(0.53 0.2 27)",
    "--success": "oklch(0.55 0.13 150)",
  },
  dark: {
    "--background": "oklch(0.2 0.012 250)",
    "--foreground": "oklch(0.95 0.005 250)",
    "--muted": "oklch(0.25 0.014 250)",
    "--muted-foreground": "oklch(0.72 0.015 250)",
    "--border": "oklch(0.32 0.016 250)",
    "--input": "oklch(0.36 0.018 250)",
    "--ring": "oklch(0.7 0.11 255)",
    "--accent": "oklch(0.29 0.02 250)",
    "--destructive": "oklch(0.7 0.17 25)",
    "--success": "oklch(0.74 0.14 150)",
  },
} as const satisfies Record<VisualTheme, Record<(typeof TOKENS)[number][1], string>>;

/** The style variables a page is given in `theme`, as a frame gives them: the tokens' values for it, and the constants. */
export const visualStyleVariables = (theme: VisualTheme): Record<string, string> => {
  const values: Record<string, string> = Object.fromEntries(CONSTANTS);

  for (const [variable, token] of TOKENS) values[variable] = TOKEN_VALUES[theme][token];

  return values;
};
