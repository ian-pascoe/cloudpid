/**
 * The import rule's bundle test (docs/architecture/mcp.md → Packages and objects): the main Worker and `apps/browser`
 * must not bundle any `@modelcontextprotocol/` module, and `@cloudpid/mcp/types` and `@cloudpid/mcp/oauth` must load
 * nothing from the SDK, since the SDK adds about 9-10 MiB of cold heap to every isolate that loads it.
 *
 * The bundler is rolldown, the one alchemy bundles Workers with. The module graph is checked rather than the
 * tree-shaken output: a module that is in the graph is one the isolate may evaluate. An SDK import the bundler
 * leaves external or cannot resolve counts too. A planted import proves each check can fail.
 */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off preferEffectArray:off
import { resolve } from "node:path";
import { rolldown, type OutputChunk, type Plugin } from "rolldown";
import { describe, expect, it } from "vitest";

const here = (path: string) => resolve(import.meta.dirname, path);

const MAIN_WORKER = here("../../../apps/server/src/worker.ts");
const BROWSER_WORKER = here("../../../apps/browser/src/worker.ts");
const CORE = here("./index.ts");
const TYPES = here("./types.ts");
const OAUTH = here("./oauth.ts");
const ELICITATION_URL = here("./elicitation-url.ts");

const SDK_PACKAGES = "@modelcontextprotocol/";
const PLANTED_ENTRY = "\0planted-entry";

/** What a planted import resolves from: `packages/mcp`, the one place that depends on the SDK. */
const PLANT_ORIGIN = CORE;

/** `@cloudpid/mcp` is not a dependency of the Workers yet, so it resolves to its entry by path. */
const PLANTED_PATHS = new Map([["@cloudpid/mcp", CORE]]);

/** An entry that imports the real one and then each planted specifier, as a change that adds the import would. */
const plantedEntry = (entry: string, planted: ReadonlyArray<string>): Plugin => ({
  name: "planted-entry",
  resolveId(source, importer) {
    if (source === PLANTED_ENTRY) {
      return source;
    }

    if (importer !== PLANTED_ENTRY || source === entry) {
      return null;
    }

    return PLANTED_PATHS.get(source) ?? this.resolve(source, PLANT_ORIGIN, { skipSelf: true });
  },
  load(id) {
    if (id !== PLANTED_ENTRY) {
      return null;
    }

    // The entry's namespace is used, so a package marked `sideEffects: false` (pi-mcp) is kept for what the entry exports.
    return [
      `import * as entry from ${JSON.stringify(entry)}; globalThis.entry = entry;`,
      ...planted.map((source) => `import ${JSON.stringify(source)};`),
    ].join("\n");
  },
});

/**
 * Every module and import the bundle of `entry` (with `planted` specifiers imported beside it) reaches: a module in its
 * graph, an import it left external (rolldown turns an import it cannot resolve into one, silently: it is in
 * `chunk.imports`, not in `moduleIds`, and the Worker would fail at runtime or load it from `node_modules`) or a
 * dynamic import.
 */
const bundleReferences = async (entry: string, planted: ReadonlyArray<string> = []) => {
  const bundle = await rolldown({
    input: PLANTED_ENTRY,
    platform: "node",
    logLevel: "silent",
    external: [/^cloudflare:/],
    resolve: { conditionNames: ["workerd", "worker", "browser", "import", "module", "default"] },
    plugins: [plantedEntry(entry, planted)],
  });

  try {
    const { output } = await bundle.generate({ format: "esm" });
    const chunks = output.filter((item): item is OutputChunk => item.type === "chunk");

    const ids = new Set([
      ...chunks.flatMap((chunk) => chunk.moduleIds),
      ...chunks.flatMap((chunk) => chunk.imports),
      ...chunks.flatMap((chunk) => chunk.dynamicImports),
    ]);

    return [...ids].map((id) => id.replaceAll("\\", "/"));
  } finally {
    await bundle.close();
  }
};

/** Every way the bundle of `entry` reaches the SDK. */
const sdkReferences = async (entry: string, planted: ReadonlyArray<string> = []) =>
  (await bundleReferences(entry, planted)).filter((id) => id.includes(SDK_PACKAGES));

describe("the SDK stays out of the Workers that must not load it", () => {
  const workers = [
    ["the main Worker", MAIN_WORKER],
    ["apps/browser", BROWSER_WORKER],
  ] as const;

  it.each(workers)("%s bundles no @modelcontextprotocol/ module", async (_name, entry) => {
    expect(await sdkReferences(entry)).toEqual([]);
  });

  it.each(workers)(
    "fails when %s imports an SDK module that does not resolve",
    async (_name, entry) => {
      expect(await sdkReferences(entry, ["@modelcontextprotocol/not-installed"])).not.toEqual([]);
    },
  );

  it.each(workers)("passes when %s imports ./types and ./oauth", async (_name, entry) => {
    const sdkModules = await sdkReferences(entry, [TYPES, OAUTH]);

    expect(sdkModules).toEqual([]);
  });
});

describe("@cloudpid/mcp entries", () => {
  it("`.` loads the SDK", async () => {
    expect(await sdkReferences(CORE)).not.toEqual([]);
  });

  it("./types loads nothing from the SDK", async () => {
    expect(await sdkReferences(TYPES)).toEqual([]);
  });

  // `./elicitation-url` carries the Public Suffix List (`tldts`, about 190 KB minified), which the web never runs since
  // a card's `domain` arrives on the wire: `./types`, which the web imports, must not reach it.
  it("./elicitation-url loads tldts, and ./types does not", async () => {
    expect((await bundleReferences(ELICITATION_URL)).some((id) => id.includes("/tldts"))).toBe(
      true,
    );
    expect((await bundleReferences(TYPES)).filter((id) => id.includes("/tldts"))).toEqual([]);
  });

  it("./oauth loads nothing from the SDK", async () => {
    expect(await sdkReferences(OAUTH)).toEqual([]);
  });

  // pi-mcp's `oauth` entry also exports a callback server over `node:http`, `McpOAuthProvider` and `authorizeMcp`, which
  // cloudpid never uses (docs/architecture/mcp-sign-in.md → Tokens reach the host object, Code): `./oauth` names what it
  // takes, so they stay out of the bundle.
  it("./oauth leaves pi-mcp's callback server, provider and node:http out", async () => {
    const references = await bundleReferences(OAUTH);

    expect(references.filter((id) => id.includes("pi-mcp"))).not.toEqual([]);
    expect(
      references.filter((id) => /pi-mcp\/dist\/oauth\/(callback|provider)\.js$/.test(id)),
    ).toEqual([]);
    expect(references.filter((id) => id === "node:http" || id === "http")).toEqual([]);
  });
});
