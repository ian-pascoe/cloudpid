// The Container's Toolchain contract with the Workspace DO (docs/spec.md → Container and Toolchains, ADR-0004): which
// paths stay container-local, what a command's environment carries, and what the bootstrap does on Container start.
// The bootstrap runs for real, under bash, against a fake `mise` that records what it is asked.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off globalDate:off
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
  BASE_MISE_LOCK,
  BASE_MISE_TOML,
  bootstrapScript,
  pendingSetupScripts,
  ROOT_MISE_TOML,
  SETUP_SCRIPT,
  setupScriptRun,
  setupScriptTimedOut,
  setupRecord,
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

  // No image lockfile unless a test makes one there.
  const imageLock = join(base, "image.mise.lock");

  const run = (env: Record<string, string> = {}, readOnly: readonly string[] = []) =>
    spawnSync("bash", ["-c", bootstrapScript(root, readOnly, imageLock)], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: home,
        ...env,
      },
    });

  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  return { base, bin, root, home, imageLock, run, calls };
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

/** A Workspace root with repos, a Container state directory, and the two Setup Script commands run for real. */
const setupSandbox = () => {
  const base = mkdtempSync(join(tmpdir(), "setup-"));
  const root = join(base, "workspace");
  const state = join(base, "state");

  mkdirSync(root, { recursive: true });

  const repo = (name: string, script?: string) => {
    const dir = join(root, name);

    mkdirSync(join(dir, ".agents"), { recursive: true });

    if (script !== undefined) writeFileSync(join(dir, SETUP_SCRIPT), script);

    return dir;
  };

  const pending = () =>
    spawnSync("bash", ["-c", pendingSetupScripts(root, state)], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line !== "");

  const run = (dir: string, timeoutSeconds?: number) =>
    spawnSync("bash", ["-c", setupScriptRun(dir, state, timeoutSeconds)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", CLOUDPID_MARK: "from the environment" },
    });

  return { root, state, repo, pending, run };
};

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
    expect(setupScriptTimedOut(result.status ?? undefined, result.stderr)).toBe(true);
    expect(pending()).toEqual([dir]);
  });

  it("are not taken for stopped when they exit with timeout's status on their own", () => {
    const { repo, run } = setupSandbox();
    const result = run(repo("a", "exit 124\n"), 60);

    expect(result.status).toBe(124);
    expect(setupScriptTimedOut(result.status ?? undefined, result.stderr)).toBe(false);
  });
});
