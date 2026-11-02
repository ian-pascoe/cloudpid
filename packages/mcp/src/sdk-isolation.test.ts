/**
 * The import rule's bundle test (docs/architecture/mcp.md → Packages and objects): the main Worker and `apps/browser`
 * must not bundle any `@modelcontextprotocol/` module, and `@cloudpid/mcp/types` and `@cloudpid/mcp/oauth` must load
 * nothing from the SDK, since the SDK adds about 9-10 MiB of cold heap to every isolate that loads it.
 *
 * The bundler is rolldown, the one alchemy bundles Workers with. The module graph is checked rather than the
 * tree-shaken output: a module that is in the graph is one the isolate may evaluate. A planted import proves each
 * check can fail.
 */
import { resolve } from "node:path";
import { rolldown, type OutputChunk, type Plugin } from "rolldown";
import { describe, expect, it } from "vitest";

const here = (path: string) => resolve(import.meta.dirname, path);

const MAIN_WORKER = here("../../../apps/server/src/worker.ts");
const BROWSER_WORKER = here("../../../apps/browser/src/worker.ts");
const CORE = here("./index.ts");
const TYPES = here("./types.ts");
const OAUTH = here("./oauth.ts");

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

    return [entry, ...planted].map((source) => `import ${JSON.stringify(source)};`).join("\n");
  },
});

/** Every SDK module in the module graph of `entry`, with `planted` specifiers imported beside it. */
const bundledSdkModules = async (entry: string, planted: ReadonlyArray<string> = []) => {
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

    const ids = new Set(
      chunks.flatMap((chunk) => chunk.moduleIds.map((id) => id.replaceAll("\\", "/"))),
    );

    return [...ids].filter((id) => id.includes(SDK_PACKAGES));
  } finally {
    await bundle.close();
  }
};

describe("the SDK stays out of the Workers that must not load it", () => {
  const workers = [
    ["the main Worker", MAIN_WORKER],
    ["apps/browser", BROWSER_WORKER],
  ] as const;

  it.each(workers)("%s bundles no @modelcontextprotocol/ module", async (_name, entry) => {
    expect(await bundledSdkModules(entry)).toEqual([]);
  });

  it.each(workers)("fails when %s imports the core", async (_name, entry) => {
    expect(await bundledSdkModules(entry, ["@cloudpid/mcp"])).not.toEqual([]);
  });

  it.each(workers)("fails when %s imports the SDK itself", async (_name, entry) => {
    expect(await bundledSdkModules(entry, ["@modelcontextprotocol/client"])).not.toEqual([]);
  });

  it.each(workers)("passes when %s imports ./types and ./oauth", async (_name, entry) => {
    const sdkModules = await bundledSdkModules(entry, [TYPES, OAUTH]);

    expect(sdkModules).toEqual([]);
  });
});

describe("@cloudpid/mcp entries", () => {
  it("`.` loads the SDK", async () => {
    expect(await bundledSdkModules(CORE)).not.toEqual([]);
  });

  it("./types loads nothing from the SDK", async () => {
    expect(await bundledSdkModules(TYPES)).toEqual([]);
    expect(await import("./types.ts")).toBeDefined();
  });

  it("./oauth loads nothing from the SDK", async () => {
    expect(await bundledSdkModules(OAUTH)).toEqual([]);
    expect(await import("./oauth.ts")).toBeDefined();
  });
});
