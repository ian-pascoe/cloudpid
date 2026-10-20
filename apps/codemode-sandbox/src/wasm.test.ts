// @effect-diagnostics globalDate:off asyncFunction:off nodeBuiltinImport:off preferEffectArray:off
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolldown } from "rolldown";
import { expect, it } from "vitest";
import { compiledWasm } from "./wasm.ts";

/** The smallest valid WebAssembly module: the magic number and version 1. */
const EMPTY_MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

it("leaves a .wasm import for the platform to compile and emits the file next to the entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compiled-wasm-"));

  await writeFile(join(directory, "engine.wasm"), EMPTY_MODULE);
  await writeFile(
    join(directory, "entry.js"),
    'import engine from "./engine.wasm";\nexport default { fetch: () => new Response(String(engine)) };\n',
  );

  const bundle = await rolldown({ input: join(directory, "entry.js"), plugins: [compiledWasm()] });
  const { output } = await bundle.generate({ format: "esm" });

  await bundle.close();

  const chunk = output.find((file) => file.type === "chunk");
  const asset = output.find((file) => file.type === "asset");

  // A relative import of a file whose name carries a hash of its bytes.
  expect(chunk?.type === "chunk" ? chunk.code : "").toMatch(/from "\.\/engine-[0-9a-f]{8}\.wasm"/);
  expect(asset?.fileName).toMatch(/^engine-[0-9a-f]{8}\.wasm$/);
  expect(asset?.type === "asset" ? asset.source : undefined).toEqual(EMPTY_MODULE);
});
