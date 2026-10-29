// `write`'s Call diff, and the diffs of a `codemode` script's nested calls, through a real Harness with a scripted model,
// real files in a temporary directory and the real QuickJS sandbox. pi-durable's Harness is Promise-based, so this file is
// too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalRandom:off nodeBuiltinImport:off -- real files in a temporary directory, as pi-durable's Node environment reads them.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadQuickJSWasm, InlineCodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RecordedDiff } from "@cloudpid/protocol/call-diff";
import { err, FileError, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MAX_DIFF_INPUT_BYTES } from "./call-diff.ts";
import { codingToolsWith } from "./coding-tools.ts";

const context = BACKGROUND_CONTEXT;

const callOf = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

/** The Node environment, but it cannot read the files `unreadable` names, as one whose reads fail. */
class UnreadableEnv extends NodeExecutionEnv {
  readonly #unreadable: readonly string[];

  constructor(cwd: string, unreadable: readonly string[]) {
    super({ cwd });
    this.#unreadable = unreadable;
  }

  override async readBinaryFile(
    path: string,
    ctx: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    return this.#unreadable.some((name) => path.endsWith(name))
      ? err(new FileError("permission_denied", "Not allowed", path))
      : super.readBinaryFile(path, ctx);
  }
}

const ScriptDetails = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({ id: Schema.Finite, name: Schema.String, status: Schema.String }),
  ),
  diffs: Schema.optional(Schema.Record(Schema.String, RecordedDiff)),
});

const decodeScriptDetails = Schema.decodeUnknownOption(ScriptDetails);

/** The calls and diffs a `codemode` result lists in its `details`. */
const scriptOf = (details: ToolResultMessage["details"]) =>
  Option.getOrThrow(decodeScriptDetails(details));

type Recorded = {
  readonly name: string;
  readonly isError: boolean;
  readonly text: string;
  readonly details: ToolResultMessage["details"];
  /** What the result weighs once stored: its JSON. */
  readonly bytes: number;
};

/** A Workspace in a temporary directory with `files`, a Harness over it, and the model calling one tool. */
const open = async (
  files: Readonly<Record<string, string | Uint8Array>> = {},
  options: { readonly unreadable?: readonly string[] } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "call-diff-"));

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }

  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();

  models.setProvider(faux.provider);
  registry.install(codingToolsWith({}));
  registry.install(
    createCodemodeExtension({
      sandbox: new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }),
      models: false,
    }),
  );

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new UnreadableEnv(root, options.unreadable ?? []),
    },
    context,
  );

  const root$ = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** The model calls `name` with `args`; the result it got. */
  const call = async (name: string, args: ToolCall["arguments"]): Promise<Recorded> => {
    faux.setResponses([() => callOf(name, args), () => fauxAssistantMessage("done")]);
    await (await root$.submit({ type: "input", content: "go" }, context)).wait(context);
    await harness.waitForIdle(context);

    const page = await (await harness.conversation(ROOT_CONVERSATION_ID, context))!.entries(
      { order: "descending" },
      50,
      undefined,
      context,
    );

    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult" && message.toolName === name) {
          return {
            name,
            isError: message.isError,
            text: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
            details: message.details,
            bytes: JSON.stringify(message).length,
          };
        }
      }
    }

    throw new Error(`No result of ${name}`);
  };

  return { call, file: (path: string) => readFile(join(root, path), "utf8") };
};

describe("write's Call diff", () => {
  it("records the patch of a new file, and that it was created", async () => {
    const { call, file } = await open();

    const result = await call("write", { path: "notes/a.txt", content: "one\ntwo\n" });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("Successfully wrote to notes/a.txt");
    expect(result.details).toEqual({
      path: "notes/a.txt",
      created: true,
      patch: "--- notes/a.txt\n+++ notes/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    });
    expect(await file("notes/a.txt")).toBe("one\ntwo\n");
  });

  it("records the patch of an overwrite, with no `created`", async () => {
    const { call, file } = await open({ "a.txt": "one\ntwo\nthree\n" });

    const result = await call("write", { path: "a.txt", content: "one\n2\nthree\n" });

    expect(result.details).toEqual({
      path: "a.txt",
      patch: "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n",
    });
    expect(await file("a.txt")).toBe("one\n2\nthree\n");
  });

  it("records the headers alone for a write that left the file as it was", async () => {
    const { call } = await open({ "a.txt": "same\n" });

    expect((await call("write", { path: "a.txt", content: "same\n" })).details).toEqual({
      path: "a.txt",
      patch: "--- a.txt\n+++ a.txt\n",
    });
  });

  it("records only `binary` for an old binary file, and still writes", async () => {
    const { call, file } = await open({ "a.bin": new Uint8Array([1, 2, 0, 3]) });

    const result = await call("write", { path: "a.bin", content: "text now\n" });

    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ path: "a.bin", binary: true });
    expect(await file("a.bin")).toBe("text now\n");
  });

  it("records only `binary` for an old file it cannot read, and still writes", async () => {
    const { call, file } = await open({ "locked.txt": "old\n" }, { unreadable: ["locked.txt"] });

    const result = await call("write", { path: "locked.txt", content: "new\n" });

    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ path: "locked.txt", binary: true });
    expect(await file("locked.txt")).toBe("new\n");
  });

  it("records only `tooLarge` when the old and new text pass 1 MiB together, and still writes", async () => {
    const { call, file } = await open({ "big.txt": "a\n".repeat(MAX_DIFF_INPUT_BYTES / 4) });

    const result = await call("write", {
      path: "big.txt",
      content: "b\n".repeat(MAX_DIFF_INPUT_BYTES / 4 + 1),
    });

    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ path: "big.txt", tooLarge: true });
    expect((await file("big.txt")).length).toBe(MAX_DIFF_INPUT_BYTES / 2 + 2);
  });

  it("keeps the stored result of a write of 1 MiB well under the 8 MiB row", async () => {
    const { call } = await open();

    const result = await call("write", {
      path: "big.txt",
      content: "x".repeat(MAX_DIFF_INPUT_BYTES),
    });

    expect(result.details).toEqual({ path: "big.txt", created: true, tooLarge: true });
    expect(result.bytes).toBeLessThan(10_000);
  });

  it("keeps the stored result of a write whose patch is just under 512 KiB well within the 8 MiB row", async () => {
    const { call } = await open();
    // Quotes are escaped when stored, so the patch is the longest a result holds: about 488 KiB as stored.
    const content = `${'"'.repeat(60)}\n`.repeat(4_000);

    const result = await call("write", { path: "q.txt", content });

    expect(result.details).toMatchObject({ path: "q.txt", created: true });
    expect(JSON.stringify(result.details).length).toBeGreaterThan(450 * 1024);
    expect(result.bytes).toBeGreaterThan(450 * 1024);
    expect(result.bytes).toBeLessThan(600 * 1024);
  });

  it("fails like pi-durable's write when the write fails, with no details", async () => {
    const { call } = await open({ "dir/inner.txt": "x" });

    const result = await call("write", { path: "dir", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.details).toBeUndefined();
  });
});

describe("the calls a codemode script makes", () => {
  it("keys the diffs of its finished writes and edits by their call, and leaves out one that failed", async () => {
    const { call } = await open({ "old.txt": "alpha\nbeta\n", "dir/inner.txt": "x" });

    const result = await call("codemode", {
      code: [
        `await tools.write({ path: "new.txt", content: "one\\n" });`,
        `try { await tools.write({ path: "dir", content: "x" }); } catch (error) { text("failed"); }`,
        `await tools.edit({ path: "old.txt", edits: [{ oldText: "beta", newText: "gamma" }] });`,
        `await tools.read({ path: "old.txt" });`,
        `await tools.write({ path: "again.txt", content: "two\\n" });`,
      ].join("\n"),
    });

    expect(result.isError).toBe(false);

    const script = scriptOf(result.details);

    expect(script.calls.map((row) => [row.id, row.name, row.status])).toEqual([
      [1, "write", "ok"],
      [2, "write", "error"],
      [3, "edit", "ok"],
      [4, "read", "ok"],
      [5, "write", "ok"],
    ]);

    expect(script.diffs).toEqual({
      1: {
        path: "new.txt",
        created: true,
        patch: "--- new.txt\n+++ new.txt\n@@ -0,0 +1,1 @@\n+one\n",
      },
      // An `edit` records no path of its own: its patch's header names the file.
      3: {
        path: "old.txt",
        patch: "--- old.txt\n+++ old.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n",
      },
      5: {
        path: "again.txt",
        created: true,
        patch: "--- again.txt\n+++ again.txt\n@@ -0,0 +1,1 @@\n+two\n",
      },
    });
  });

  it("keeps the diffs of the calls that finished when the script then fails", async () => {
    const { call } = await open();

    const result = await call("codemode", {
      code: [
        `await tools.write({ path: "a.txt", content: "a\\n" });`,
        `await tools.write({ path: "b.txt", content: "b\\n" });`,
        `throw new Error("stopped partway");`,
      ].join("\n"),
    });

    expect(result.isError).toBe(true);
    expect(Object.keys(scriptOf(result.details).diffs ?? {})).toEqual(["1", "2"]);
  });

  it("holds the patches of one script to a budget, past which a write is too large to show", async () => {
    const { call } = await open();
    // Each patch is about 100 KiB: two fit the 256 KiB budget, the third does not.
    const body = `("x".repeat(99) + "\\n")`;

    const result = await call("codemode", {
      code: [1, 2, 3, 4]
        .map((n) => `await tools.write({ path: "f${n}.txt", content: ${body}.repeat(1000) });`)
        .join("\n"),
    });

    const diffs = scriptOf(result.details).diffs ?? {};

    expect(Object.values(diffs).map((diff) => diff.patch !== undefined)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(diffs["3"]).toEqual({ path: "f3.txt", created: true, tooLarge: true });
    expect(result.bytes).toBeLessThan(1_000_000);
  });

  it("adds nothing to a script that changed no file", async () => {
    const { call } = await open({ "a.txt": "a\n" });

    const result = await call("codemode", { code: `await tools.read({ path: "a.txt" });` });

    expect(scriptOf(result.details).diffs).toBeUndefined();
  });
});
