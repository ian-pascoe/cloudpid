// The workspace's Vite+ configuration (docs/adr/0055-vite-plus-and-pnpm.md): format, lint, staged-file checks and the
// task runner for every package. `vp lint`, `vp fmt` and `vp check` read only this file's `lint` and `fmt`, from any
// package, so a package's own rules are `lint.overrides` here, never a block in its own config.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/** Directories of other tools and agents, and the reference repositories (`.repos/`), which nothing here formats or lints. */
const ignorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  ".repos/**",
  "tools/oxlint/anti-slop/**",
];

const sdkOnlyInMcp = {
  group: ["@modelcontextprotocol/**"],
  message:
    "Only packages/mcp imports @modelcontextprotocol/*: it loads the SDK, which adds about 9-10 MiB of cold heap to every isolate. Use @cloudpid/mcp/types or @cloudpid/mcp/oauth, or an RPC to McpEngine; tests use the fake servers from @cloudpid/mcp/testing. See docs/architecture/mcp.md → Packages and objects.",
};

/**
 * What `packages/pi-cloudpid` must never import. The extension runs on the owner's laptop and loads the SDK's client
 * (docs/architecture/mcp-endpoint.md → The `/cloudpid` command), so the SDK rule of the Workers is replaced by what the
 * extension must never reach: Workers code, and every other `@modelcontextprotocol/*` package.
 */
const piCloudpidForbidden = [
  {
    group: ["cloudflare:*", "@cloudflare/**"],
    message:
      "pi-cloudpid runs on the owner's machine and must not import Workers code (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
  {
    group: ["alchemy", "alchemy/**", "@alchemy.run/**"],
    message:
      "pi-cloudpid must not import alchemy (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
  {
    group: ["@earendil-works/pi-durable", "@earendil-works/pi-durable/**"],
    message:
      "pi-cloudpid must not import pi-durable: it is the Workers side of cloudpid (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
  {
    group: ["@cloudpid/extensions", "@cloudpid/extensions/**"],
    message:
      "pi-cloudpid must not import @cloudpid/extensions (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
  {
    group: ["workerd", "workerd/**"],
    message:
      "pi-cloudpid must not import workerd (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
  {
    group: ["@modelcontextprotocol/**", "!@modelcontextprotocol/client"],
    message:
      "pi-cloudpid loads the SDK's client and nothing else of it: not the server, core, an extension or a transport (docs/architecture/mcp-endpoint.md → The `/cloudpid` command).",
  },
];

export default defineConfig({
  // `vp staged`, the pre-commit hook (`.vite-hooks/pre-commit`).
  staged: {
    "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}": "vp lint --fix --no-error-on-unmatched-pattern",
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      {
        name: "anti-slop",
        specifier: fileURLToPath(new URL("./tools/oxlint/anti-slop/index.ts", import.meta.url)),
      },
      {
        name: "anti-slop-effect",
        specifier: fileURLToPath(
          new URL("./tools/oxlint/anti-slop/effect/index.ts", import.meta.url),
        ),
      },
    ],
    plugins: ["typescript", "unicorn", "oxc"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
    },
    env: {
      builtin: true,
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "oxc/no-accumulating-spread": "error",
      "no-restricted-imports": ["error", { patterns: [sdkOnlyInMcp] }],
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
    overrides: [
      {
        // The one package that imports the SDK (docs/architecture/mcp.md → Packages and objects).
        files: ["packages/mcp/**"],
        rules: { "no-restricted-imports": "off" },
      },
      {
        // The web app may import types, and only types, from `@modelcontextprotocol/ext-apps` (`import type`), for its
        // own App bridge: the first pattern lets only type imports of `ext-apps` and its subpaths through. The second
        // restricts every other `@modelcontextprotocol/*` package, the SDK's `client`, `core`, `server`, `ext-tasks` and
        // any it adds later. The `ext-apps` rule is a `regex` because oxlint stops reporting value imports of a group's
        // subpaths once another group in the rule negates them. docs/architecture/mcp.md → Packages and objects.
        files: ["apps/web/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex: "^@modelcontextprotocol/ext-apps(/|$)",
                  allowTypeImports: true,
                  message:
                    "The web app imports only types from @modelcontextprotocol/ext-apps (`import type`), for its own App bridge. See docs/architecture/mcp.md → Packages and objects.",
                },
                {
                  group: [
                    "@modelcontextprotocol/**",
                    "!@modelcontextprotocol/ext-apps",
                    "!@modelcontextprotocol/ext-apps/**",
                  ],
                  message:
                    "Only packages/mcp imports the MCP SDK: it adds about 9-10 MiB of cold heap to every isolate that loads it. The web app imports @cloudpid/mcp/types. See docs/architecture/mcp.md → Packages and objects.",
                },
              ],
            },
          ],
        },
      },
      {
        // The extension may import only types from `@cloudpid/protocol`, whose Schemas would load `effect` and the
        // Registry.
        files: ["packages/pi-cloudpid/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                ...piCloudpidForbidden,
                {
                  regex: "^@cloudpid/protocol(/|$)",
                  allowTypeImports: true,
                  message:
                    "pi-cloudpid imports only types from @cloudpid/protocol (`import type`): its Schemas would load effect and the Registry on the owner's machine, so the constants are copied (src/constants.ts, checked by constants.test.ts).",
                },
              ],
            },
          ],
        },
      },
      {
        // Tests and the stub endpoint build on cloudpid's own protocol values (`apiOk`, the tool table) and check the
        // copied constants against them; the extension never loads them.
        files: ["packages/pi-cloudpid/**/*.test.ts", "packages/pi-cloudpid/**/*.fixture.ts"],
        rules: {
          "no-restricted-imports": ["error", { patterns: piCloudpidForbidden }],
        },
      },
      {
        files: ["packages/protocol/src/harness-tools/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**",
                    "!effect",
                    "!effect/**",
                    "!@cloudpid/config",
                    "!@cloudpid/config/**",
                    "!./*",
                  ],
                  message:
                    "src/harness-tools/ imports only effect, @cloudpid/config and files in its own directory: McpWorker imports it, and the rest of this package depends on pi-durable and chord, which would join McpWorker's bundle. See docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions.",
                },
              ],
            },
          ],
        },
      },
    ],
  },
});
