// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Plugin } from "rolldown";

/**
 * A rolldown plugin that makes `import engine from "./engine.wasm"` what Workers need: a `WebAssembly.Module`
 * compiled at upload. Workers cannot compile WebAssembly from bytes at runtime, and the file must be its own module of
 * the script. Wrangler does this with its `CompiledWasm` rule; alchemy bundles with rolldown, which has no such rule.
 * The import stays in the bundle as a relative import, and the file is emitted beside the entry under a name that
 * carries a hash of its bytes, which alchemy uploads as an additional module of type `application/wasm`.
 */
export const compiledWasm = (): Plugin => ({
  name: "cloudpid:compiled-wasm",
  resolveId: {
    filter: { id: /\.wasm$/ },
    async handler(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });

      if (resolved === null || resolved.external !== false) return null;

      const bytes = await this.fs.readFile(resolved.id);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      const fileName = `${basename(resolved.id, ".wasm")}-${hash}.wasm`;

      this.emitFile({ type: "asset", fileName, source: bytes });

      return { id: `./${fileName}`, external: "relative" };
    },
  },
});
