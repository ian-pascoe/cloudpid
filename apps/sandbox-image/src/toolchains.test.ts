// The Container's Toolchain contract with the Workspace DO (docs/spec.md → Container and Toolchains, ADR-0004): which
// paths stay container-local, what a command's environment carries, and what the bootstrap does on Container start.
// The bootstrap runs for real, under bash, against a fake `mise` that records what it is asked.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off globalDate:off
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { variableNameProblem } from "@cloudpid/config";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import {
  BASE_MISE_LOCK,
  BASE_MISE_TOML,
  BOOTSTRAP_CHANGED,
  bootstrapScript,
  ENVIRONMENT_SETUP_RECORD,
  environmentSetupScript,
  environmentStartScriptRun,
  githubTokenEnv,
  pendingSetupScripts,
  repoSetupScriptOf,
  ROOT_MISE_TOML,
  SETUP_SCRIPT,
  setupRecordName,
  setupScriptRun,
  setupScriptRunIfDue,
  scriptTimedOut,
  setupRecord,
  START_SCRIPT,
  startScriptDirectories,
  startScriptRun,
  PNPM_GLOBAL_CONFIG,
  PNPM_STORE_DIRECTORY_NAME,
  TOOLCHAIN_IGNORE,
  TURBO_CACHE_DIR,
  toolchainEnv,
} from "@cloudpid/sandbox-image/toolchains";

const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");

describe("the ignore list", () => {
  it("keeps dependency directories, build output, and caches off the synced Workspace", () => {
    expect(TOOLCHAIN_IGNORE).toEqual(
      expect.arrayContaining(["**/node_modules", "**/.venv", "/target", "/*/target", "**/.cache"]),
    );
  });

  it("keeps pnpm's content-addressed store off the synced Workspace, wherever pnpm puts it", () => {
    // pnpm puts the store at the root of the project's filesystem when the home directory is on another one: on the
    // Container that is `/workspace/.pnpm-store`.
    expect(TOOLCHAIN_IGNORE).toContain("**/.pnpm-store");
  });

  it("keeps more build caches that regenerate off the synced Workspace", () => {
    expect(TOOLCHAIN_IGNORE).toEqual(
      expect.arrayContaining([
        "**/.wrangler",
        "**/.astro",
        "**/.angular",
        "**/.expo",
        "**/.nx",
        "**/.docusaurus",
        "**/.nyc_output",
        "**/.hypothesis",
        "**/.dart_tool",
        "**/.zig-cache",
        "**/.stack-work",
      ]),
    );
  });

  it("keeps build tools' caches and environments off the synced Workspace, by names no source directory has", () => {
    expect(TOOLCHAIN_IGNORE).toEqual(
      expect.arrayContaining([
        "**/.turbo",
        "**/.next",
        "**/.nuxt",
        "**/.svelte-kit",
        "**/.parcel-cache",
        "**/.terraform",
        "**/.gradle",
        "**/.tox",
        "**/.nox",
        "**/.direnv",
      ]),
    );
  });

  it("does not make a directory some repos commit local to the Container", () => {
    // `.alchemy` can hold real deploy state.
    for (const name of [
      "dist",
      "build",
      "coverage",
      "vendor",
      "venv",
      ".yarn",
      "_build",
      ".output",
      "deps",
      ".alchemy",
    ]) {
      expect(TOOLCHAIN_IGNORE.filter((pattern) => pattern.split("/").includes(name))).toEqual([]);
    }
  });

  it("does not make a source directory called target local to the Container", () => {
    expect(TOOLCHAIN_IGNORE).not.toContain("**/target");
  });

  it("leaves mise to the Container's own disk: its data and temp files are on one filesystem, off the ignore boundary", () => {
    const env = toolchainEnv();

    // None of these is set, so mise and every tool use their defaults, under /root and /tmp.
    expect(env).not.toHaveProperty("MISE_DATA_DIR");
    expect(env).not.toHaveProperty("MISE_CACHE_DIR");
    expect(env).not.toHaveProperty("TMPDIR");
    expect(TOOLCHAIN_IGNORE.filter((pattern) => pattern.includes(".mise"))).toEqual([]);
  });

  it("is where the image's PATH looks for mise's shims: mise's default data directory", () => {
    // computerd gives a command PATH from the image's environment but not the rest of it.
    const path = /^\s*PATH=(\S+)/m.exec(dockerfile)?.[1];

    expect(path?.split(":")[0]).toBe("/root/.local/share/mise/shims");
  });
});

/** The `[tools]` of a mise.toml, as a map from tool to version. */
const toolsOf = (toml: string): Map<string, string> =>
  new Map(
    [...toml.slice(toml.indexOf("[tools]")).matchAll(/^"?([^"=\s]+)"? = "([^"]+)"$/gm)].map(
      (match) => [match[1] ?? "", match[2] ?? ""] as const,
    ),
  );

describe("the image's preinstalled Toolchains", () => {
  // The image installs the tools of its copy of the base mise.toml (`image/mise.toml`) into mise's system directory.
  const image = readFileSync(join(sandboxImageContext, "mise.toml"), "utf8");

  it("are the common ones: Node, pnpm, Python and uv, besides git and gh", () => {
    expect([...toolsOf(image).keys()].toSorted()).toEqual(
      ["conda:git", "gh", "node", "pnpm", "python", "uv"].toSorted(),
    );
  });

  it("are what the base mise.toml asks for, version for version, so a new Workspace downloads none", () => {
    // Equal but for the comment at the top, which says what each copy is for.
    const body = (toml: string) => toml.slice(toml.indexOf("[settings]"));

    expect(body(image)).toBe(body(BASE_MISE_TOML));
    expect(dockerfile).toContain(`COPY mise.toml ${dirname(BASE_MISE_LOCK)}/mise.toml\n`);
    expect(dockerfile).toContain(`MISE_GLOBAL_CONFIG_FILE=${dirname(BASE_MISE_LOCK)}/mise.toml `);
    expect(dockerfile).toMatch(/&& mise install --system \\\n/);
  });

  it("are pinned to exact versions, since mise locks a prefix to the newest release, which the image may not have", () => {
    for (const version of toolsOf(image).values()) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("come with the base mise.toml's lockfile, made where the bootstrap copies it from", () => {
    expect(BASE_MISE_LOCK).toBe("/usr/local/share/cloudpid/mise.lock");
    expect(dockerfile).toMatch(/&& mise lock --global --platform linux-x64 \\\n/);
  });

  it("are in mise's system directory, whose shims come after the Workspace's own on PATH", () => {
    const path = /^\s*PATH=(\S+)/m.exec(dockerfile)?.[1]?.split(":") ?? [];

    expect(path.slice(0, 2)).toEqual([
      "/root/.local/share/mise/shims",
      "/usr/local/share/mise/shims",
    ]);
    expect(dockerfile).toMatch(/&& mise reshim --system/);
  });
});

describe("a command's environment", () => {
  it("carries the GitHub token as GH_TOKEN and GITHUB_TOKEN", () => {
    const env = githubTokenEnv("ghs_secret");

    expect(env.GH_TOKEN).toBe("ghs_secret");
    expect(env.GITHUB_TOKEN).toBe("ghs_secret");
  });

  it("carries no token variable when there is none, so a blank one cannot shadow a user's", () => {
    expect(githubTokenEnv("")).toEqual({});
    expect(githubTokenEnv(undefined)).toEqual({});
    expect(toolchainEnv()).not.toHaveProperty("GH_TOKEN");
  });

  it("never lets git ask a question nobody can answer", () => {
    expect(toolchainEnv().GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("keeps Turborepo's cache on the Container's disk, under /root/.cache, off the mount", () => {
    expect(toolchainEnv().TURBO_CACHE_DIR).toBe("/root/.cache/turbo");
    expect(TURBO_CACHE_DIR.startsWith("/root/.cache/")).toBe(true);
  });

  it("sets nothing that would override a repo's own pnpm settings", () => {
    // An environment variable (`pnpm_config_*`) wins over a repo's pnpm-workspace.yaml: the Container's pnpm settings
    // are in pnpm's global config.yaml, which the repo wins over.
    expect(JSON.stringify(toolchainEnv())).not.toMatch(/pnpm/i);
  });

  it("sets only names an Environment's variable may not have, so none overrides it", () => {
    // @cloudpid/config cannot import this package, so its list of reserved names is a copy.
    for (const name of Object.keys({ ...toolchainEnv(), ...githubTokenEnv("x") })) {
      expect(variableNameProblem(name), name).toContain("reserved");
    }
  });
});

/** A throwaway Workspace root and HOME, and a `mise` on PATH that logs its calls and the directory they ran in. */
const sandbox = (options: { readonly miseExit?: number; readonly installs?: string } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const log = join(base, "mise.log");

  for (const directory of [root, home, bin]) mkdirSync(directory, { recursive: true });

  writeFileSync(
    join(bin, "mise"),
    [
      "#!/bin/sh",
      `echo "$PWD: mise $*" >> ${log}`,
      // `installs` is a Toolchain `mise install` puts in mise's data directory, as `<tool>/<version>`.
      options.installs === undefined
        ? ""
        : `[ "$1" = install ] && mkdir -p "$HOME/.local/share/mise/installs/${options.installs}"`,
      `exit ${options.miseExit ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "mise"), 0o755);

  // No image lockfile unless a test makes one there.
  const imageLock = join(base, "image.mise.lock");

  // Where the bootstrap records the root mise.toml it wrote: on the Container's disk, outside the Workspace.
  const state = join(base, "toolchains-state");

  const run = (
    env: Record<string, string> = {},
    readOnly: readonly string[] = [],
    toolchains: string = "",
  ) =>
    spawnSync("bash", ["-c", bootstrapScript(root, readOnly, imageLock, { toolchains, state })], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: home,
        ...env,
      },
    });

  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  return { base, bin, root, home, imageLock, state, run, calls };
};

const LOCK = "mise lock --global --platform linux-x64";

describe("the bootstrap", () => {
  it("locks the root's Toolchains, then installs them with mise", () => {
    const { root, run, calls } = sandbox();

    writeFileSync(join(root, "mise.toml"), "[tools]\n");

    expect(run().status).toBe(0);
    expect(calls()).toEqual([`${root}: ${LOCK}`, `${root}: mise install`]);
  });

  it("does not lock again while the lockfile is newer than the config", () => {
    const { root, run, calls } = sandbox();

    writeFileSync(join(root, "mise.toml"), "[tools]\n");
    writeFileSync(join(root, "mise.lock"), "");
    utimesSync(join(root, "mise.toml"), 1000, 1000);

    run();

    expect(calls()).toEqual([`${root}: mise install`]);
  });

  it("locks again once the config is newer, as after `mise use`", () => {
    const { root, run, calls } = sandbox();

    writeFileSync(join(root, "mise.toml"), "[tools]\n");
    writeFileSync(join(root, "mise.lock"), "");
    utimesSync(join(root, "mise.lock"), 1000, 1000);

    run();

    expect(calls()).toEqual([`${root}: ${LOCK}`, `${root}: mise install`]);
  });

  it("installs the Toolchains of each repo directory that declares its own", () => {
    const { root, run, calls } = sandbox();

    writeFileSync(join(root, "mise.toml"), "[tools]\n");
    writeFileSync(join(root, "mise.lock"), "");
    utimesSync(join(root, "mise.toml"), 1000, 1000);
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "mise.toml"), "[tools]\n");
    mkdirSync(join(root, "plain"));

    run();

    expect(calls()).toEqual([`${root}: mise install`, `${root}/app: mise install`]);
  });

  it.each([
    [".config/mise.toml"],
    [".config/mise/config.toml"],
    [".mise/config.toml"],
    ["mise.local.toml"],
    [".tool-versions"],
  ])("takes %s for a mise config: no base file, and its Toolchains installed", (file) => {
    const { root, run, calls } = sandbox();

    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");

    run();

    expect(existsSync(join(root, "mise.toml"))).toBe(false);
    expect(calls()).toEqual([`${root}: mise install`]);
  });

  it("installs the Toolchains of a repo directory that has only a .tool-versions", () => {
    const { root, run, calls } = sandbox();

    writeFileSync(join(root, "mise.toml"), "[tools]\n");
    writeFileSync(join(root, "mise.lock"), "");
    utimesSync(join(root, "mise.toml"), 1000, 1000);
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", ".tool-versions"), "node 22\n");

    run();

    expect(calls()).toContain(`${root}/app: mise install`);
  });

  it("writes the base mise.toml, git, gh and the image's other Toolchains in it, where the Workspace has none", () => {
    const { root, run, calls } = sandbox();

    run();

    expect(readFileSync(join(root, "mise.toml"), "utf8")).toBe(BASE_MISE_TOML);
    expect(BASE_MISE_TOML).toMatch(/"conda:git"/);
    expect(BASE_MISE_TOML).toMatch(/^gh = /m);
    expect(BASE_MISE_TOML).toMatch(/^node = /m);
    expect(BASE_MISE_TOML).toMatch(/^python = /m);
    expect(BASE_MISE_TOML).toMatch(/^lockfile = true$/m);
    expect(calls()).toEqual([`${root}: ${LOCK}`, `${root}: mise install`]);
  });

  it("copies the image's lockfile of the base mise.toml with it, so nothing is downloaded to lock it", () => {
    const { imageLock, root, run, calls } = sandbox();

    writeFileSync(imageLock, "# the image's lock\n");

    expect(run().status).toBe(0);
    expect(readFileSync(join(root, "mise.lock"), "utf8")).toBe("# the image's lock\n");
    expect(calls()).toEqual([`${root}: mise install`]);
  });

  it("leaves a Workspace's own mise.lock alone, and its mise.toml", () => {
    const { imageLock, root, run } = sandbox();

    writeFileSync(imageLock, "# the image's lock\n");
    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');
    writeFileSync(join(root, "mise.lock"), "# the Workspace's lock\n");
    run();

    expect(readFileSync(join(root, "mise.lock"), "utf8")).toBe("# the Workspace's lock\n");
  });

  it("writes the base file where mise reads it as the global config, so git and gh resolve from any directory", () => {
    // `toolchainEnv` points MISE_GLOBAL_CONFIG_FILE at the Workspace's mise.toml, which the bootstrap seeds.
    expect(ROOT_MISE_TOML).toBe("/workspace/mise.toml");
    expect(toolchainEnv().MISE_GLOBAL_CONFIG_FILE).toBe(ROOT_MISE_TOML);
  });

  it("leaves a Workspace's own mise.toml as it is", () => {
    const { root, run } = sandbox();

    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');
    run();

    expect(readFileSync(join(root, "mise.toml"), "utf8")).toBe('[tools]\nnode = "22"\n');
  });

  it("fails with mise's exit status, so the caller can tell the install did not finish", () => {
    const { run } = sandbox({ miseExit: 3 });

    expect(run().status).toBe(3);
  });
});

describe("the Environment's Toolchains", () => {
  const TOML = '[tools]\nnode = "22.20.0"\n';
  const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

  it("are written as the root's mise.toml where the Workspace has none, and locked and installed", () => {
    const { root, run, calls } = sandbox();

    expect(run({}, [], TOML).status).toBe(0);
    expect(read(root, "mise.toml")).toBe(TOML);
    expect(calls()).toEqual([`${root}: ${LOCK}`, `${root}: mise install`]);
  });

  it("replace the copy the bootstrap wrote last when they change, and the base file it wrote before", () => {
    const { root, run } = sandbox();

    run();
    expect(read(root, "mise.toml")).toBe(BASE_MISE_TOML);

    run({}, [], TOML);
    expect(read(root, "mise.toml")).toBe(TOML);

    const changed = '[tools]\nnode = "24.22.1"\n';

    run({}, [], changed);
    expect(read(root, "mise.toml")).toBe(changed);

    // Emptied: the base Toolchains again.
    run();
    expect(read(root, "mise.toml")).toBe(BASE_MISE_TOML);
  });

  it("leave a mise.toml the Workspace changed alone", () => {
    const { root, run } = sandbox();

    run({}, [], TOML);

    const own = `${TOML}python = "3.13"\n`;

    writeFileSync(join(root, "mise.toml"), own);
    run({}, [], '[tools]\nnode = "24.22.1"\n');

    expect(read(root, "mise.toml")).toBe(own);
  });

  it("leave a Workspace's own mise.toml alone, though they would replace the base file", () => {
    const { root, run } = sandbox();

    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');
    run({}, [], TOML);

    expect(read(root, "mise.toml")).toBe('[tools]\nnode = "22"\n');
  });

  it("are not written where the root has a mise config of another name", () => {
    const { root, run } = sandbox();

    writeFileSync(join(root, ".tool-versions"), "node 22\n");
    run({}, [], TOML);

    expect(existsSync(join(root, "mise.toml"))).toBe(false);
  });

  it("come with the lockfile made for them on this disk, so a Workspace started from it (a Build's) locks nothing", () => {
    const { root, run, calls, state } = sandbox();

    run({}, [], TOML);
    // What `mise lock` made, which the fake does not write.
    writeFileSync(join(root, "mise.lock"), "# locked for the Environment\n");
    run({}, [], TOML);
    expect(read(state, "mise.lock")).toBe("# locked for the Environment\n");

    // A new Workspace on the same disk: no files yet.
    rmSync(join(root, "mise.toml"));
    rmSync(join(root, "mise.lock"));
    const before = calls().length;

    run({}, [], TOML);

    expect(read(root, "mise.toml")).toBe(TOML);
    expect(read(root, "mise.lock")).toBe("# locked for the Environment\n");
    expect(calls().slice(before)).toEqual([`${root}: mise install`]);
  });

  it("take the image's lockfile when they are the base file again", () => {
    const { imageLock, root, run } = sandbox();

    writeFileSync(imageLock, "# the image's lock\n");
    run({}, [], TOML);
    writeFileSync(join(root, "mise.lock"), "# locked for the Environment\n");
    run();

    expect(read(root, "mise.toml")).toBe(BASE_MISE_TOML);
    expect(read(root, "mise.lock")).toBe("# the image's lock\n");
  });
});

describe("the Container's global pnpm configuration", () => {
  const configOf = (home: string) => join(home, ".config/pnpm/config.yaml");

  it("puts pnpm's store and global virtual store on the Container's disk and never asks before purging node_modules", () => {
    const { home, run } = sandbox();

    expect(run().status).toBe(0);

    const config = readFileSync(configOf(home), "utf8");

    expect(config).toBe(
      [
        `storeDir: "${home}/.pnpm-store"`,
        "virtualStoreType: global",
        "enableGlobalVirtualStore: true",
        "confirmModulesPurge: false",
        "",
      ].join("\n"),
    );
    // Not under /workspace, which is the FUSE mount.
    expect(config).not.toContain("/workspace");
  });

  it("names the store with a directory the token scan skips", () => {
    expect(PNPM_GLOBAL_CONFIG).toContainEqual(["storeDir", `"$HOME/${PNPM_STORE_DIRECTORY_NAME}"`]);
    expect(PNPM_STORE_DIRECTORY_NAME).toBe(".pnpm-store");
  });

  it("leaves virtualStoreDir unset, so a repo that keeps its virtual store in the project does not share one", () => {
    expect(PNPM_GLOBAL_CONFIG.map(([key]) => key)).not.toContain("virtualStoreDir");
  });

  it("keeps a setting the file has, and adds the others", () => {
    const { home, run } = sandbox();

    mkdirSync(dirname(configOf(home)), { recursive: true });
    writeFileSync(configOf(home), "virtualStoreType: project\nregistry: https://example.test/\n");

    run();

    expect(readFileSync(configOf(home), "utf8")).toBe(
      [
        "virtualStoreType: project",
        "registry: https://example.test/",
        `storeDir: "${home}/.pnpm-store"`,
        "enableGlobalVirtualStore: true",
        "confirmModulesPurge: false",
        "",
      ].join("\n"),
    );
  });

  it("switches the global virtual store on under both its names, for pnpm before and after 11.23", () => {
    expect(PNPM_GLOBAL_CONFIG).toContainEqual(["virtualStoreType", "global"]);
    expect(PNPM_GLOBAL_CONFIG).toContainEqual(["enableGlobalVirtualStore", "true"]);
  });

  it("starts a new line when the file does not end with one", () => {
    const { home, run } = sandbox();

    mkdirSync(dirname(configOf(home)), { recursive: true });
    writeFileSync(configOf(home), "registry: https://example.test/");

    run();

    const lines = readFileSync(configOf(home), "utf8").split("\n");

    expect(lines[0]).toBe("registry: https://example.test/");
    expect(lines).toContain("virtualStoreType: global");
  });

  it("does not add a key the file has in another spelling: kebab-case, quoted, or indented", () => {
    const { home, run } = sandbox();

    mkdirSync(dirname(configOf(home)), { recursive: true });
    writeFileSync(
      configOf(home),
      [
        "store-dir: /data/store",
        '"virtualStoreType": project',
        "'enable-global-virtual-store': false",
        "  confirm-modules-purge: true",
        "",
      ].join("\n"),
    );

    run();

    expect(readFileSync(configOf(home), "utf8")).toBe(
      [
        "store-dir: /data/store",
        '"virtualStoreType": project',
        "'enable-global-virtual-store': false",
        "  confirm-modules-purge: true",
        "",
      ].join("\n"),
    );
  });

  it("does not take a comment or another key that starts the same for a setting", () => {
    const { home, run } = sandbox();

    mkdirSync(dirname(configOf(home)), { recursive: true });
    writeFileSync(configOf(home), "# storeDir: /elsewhere\nstoreDirectory: x\n");

    run();

    expect(readFileSync(configOf(home), "utf8")).toContain(`storeDir: "${home}/.pnpm-store"`);
  });

  it("is written once: a second start leaves the file as it is", () => {
    const { home, run } = sandbox();

    run();

    const first = readFileSync(configOf(home), "utf8");

    run();

    expect(readFileSync(configOf(home), "utf8")).toBe(first);
  });

  it("is written where pnpm looks for it when XDG_CONFIG_HOME is set", () => {
    const { base, home, run } = sandbox();
    const xdg = join(base, "xdg");

    run({ XDG_CONFIG_HOME: xdg });

    expect(existsSync(join(xdg, "pnpm/config.yaml"))).toBe(true);
    expect(existsSync(configOf(home))).toBe(false);
  });

  it("does not count as a change worth a snapshot", () => {
    const { run } = sandbox();

    expect(run().stdout).not.toContain(BOOTSTRAP_CHANGED);
  });
});

describe("what the bootstrap says it changed", () => {
  it("says the Container's disk changed when mise installed a Toolchain, so the Workspace DO snapshots it", () => {
    const { root, run } = sandbox({ installs: "node/22.23.4" });

    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(BOOTSTRAP_CHANGED);
  });

  it("says nothing changed when every Toolchain was there already: the image's, or a snapshot's", () => {
    const { home, root, run } = sandbox();

    mkdirSync(join(home, ".local/share/mise/installs/node/22.23.4"), { recursive: true });
    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(BOOTSTRAP_CHANGED);
  });

  it("looks for installs where MISE_DATA_DIR says mise keeps them", () => {
    const { base, root, run } = sandbox({ installs: "node/22.23.4" });

    writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');

    // The fake mise installs under $HOME; mise itself would install under MISE_DATA_DIR, which here holds nothing new.
    expect(run({ MISE_DATA_DIR: join(base, "data") }).stdout).not.toContain(BOOTSTRAP_CHANGED);
  });
});

describe("the bootstrap's read-only directories", () => {
  /** `mount` and `umount` on PATH that log their arguments; the nth `mount` exits with `status.mount[n]` (the last one after that). */
  const withMount = (
    box: ReturnType<typeof sandbox>,
    status: { readonly mount?: ReadonlyArray<number> } = {},
  ) => {
    const log = join(box.base, "mount.log");
    const codes = join(box.base, "mount.codes");

    writeFileSync(codes, `${(status.mount ?? [0]).join("\n")}\n`);
    writeFileSync(
      join(box.bin, "mount"),
      `#!/bin/sh\necho "mount $*" >> ${log}\nn=$(grep -c '^mount' ${log})\ncode=$(sed -n "$n"p ${codes})\n[ -n "$code" ] || code=$(tail -n 1 ${codes})\nexit "$code"\n`,
    );
    writeFileSync(join(box.bin, "umount"), `#!/bin/sh\necho "umount $*" >> ${log}\n`);
    chmodSync(join(box.bin, "mount"), 0o755);
    chmodSync(join(box.bin, "umount"), 0o755);

    return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  };

  it("remounts a directory the Workspace holds read-only as read-only, so a write inside the Container fails", () => {
    const box = sandbox();
    const skills = join(box.root, ".agents/skills");
    const mounts = withMount(box);

    mkdirSync(skills, { recursive: true });
    writeFileSync(join(box.root, "mise.toml"), "[tools]\n");

    const result = box.run({}, [skills]);

    expect(result.status).toBe(0);
    expect(mounts()).toEqual([
      `mount --bind ${skills} ${skills}`,
      `mount -o remount,bind,ro ${skills}`,
    ]);
    // It was done before the Toolchains, and they were installed all the same.
    expect(box.calls()).toEqual([`${box.root}: ${LOCK}`, `${box.root}: mise install`]);
  });

  it("leaves a directory that is not there alone", () => {
    const box = sandbox();
    const mounts = withMount(box);

    writeFileSync(join(box.root, "mise.toml"), "[tools]\n");

    expect(box.run({}, [join(box.root, ".agents/skills")]).status).toBe(0);
    expect(mounts()).toEqual([]);
  });

  it("mounts nothing where no directory is read-only", () => {
    const box = sandbox();
    const mounts = withMount(box);

    writeFileSync(join(box.root, "mise.toml"), "[tools]\n");

    expect(box.run().status).toBe(0);
    expect(mounts()).toEqual([]);
  });

  it("does not fail the bootstrap where a Container cannot mount (no capability, or no FUSE)", () => {
    const box = sandbox();
    const skills = join(box.root, ".agents/skills");
    const mounts = withMount(box, { mount: [1] });

    mkdirSync(skills, { recursive: true });
    writeFileSync(join(box.root, "mise.toml"), "[tools]\n");

    expect(box.run({}, [skills]).status).toBe(0);
    expect(mounts()).toEqual([`mount --bind ${skills} ${skills}`]);
    expect(box.calls()).toContain(`${box.root}: mise install`);
  });

  it("takes the writable mount away when it cannot be made read-only", () => {
    const box = sandbox();
    const skills = join(box.root, ".agents/skills");
    const mounts = withMount(box, { mount: [0, 1] });

    mkdirSync(skills, { recursive: true });
    writeFileSync(join(box.root, "mise.toml"), "[tools]\n");

    expect(box.run({}, [skills]).status).toBe(0);
    expect(mounts()).toEqual([
      `mount --bind ${skills} ${skills}`,
      `mount -o remount,bind,ro ${skills}`,
      `umount ${skills}`,
    ]);
  });
});

describe("git after the bootstrap", () => {
  const identity = { CLOUDPID_GIT_NAME: "Pi Agent", CLOUDPID_GIT_EMAIL: "pi@example.com" };

  const git = (home: string, args: string[], env: Record<string, string> = {}, input?: string) =>
    spawnSync("git", args, {
      encoding: "utf8",
      input,
      env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env },
    });

  it("commits as the identity it is given", () => {
    const { run, home } = sandbox();

    run(identity);

    expect(git(home, ["config", "--global", "user.name"]).stdout.trim()).toBe("Pi Agent");
    expect(git(home, ["config", "--global", "user.email"]).stdout.trim()).toBe("pi@example.com");
  });

  it("keeps an identity the Container already has", () => {
    const { run, home } = sandbox();

    git(home, ["config", "--global", "user.name", "Someone Else"]);
    run(identity);

    expect(git(home, ["config", "--global", "user.name"]).stdout.trim()).toBe("Someone Else");
  });

  it("answers a github.com credential request with the token from the environment", () => {
    const { run, home } = sandbox();

    run(identity);

    const filled = git(
      home,
      ["credential", "fill"],
      { GITHUB_TOKEN: "ghp_secret" },
      "protocol=https\nhost=github.com\n\n",
    );

    expect(filled.stdout).toContain("username=x-access-token");
    expect(filled.stdout).toContain("password=ghp_secret");
  });

  it("gives no other host the token", () => {
    const { run, home } = sandbox();

    run(identity);

    const filled = git(
      home,
      ["credential", "fill"],
      { GITHUB_TOKEN: "ghp_secret", GIT_TERMINAL_PROMPT: "0" },
      "protocol=https\nhost=example.com\n\n",
    );

    expect(filled.stdout).not.toContain("ghp_secret");
  });

  it("never writes the token to a file", () => {
    const { run, home, root } = sandbox();

    run({ ...identity, GITHUB_TOKEN: "ghp_secret", GH_TOKEN: "ghp_secret" });

    const found = spawnSync("grep", ["-r", "ghp_secret", home, root], { encoding: "utf8" });

    expect(found.stdout).toBe("");
  });
});

/** A Workspace root with repos, a Container state directory, and the two Setup Script commands run for real. */
const setupSandbox = () => {
  const base = mkdtempSync(join(tmpdir(), "setup-"));
  const root = join(base, "workspace");
  const state = join(base, "state");

  mkdirSync(root, { recursive: true });

  const repo = (name: string, script?: string) => {
    const dir = join(root, ...name.split("/"));

    mkdirSync(join(dir, ".cloudpid"), { recursive: true });

    if (script !== undefined) writeFileSync(join(dir, SETUP_SCRIPT), script);

    return dir;
  };

  const environmentFile = join(base, "environment", "setup.sh");

  const pending = (environment?: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        pendingSetupScripts(
          root,
          state,
          environment === undefined ? undefined : { source: environment, file: environmentFile },
        ),
      ],
      { encoding: "utf8" },
    )
      .stdout.split("\n")
      .filter((line) => line !== "");

  const env = { PATH: process.env.PATH ?? "", CLOUDPID_MARK: "from the environment" };

  const bash = (script: string) => spawnSync("bash", ["-c", script], { encoding: "utf8", env });

  const run = (dir: string, timeoutSeconds?: number) =>
    bash(setupScriptRun(repoSetupScriptOf(dir, root), state, timeoutSeconds));

  const runEnvironment = () =>
    bash(setupScriptRun(environmentSetupScript(root, environmentFile), state));

  const runIfDue = (dir: string) =>
    spawnSync("bash", ["-c", setupScriptRunIfDue(dir, state, undefined, root)], {
      encoding: "utf8",
      env,
    });

  return { base, root, state, repo, pending, run, runEnvironment, runIfDue, environmentFile, bash };
};

describe("a Setup Script's record", () => {
  it("is named after the repo", () => {
    expect(setupRecordName("/workspace/app")).toBe("app");
    expect(setupRecordName("/tmp/root/app", "/tmp/root")).toBe("app");
  });
});

describe("the Setup Scripts", () => {
  it("are due for each repo that has one, and only those", () => {
    const { repo, pending } = setupSandbox();
    const a = repo("a", "echo a\n");

    repo("b");
    const c = repo("c", "echo c\n");

    expect(pending()).toEqual([a, c]);
  });

  it("are not due in a Workspace without repos", () => {
    expect(setupSandbox().pending()).toEqual([]);
  });

  it("run with bash in the repo's directory, with the environment they are given, and no input", () => {
    const { repo, run } = setupSandbox();

    const dir = repo(
      "a",
      'printf "%s|%s|%s" "$PWD" "$CLOUDPID_MARK" "${BASH_VERSION:+bash}"\nread -r line || echo " no input"\n',
    );

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${dir}|from the environment|bash no input\n`);
  });

  it("are not due again once they succeeded, until their content changes", () => {
    const { repo, pending, run } = setupSandbox();
    const dir = repo("a", "true\n");

    expect(run(dir).status).toBe(0);
    expect(pending()).toEqual([]);

    writeFileSync(join(dir, SETUP_SCRIPT), "true # changed\n");

    expect(pending()).toEqual([dir]);
  });

  it("record their success outside the repo, in the state directory", () => {
    const { repo, run, state } = setupSandbox();
    const dir = repo("a", "true\n");

    run(dir);

    expect(readFileSync(setupRecord("a", state), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stay due after a failure, which exits with the script's status", () => {
    const { repo, pending, run } = setupSandbox();
    const dir = repo("a", "echo broken >&2\nexit 3\n");

    const result = run(dir);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("broken");
    expect(pending()).toEqual([dir]);
  });

  it("are stopped, with what they started, once past their time, and stay due", () => {
    const { repo, pending, run } = setupSandbox();
    const dir = repo("a", "sleep 30 &\nwait\n");
    const started = Date.now();

    const result = run(dir, 1);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(scriptTimedOut(result.status ?? undefined, result.stderr)).toBe(true);
    expect(pending()).toEqual([dir]);
  });

  it("run when due only, and not at all where there is none", () => {
    const { repo, runIfDue } = setupSandbox();
    const dir = repo("a", "echo ran\n");
    const none = repo("b");

    expect(runIfDue(dir).stdout).toBe("ran\n");
    expect(runIfDue(dir).stdout).toBe("");
    expect(runIfDue(none).status).toBe(0);
    expect(runIfDue(none).stdout).toBe("");
  });

  it("are not taken for stopped when they exit with timeout's status on their own", () => {
    const { repo, run } = setupSandbox();
    const result = run(repo("a", "exit 124\n"), 60);

    expect(result.status).toBe(124);
    expect(scriptTimedOut(result.status ?? undefined, result.stderr)).toBe(false);
  });
});

/** A script with what bash quoting or a heredoc could trip on: quotes, `$`, backslashes, a heredoc, UTF-8. */
const AWKWARD_SCRIPT = String.raw`printf '%s\n' "it's \$HOME" 'a "b"' \
  "\\ back" €
cat <<'EOF'
CLOUDPID_EOF
EOF
`;

/** What `AWKWARD_SCRIPT` prints. */
const AWKWARD_OUTPUT = 'it\'s $HOME\na "b"\n\\ back\n€\nCLOUDPID_EOF\n';

describe("the Environment's Setup Script", () => {
  it("is due before the repos' when it has one, written to its file outside the Workspace as it is", () => {
    const { repo, pending, environmentFile, bash } = setupSandbox();
    const a = repo("a", "true\n");

    expect(pending(AWKWARD_SCRIPT)).toEqual([environmentFile, a]);
    expect(readFileSync(environmentFile, "utf8")).toBe(AWKWARD_SCRIPT);
    expect(bash(`bash ${environmentFile}`).stdout).toBe(AWKWARD_OUTPUT);
  });

  it("is not due when the Environment has none, and its old file is removed", () => {
    const { repo, pending, environmentFile } = setupSandbox();
    const a = repo("a", "true\n");

    pending("true\n");

    expect(pending("")).toEqual([a]);
    expect(existsSync(environmentFile)).toBe(false);
  });

  it("runs with bash in the Workspace root, with no input, and is recorded under a name no repo can have", () => {
    const { root, state, pending, runEnvironment } = setupSandbox();

    pending('printf "%s|%s" "$PWD" "$CLOUDPID_MARK"\nread -r line || echo " no input"\n');

    const result = runEnvironment();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${root}|from the environment no input\n`);
    expect(ENVIRONMENT_SETUP_RECORD).toMatch(/^[.@-]/);
    expect(readFileSync(setupRecord(ENVIRONMENT_SETUP_RECORD, state), "utf8").trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("is not due again once it succeeded, until it changes, and stays due after a failure", () => {
    const { pending, runEnvironment, environmentFile } = setupSandbox();

    pending("true\n");
    expect(runEnvironment().status).toBe(0);
    expect(pending("true\n")).toEqual([]);
    expect(pending("exit 4\n")).toEqual([environmentFile]);
    expect(runEnvironment().status).toBe(4);
    expect(pending("exit 4\n")).toEqual([environmentFile]);
  });

  it("does not take a repo's record, nor a repo the Environment's", () => {
    const { repo, pending, run, runEnvironment, environmentFile } = setupSandbox();
    const a = repo("a", "true\n");

    pending("true\n");
    runEnvironment();

    expect(pending("true\n")).toEqual([a]);

    run(a);

    expect(pending("true # changed\n")).toEqual([environmentFile]);
  });
});

describe("the Start Scripts", () => {
  /** A Workspace root whose repos may have a Start Script, and the Start Script commands run for real. */
  const startSandbox = () => {
    const sandbox = setupSandbox();

    const repo = (name: string, script?: string) => {
      const dir = sandbox.repo(name);

      if (script !== undefined) writeFileSync(join(dir, START_SCRIPT), script);

      return dir;
    };

    const listed = () =>
      sandbox
        .bash(startScriptDirectories(sandbox.root))
        .stdout.split("\n")
        .filter((line) => line !== "");

    const start = (dir: string, timeoutSeconds?: number) =>
      sandbox.bash(startScriptRun({ directory: dir, file: START_SCRIPT }, timeoutSeconds));

    const environmentFile = join(sandbox.base, "environment", "start.sh");

    const startEnvironment = (source: string) =>
      sandbox.bash(environmentStartScriptRun(source, sandbox.root, environmentFile));

    return { ...sandbox, repo, listed, start, startEnvironment, environmentFile };
  };

  it("are found in each repo that has one, and only those", () => {
    const { repo, listed } = startSandbox();
    const a = repo("a", "true\n");

    repo("b");
    const c = repo("c", "true\n");

    expect(listed()).toEqual([a, c]);
  });

  it("run with bash in the repo's directory, with the environment they are given, and no input", () => {
    const { repo, start } = startSandbox();

    const dir = repo(
      "a",
      'printf "%s|%s|%s" "$PWD" "$CLOUDPID_MARK" "${BASH_VERSION:+bash}"\nread -r line || echo " no input"\n',
    );

    const result = start(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${dir}|from the environment|bash no input\n`);
  });

  it("run every time: nothing records them", () => {
    const { repo, start, state } = startSandbox();
    const dir = repo("a", "echo up\n");

    expect(start(dir).stdout).toBe("up\n");
    expect(start(dir).stdout).toBe("up\n");
    expect(existsSync(state)).toBe(false);
  });

  it("exit with the script's status", () => {
    const { repo, start } = startSandbox();

    expect(start(repo("a", "exit 3\n")).status).toBe(3);
  });

  it("are stopped, with what they started, once past their time", () => {
    const { repo, start } = startSandbox();
    const started = Date.now();

    const result = start(repo("a", "sleep 30 &\nwait\n"), 1);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(scriptTimedOut(result.status ?? undefined, result.stderr)).toBe(true);
  });

  it("let a service they detach outlive them", () => {
    const { repo, start, root } = startSandbox();
    const marker = join(root, "service-up");

    const result = start(
      repo("a", `setsid nohup bash -c 'sleep 1; touch ${marker}' >/dev/null 2>&1 &\n`),
      60,
    );

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    spawnSync("sleep", ["2"]);
    expect(existsSync(marker)).toBe(true);
  });

  it("include the Environment's, written to its file as it is and run in the Workspace root", () => {
    const { startEnvironment, environmentFile, root } = startSandbox();

    const result = startEnvironment(`printf '%s\\n' "$PWD"\n${AWKWARD_SCRIPT}`);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${root}\n${AWKWARD_OUTPUT}`);
    expect(readFileSync(environmentFile, "utf8")).toContain("CLOUDPID_EOF");
  });
});
