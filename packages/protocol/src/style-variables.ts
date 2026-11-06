// docs/architecture/visuals.md → The frame; docs/architecture/mcp-apps.md → The bridge (hostContext). The table that maps
// cloudpid's design tokens (`apps/web/src/styles.css`) onto the ext-apps spec's style variables, which an App View is told in
// its host context and a Visual's frame is given as CSS custom properties. It is data only, so the web client reads it (with
// the page's resolved token values) and the server can check against it; the keys are the spec's `McpUiStyleVariableKey`
// names, kept as literal strings here because `@modelcontextprotocol/*` is imported only by `packages/mcp` and, as types, by
// `apps/web` (`packages/mcp/src/import-rule.test.ts`): the web client checks each against `McpUiStyleVariableKey` when it
// reads the table (`apps/web/src/sandbox-frame/host-context.ts`), so a misspelled name fails its typecheck.
// @effect-diagnostics preferEffectArray:off -- small native tables of CSS variables.

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
