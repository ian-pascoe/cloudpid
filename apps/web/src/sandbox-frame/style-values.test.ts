// docs/architecture/visuals.md → Guidance (Style variables), Testing. `visual_check` gives a page the tokens' values from a table
// in `packages/protocol`, where a frame is told them live from the page; this holds each of them to `src/styles.css`, so a
// redesign that changes a token fails here until the table follows.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off -- reads a stylesheet into small native maps.
import { readFileSync } from "node:fs";
import { TOKEN_VALUES, TOKENS } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** The custom properties of the block that opens at `start`, up to its closing brace. */
const propertiesFrom = (start: number): Map<string, string> => {
  const body = css.slice(start, css.indexOf("}", start));
  const found = new Map<string, string>();

  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) found.set(name, value.trim());
  }

  return found;
};

const light = propertiesFrom(css.indexOf(":root {"));

const dark = propertiesFrom(
  css.indexOf(":root {", css.indexOf("@media (prefers-color-scheme: dark) {")),
);

describe("visual_check's token values", () => {
  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("are styles.css's in the %s theme", (theme, sheet) => {
    for (const [, token] of TOKENS) {
      expect(TOKEN_VALUES[theme][token], `${theme} ${token}`).toBe(sheet.get(token));
    }
  });
});
