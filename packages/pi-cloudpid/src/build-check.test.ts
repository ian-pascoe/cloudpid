// @effect-diagnostics *:off -- a test, on the owner's machine, not Effect code.
import { describe, expect, it } from "vitest";
import { bundleProblems, type Metafile } from "../build-check.ts";

const PEERS = ["@earendil-works/pi-coding-agent"];

const metafile = (
  inputs: ReadonlyArray<string>,
  imports: ReadonlyArray<string> = [],
): Metafile => ({
  inputs: {
    "src/index.ts": {
      imports: imports.map((path) => ({ path, kind: "import-statement", external: true })),
    },
    ...Object.fromEntries(inputs.map((path) => [path, {}])),
  },
  outputs: { "dist/index.js": {} },
});

describe("the bundle check", () => {
  it("passes Node's own modules, a declared peer and the SDK", () => {
    expect(
      bundleProblems(
        metafile(
          ["../../node_modules/@modelcontextprotocol/client/dist/index.mjs", "src/flow.ts"],
          ["node:fs", "node:child_process", "@earendil-works/pi-coding-agent"],
        ),
        PEERS,
      ),
    ).toEqual([]);
  });

  it.each([
    ["cloudflare:workers", ["cloudflare:workers"]],
    ["@cloudflare/computer", ["../../node_modules/@cloudflare/computer/dist/index.js"]],
    ["workerd", ["../../node_modules/workerd/lib/main.js"]],
    ["alchemy", ["../../node_modules/alchemy/lib/index.js"]],
    ["pi-durable", ["../../node_modules/@earendil-works/pi-durable/dist/index.js"]],
    ["@cloudpid/extensions", ["../../packages/extensions/src/index.ts"]],
  ])("fails a bundle that reaches %s", (name, inputs) => {
    const problems = bundleProblems(metafile(inputs), PEERS);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(name);
  });

  it("fails an external import that is no Node module and no declared peer", () => {
    expect(bundleProblems(metafile([], ["typebox", "left-pad"]), PEERS)).toEqual([
      expect.stringContaining("typebox"),
      expect.stringContaining("left-pad"),
    ]);
  });

  it("fails a forbidden external import", () => {
    expect(bundleProblems(metafile([], ["cloudflare:workers"]), PEERS)).not.toEqual([]);
  });
});
