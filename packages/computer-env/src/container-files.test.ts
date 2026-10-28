// The Container's file operations run their real scripts here, in bash on this machine, which stands in for the
// Container; the "Workspace DO" side of the stage is the same disk.
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off preferEffectArray:off
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContainerAccess, ContainerFiles } from "./container-files.ts";
import { HostFailure } from "./failure.ts";

const hasRg = spawnSync("rg", ["--version"]).status === 0;

let root: string;
let running: boolean;

/** Whether each script run was said to write. */
let writes: boolean[];

const access: ContainerAccess = {
  patterns: async () => ["**/node_modules"],
  running: () => running,
  run: async (script, env, options) => {
    writes.push(options?.writes === true);

    const ran = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  },
};

const files = () =>
  new ContainerFiles(
    access,
    {
      read: async (path) => new Uint8Array(readFileSync(path)),
      write: async (path, bytes) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, bytes);
      },
      remove: async (path) => rmSync(path, { force: true }),
    },
    join(root, ".stage"),
  );

/** The failure `operation` ends with: its code and message. */
const failure = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (cause) {
    if (cause instanceof HostFailure) return { code: cause.wire.code, message: cause.wire.message };

    throw cause;
  }

  throw new Error("it did not fail");
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "container-files-"));
  running = true;
  writes = [];
  mkdirSync(join(root, "pkg/node_modules/effect"), { recursive: true });
  writeFileSync(join(root, "pkg/node_modules/effect/package.json"), '{"name":"effect"}\n');
  writeFileSync(join(root, "pkg/index.ts"), "export const a = 1;\nexport const b = 2;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the Container's file operations", () => {
  it("say a path outside the Workspace, or one a launch's pattern names, is the Container's", async () => {
    expect(
      await files().classify(["/tmp/x", "/workspace/repo/node_modules/x", "/workspace/repo/src"]),
    ).toEqual([true, true, false]);
  });

  it("give a file's or directory's metadata, and name the Container when there is nothing there", async () => {
    const info = await files().info(join(root, "pkg/index.ts"), true);

    expect(info).toMatchObject({ name: "index.ts", kind: "file", size: 40 });
    expect(Math.abs(info.mtimeMs - statSync(join(root, "pkg/index.ts")).mtimeMs)).toBeLessThan(2);
    expect((await files().info(join(root, "pkg"), true)).kind).toBe("directory");
    expect(await failure(files().info(join(root, "missing"), true))).toEqual({
      code: "not_found",
      message: "No such file or directory (on the Container)",
    });
  });

  it("read a file's bytes through the stage, and leave no stage behind", async () => {
    const read = await files().readFile(join(root, "pkg/node_modules/effect/package.json"));

    expect(text(read)).toBe('{"name":"effect"}\n');
    expect(spawnSync("ls", ["-A", join(root, ".stage")], { encoding: "utf8" }).stdout).toBe("");
    expect((await failure(files().readFile(join(root, "pkg")))).code).toBe("is_directory");
  });

  it("write a new file, making its parents, and append to it", async () => {
    const container = files();
    const path = join(root, "made/deep/out.txt");

    await container.writeFile(path, new TextEncoder().encode("one\n"), false);
    await container.writeFile(path, new TextEncoder().encode("two\n"), true);

    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  it("say a write changes the Container's disk, and a read does not", async () => {
    const container = files();
    const path = join(root, "pkg/node_modules/new.txt");

    await container.writeFile(path, new TextEncoder().encode("one"), false);

    expect(writes).toEqual([true]);

    await container.readFile(path);
    await container.info(path, true);

    expect(writes).toEqual([true, false, false]);
  });

  it("replace a file read before, keeping its mode", async () => {
    const container = files();
    const path = join(root, "run.sh");

    writeFileSync(path, "echo old\n");
    chmodSync(path, 0o755);

    await container.readFile(path);
    await container.writeFile(path, new TextEncoder().encode("echo new\n"), false);

    expect(readFileSync(path, "utf8")).toBe("echo new\n");
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it("refuse to replace a file that changed on the Container since it was read", async () => {
    const container = files();
    const path = join(root, "pkg/index.ts");

    await container.readFile(path);
    writeFileSync(path, "changed meanwhile\n");

    expect(
      await failure(container.writeFile(path, new TextEncoder().encode("edited\n"), false)),
    ).toEqual({
      code: "invalid",
      message:
        "The file changed on the Container since it was read: read it again (on the Container)",
    });
    expect(readFileSync(path, "utf8")).toBe("changed meanwhile\n");
  });

  it("open a reader on a copy of the file, as it was, with the original's metadata", async () => {
    const path = join(root, "pkg/index.ts");

    const { opened, info } = await files().openReader(path, false, async (stage) =>
      readFileSync(stage, "utf8"),
    );

    expect(opened).toBe("export const a = 1;\nexport const b = 2;\n");
    expect(info).toMatchObject({ path, kind: "file", size: 40 });
  });

  it("list a directory, and a synced one's Container-only entries only while the Container runs", async () => {
    const container = files();

    expect(await container.readdir(join(root, "pkg/node_modules"))).toEqual([
      { name: "effect", isDirectory: true, isSymbolicLink: false },
    ]);

    // The temp directory stands outside the Workspace, so every entry there counts as the Container's.
    expect(await container.containerOnlyEntries(join(root, "pkg"))).toEqual(
      expect.arrayContaining([
        { name: "node_modules", isDirectory: true, isSymbolicLink: false, containerOnly: true },
      ]),
    );

    running = false;
    expect(await container.containerOnlyEntries(join(root, "pkg"))).toEqual([]);
  });

  it("find the paths a glob matches below a directory, leaving out excluded directories, up to the limit", async () => {
    mkdirSync(join(root, "pkg/src/deep"), { recursive: true });
    writeFileSync(join(root, "pkg/src/deep/a.ts"), "");
    writeFileSync(join(root, "pkg/src/b.md"), "");

    const found = await files().find(join(root, "pkg"), "**/*.ts", {
      limit: 10,
      exclude: ["**/node_modules/**"],
    });

    expect(found.map((entry) => entry.path).sort()).toEqual([
      join(root, "pkg/index.ts"),
      join(root, "pkg/src/deep/a.ts"),
    ]);
    expect(
      await files().find(join(root, "pkg"), "**/*.ts", {
        limit: 1,
        exclude: ["**/node_modules/**"],
      }),
    ).toHaveLength(1);
  });

  it("find below a directory whose name has glob characters, and in a directory with spaces", async () => {
    mkdirSync(join(root, "app/[slug]/my dir"), { recursive: true });
    writeFileSync(join(root, "app/[slug]/my dir/page.tsx"), "");

    expect(
      await files().find(join(root, "app/[slug]"), "**/*.tsx", {
        limit: 10,
        exclude: ["**/node_modules/**", "**/my dir/**"],
      }),
    ).toEqual([]);
    expect(
      await files().find(join(root, "app/[slug]"), "**/*.tsx", { limit: 10, exclude: [] }),
    ).toEqual([{ path: join(root, "app/[slug]/my dir/page.tsx"), type: "file" }]);
  });

  it.skipIf(!hasRg)(
    "grep inside an excluded directory, the excludes counting from the searched directory",
    async () => {
      mkdirSync(join(root, "pkg/node_modules/effect/node_modules/inner"), { recursive: true });
      writeFileSync(join(root, "pkg/node_modules/effect/node_modules/inner/x.json"), '"effect"');

      const directory = join(root, "pkg/node_modules/effect");

      expect(
        await files().grep("effect", directory, {
          ignoreCase: false,
          regex: false,
          context: 0,
          limit: 10,
          include: undefined,
          exclude: ["**/node_modules/**"],
        }),
      ).toEqual([{ path: join(directory, "package.json"), line: 1, text: '{"name":"effect"}' }]);
    },
  );

  it.skipIf(!hasRg)("grep lines with their context, as a literal or ignoring case", async () => {
    const path = join(root, "pkg/index.ts");

    expect(
      await files().grep("CONST B", path, {
        ignoreCase: true,
        regex: true,
        context: 1,
        limit: 10,
        include: undefined,
        exclude: [],
      }),
    ).toEqual([
      {
        path,
        line: 2,
        text: "export const b = 2;",
        context: [
          { line: 1, text: "export const a = 1;", isMatch: false },
          { line: 2, text: "export const b = 2;", isMatch: true },
        ],
      },
    ]);

    expect(
      await files().grep("a = 1.", join(root, "pkg"), {
        ignoreCase: false,
        regex: false,
        context: 0,
        limit: 10,
        include: undefined,
        exclude: [],
      }),
    ).toEqual([]);
  });
});
