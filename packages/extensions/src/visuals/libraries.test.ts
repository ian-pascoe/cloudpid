// docs/architecture/visuals.md → Testing. An opt-in check of the library table against cdnjs: `VISUAL_LIBS_CHECK=1 pnpm
// exec vitest run src/visuals/libraries.test.ts` in `packages/extensions`. Each file the guidance names is fetched at its pinned
// version, and its text is scanned for the calls the frame's CSP (no `unsafe-eval`) refuses: `eval(`, `new Function(`
// and `Function("…")`. A library passes when it has none, or only the ones listed below, each on a path a Visual does not
// take. It is skipped otherwise: it needs the network, and a pin does not change under it.
// @effect-diagnostics asyncFunction:off processEnv:off preferEffectArray:off globalFetch:off -- vitest awaits; an opt-in
// switch; a plain fetch and scan of public files.
import { VISUAL_LIBRARIES } from "@cloudpid/protocol";
import { describe, expect, it } from "vite-plus/test";

const check = process.env.VISUAL_LIBS_CHECK === "1";

/** A call the CSP refuses: `eval(…)`, `new Function(…)`, or `Function("…")` called bare. */
const EVAL_CALL = /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*["'`]/g;

/**
 * The calls a pinned file is known to make, by a piece of the text around each, and why a Visual never reaches them: a
 * call found that is not here fails the check, as does one listed here that is gone (its pin moved).
 */
const KNOWN_CALLS = new Map<string, ReadonlyArray<string>>([
  // A fallback for a browser without `JSON.parse`, which every browser has.
  ["echarts.min.js", ['new Function("return ("+']],
  // `csvParse` and `tsvParse` compile a row's accessor: in the guidance's known failures.
  ["d3.min.js", ['new Function("d","return {"+']],
  // lodash's global object, after `self` and `global`: a browser has `self`.
  ["cytoscape.umd.min.js", ['Function("return this")()']],
]);

describe.runIf(check)("the library table, fetched", () => {
  const files = VISUAL_LIBRARIES.flatMap((library) => library.files);

  it.each(files)(
    "%s is served, and makes no eval call a Visual reaches",
    async (url) => {
      const response = await fetch(url);

      expect(response.status).toBe(200);

      const text = await response.text();
      const name = url.slice(url.lastIndexOf("/") + 1);
      const known = KNOWN_CALLS.get(name) ?? [];

      const found = Array.from(text.matchAll(EVAL_CALL), (match) =>
        text.slice(match.index, match.index + 40),
      );

      const unknown = found.filter((call) => !known.some((piece) => call.startsWith(piece)));

      expect(unknown).toEqual([]);
      expect(known.filter((piece) => !found.some((call) => call.startsWith(piece)))).toEqual([]);
    },
    30_000,
  );
});
