// The Container's Toolchain contract with the Workspace DO (docs/spec.md → Container and Toolchains, ADR-0004): which
// paths stay container-local, what a command's environment carries, and what the bootstrap does on Container start.
// The bootstrap runs for real, under bash, against a fake `mise` that records what it is asked.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import {
  BASE_MISE_TOML,
  bootstrapScript,
  ROOT_MISE_TOML,
  TOOLCHAIN_IGNORE,
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
    for (const name of ["dist", "build", "coverage", "vendor", "venv", ".yarn"]) {
      expect(TOOLCHAIN_IGNORE.filter((pattern) => pattern.split("/").includes(name))).toEqual([]);
    }
  });

  it("does not make a source directory called target local to the Container", () => {
    expect(TOOLCHAIN_IGNORE).not.toContain("**/target");
  });

  it("leaves mise to the Container's own disk: its data and temp files are on one filesystem, off the ignore boundary", () => {
    const env = toolchainEnv({});

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

describe("a command's environment", () => {
  it("carries the GitHub token as GH_TOKEN and GITHUB_TOKEN", () => {
    const env = toolchainEnv({ githubToken: "ghp_secret" });

    expect(env.GH_TOKEN).toBe("ghp_secret");
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
  });

  it("carries no token variable when there is none, so a blank one cannot shadow a user's", () => {
    expect(toolchainEnv({ githubToken: "" })).not.toHaveProperty("GH_TOKEN");
    expect(toolchainEnv({ githubToken: "" })).not.toHaveProperty("GITHUB_TOKEN");
    expect(toolchainEnv({})).not.toHaveProperty("GH_TOKEN");
  });

  it("never lets git ask a question nobody can answer", () => {
    expect(toolchainEnv({}).GIT_TERMINAL_PROMPT).toBe("0");
  });
});

/** A throwaway Workspace root and HOME, and a `mise` on PATH that logs its calls and the directory they ran in. */
const sandbox = (options: { readonly miseExit?: number } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const log = join(base, "mise.log");

  for (const directory of [root, home, bin]) mkdirSync(directory, { recursive: true });

  writeFileSync(
    join(bin, "mise"),
    `#!/bin/sh\necho "$PWD: mise $*" >> ${log}\nexit ${options.miseExit ?? 0}\n`,
  );
  chmodSync(join(bin, "mise"), 0o755);

  const run = (env: Record<string, string> = {}, readOnly: readonly string[] = []) =>
    spawnSync("bash", ["-c", bootstrapScript(root, readOnly)], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: home,
        ...env,
      },
    });

  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  return { base, bin, root, home, run, calls };
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

  it("writes the base mise.toml, git and gh in it, where the Workspace has none", () => {
    const { root, run, calls } = sandbox();

    run();

    expect(readFileSync(join(root, "mise.toml"), "utf8")).toBe(BASE_MISE_TOML);
    expect(BASE_MISE_TOML).toMatch(/"conda:git"/);
    expect(BASE_MISE_TOML).toMatch(/^gh = /m);
    expect(BASE_MISE_TOML).toMatch(/^lockfile = true$/m);
    expect(calls()).toEqual([`${root}: ${LOCK}`, `${root}: mise install`]);
  });

  it("writes the base file where mise reads it as the global config, so git and gh resolve from any directory", () => {
    // `toolchainEnv` points MISE_GLOBAL_CONFIG_FILE at the Workspace's mise.toml, which the bootstrap seeds.
    expect(ROOT_MISE_TOML).toBe("/workspace/mise.toml");
    expect(toolchainEnv({}).MISE_GLOBAL_CONFIG_FILE).toBe(ROOT_MISE_TOML);
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
