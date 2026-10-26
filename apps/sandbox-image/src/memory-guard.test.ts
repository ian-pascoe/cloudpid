// The memory guard (docs/spec.md → Container and Toolchains → Memory guard): `cloudpid-memory-guard` runs earlyoom and
// leaves a note for each process earlyoom announces it is stopping, and each command that ran meanwhile prints the
// notes on stderr when it ends, through the file its bash reads first (BASH_ENV). The scripts run for real, under
// bash, around a fake earlyoom; the supervisor's side is `supervisor.test.ts`.
// @effect-diagnostics nodeBuiltinImport:off processEnv:off preferEffectArray:off asyncFunction:off globalTimers:off newPromise:off
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import {
  COMMAND_BASH,
  COMMAND_BASH_ENV,
  MEMORY_GUARD,
  MEMORY_GUARD_AVOID,
  MEMORY_GUARD_KIB,
  MEMORY_GUARD_PERCENT,
  MEMORY_NOTES_DIRECTORY,
} from "@cloudpid/sandbox-image/memory-guard";
import { toolchainEnv } from "@cloudpid/sandbox-image/toolchains";

const image = (name: string) => readFileSync(join(sandboxImageContext, name), "utf8");

const dockerfile = image("Dockerfile");
const supervise = image("supervise");
const guardSource = image("cloudpid-memory-guard");
const commandSource = image("command.bash");

const guardScript = join(sandboxImageContext, "cloudpid-memory-guard");
const commandBash = join(sandboxImageContext, "command.bash");

const notesDirectory = () => join(mkdtempSync(join(tmpdir(), "memory-notes-")), "notes");

/** What earlyoom 1.7 prints just before it sends a process the signal. */
const sending = (signal: string, pid: number, name: string, mib: number) =>
  `sending ${signal} to process ${pid} uid 0 "${name}": badness 900, VmRSS ${mib} MiB`;

/**
 * A fake earlyoom: it records its arguments and its pid, then prints each of `lines` once the file `go` exists (at once
 * without one), and runs until it is stopped, as earlyoom does.
 */
const fakeEarlyoom = (lines: readonly string[], go?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "earlyoom-"));
  const path = join(dir, "earlyoom");
  const args = join(dir, "args");
  const pid = join(dir, "pid");

  const output = lines
    .map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`)
    .join("\n");

  writeFileSync(
    path,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$@" >${args}`,
      `echo $$ >${pid}`,
      "echo 'earlyoom v1.7'",
      go === undefined ? "" : `while [ ! -e ${go} ]; do sleep 0.01; done`,
      output,
      "exec sleep 600",
    ].join("\n"),
  );
  chmodSync(path, 0o755);

  return { path, args, pid: () => Number(readFileSync(pid, "utf8")) };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGTERM");
});

/** The guard, as the supervisor starts it, with its stdout collected. */
const startGuard = (earlyoom: string, notes: string) => {
  const child = spawn("bash", [guardScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, CLOUDPID_EARLYOOM: earlyoom, CLOUDPID_MEMORY_NOTES: notes },
  });

  const output = { stdout: "", stderr: "" };

  running.push(child);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output.stderr += chunk));

  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

  return { child, output, exited };
};

/** Waits until `check` holds, or fails after two seconds. */
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("timed out");
};

/** The notes in `notes`, oldest first, without the ones being written. */
const notesIn = (notes: string): string[] =>
  existsSync(notes)
    ? readdirSync(notes)
        .filter((name) => /^\d+$/.test(name))
        .toSorted()
        .map((name) => readFileSync(join(notes, name), "utf8"))
    : [];

/**
 * A Container command as computerd runs it, with `bashEnv` as its BASH_ENV and the notes in `notes`: under `sh -c`,
 * with its stdin on `/dev/null`. Not Node's default stdin, a socket: bash with a socket for stdin and no `SHLVL` takes
 * itself for an rshd command and reads `~/.bashrc` instead of BASH_ENV.
 */
const command = (script: string, notes: string, bashEnv: string = commandBash) =>
  spawnSync("sh", ["-c", `exec bash -c '${script.replaceAll("'", "'\\''")}'`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, BASH_ENV: bashEnv, CLOUDPID_MEMORY_NOTES: notes },
  });

/** A shell line that leaves `text` as a note now, as the guard does. */
const leaveNote = (text: string) =>
  `mkdir -p "$CLOUDPID_MEMORY_NOTES"; echo "${text}" >"$CLOUDPID_MEMORY_NOTES/\${EPOCHREALTIME/[.,]/}"`;

describe("the memory guard in the image", () => {
  it("installs earlyoom, the guard and the file every command's bash reads first", () => {
    expect(dockerfile).toMatch(/^\s+earlyoom \\$/m);
    expect(dockerfile).toContain(`COPY --chmod=755 cloudpid-memory-guard ${MEMORY_GUARD}\n`);
    expect(dockerfile).toContain(`COPY command.bash ${COMMAND_BASH}\n`);
    expect(supervise).toContain(`\${CLOUDPID_MEMORY_GUARD:-${MEMORY_GUARD}}`);
  });

  it("gives earlyoom the limits and the names it spares", () => {
    expect(guardSource).toContain(`memory_percent=${MEMORY_GUARD_PERCENT}\n`);
    expect(guardSource).toContain(`memory_kib=${MEMORY_GUARD_KIB}\n`);
    expect(guardSource).toContain(`avoid='${MEMORY_GUARD_AVOID}'\n`);
  });

  it("keeps the notes in one place for the supervisor, the guard and the commands", () => {
    const fallback = `\${CLOUDPID_MEMORY_NOTES:-${MEMORY_NOTES_DIRECTORY}}`;

    expect(supervise).toContain(fallback);
    expect(guardSource).toContain(fallback);
    expect(commandSource).toContain(fallback);
  });

  it("never stops computerd, the supervisor or the guard, by the names the kernel gives them, and stops anything else", () => {
    const avoid = new RegExp(MEMORY_GUARD_AVOID);

    // The kernel keeps 15 characters of a process's name.
    for (const name of ["computerd", "cloudpid-supervise", "cloudpid-memory-guard"]) {
      expect(avoid.test(name.slice(0, 15)), name).toBe(true);
    }

    for (const name of ["node", "python3", "tsgolint", "workerd", "computerd-x", "bash"]) {
      expect(avoid.test(name), name).toBe(false);
    }
  });

  it("is what every command's environment points BASH_ENV at", () => {
    expect(toolchainEnv({}).BASH_ENV).toBe(COMMAND_BASH_ENV);
  });
});

describe("the guard", () => {
  it("runs earlyoom with its limits, passes its lines through, and leaves a note for each process it stops", async () => {
    const notes = notesDirectory();

    const earlyoom = fakeEarlyoom([
      "low memory! at or below SIGTERM limits: mem 15.00%, swap 10.00%",
      sending("SIGTERM", 4242, "node", 1911),
      "process exited after 0.4 seconds",
    ]);

    const guard = startGuard(earlyoom.path, notes);

    await until(() => guard.output.stdout.includes("process exited"));

    expect(readFileSync(earlyoom.args, "utf8").split("\n")).toEqual([
      "-m",
      MEMORY_GUARD_PERCENT,
      "-M",
      MEMORY_GUARD_KIB,
      "-r",
      "0",
      "-p",
      "--avoid",
      MEMORY_GUARD_AVOID,
      "",
    ]);
    expect(guard.output.stdout).toContain(`earlyoom v1.7\n`);
    expect(guard.output.stdout).toContain(`${sending("SIGTERM", 4242, "node", 1911)}\n`);
    expect(notesIn(notes)).toEqual([
      expect.stringMatching(
        /^cloudpid: the Container was nearly out of memory, so its memory guard stopped `node` \(pid 4242, 1911 MiB\) at \d\d:\d\d:\d\d UTC to keep the Container answering\. Run less at once \(fewer parallel tasks or test workers, such as turbo's --concurrency or vitest's --maxWorkers\), or restart this Container at a larger size with the container_resize tool\.\n$/,
      ),
    ]);
  });

  it("leaves one note for a process sent SIGTERM and then SIGKILL, and one for each other", async () => {
    const notes = notesDirectory();

    const earlyoom = fakeEarlyoom([
      sending("SIGTERM", 1, "vitest", 900),
      sending("SIGKILL", 1, "vitest", 900),
      sending("SIGTERM", 2, "tsc", 400),
      "done",
    ]);

    const guard = startGuard(earlyoom.path, notes);

    await until(() => guard.output.stdout.includes("done"));

    expect(notesIn(notes)).toEqual([
      expect.stringContaining("stopped `vitest` (pid 1, 900 MiB)"),
      expect.stringContaining("stopped `tsc` (pid 2, 400 MiB)"),
    ]);
  });

  it("leaves no note for the limits earlyoom prints as it starts", async () => {
    const notes = notesDirectory();

    // earlyoom 1.7's banner, as it prints it on a Container.
    const earlyoom = fakeEarlyoom([
      "sending SIGTERM when mem <= 15.00% and swap <= 10.00%,",
      "        SIGKILL when mem <=  8.00% and swap <=  5.00%",
      "done",
    ]);

    const guard = startGuard(earlyoom.path, notes);

    await until(() => guard.output.stdout.includes("done"));

    expect(guard.output.stdout).toContain("sending SIGTERM when mem <= 15.00%");
    expect(notesIn(notes)).toEqual([]);
  });

  it("still leaves a note when earlyoom words a stop another way", async () => {
    const notes = notesDirectory();
    const earlyoom = fakeEarlyoom(['sending SIGKILL to "node" (pid 7)', "done"]);

    const guard = startGuard(earlyoom.path, notes);

    await until(() => guard.output.stdout.includes("done"));

    expect(notesIn(notes)).toEqual([expect.stringContaining("memory guard stopped a process at")]);
  });

  it("stops earlyoom when it is stopped", async () => {
    const earlyoom = fakeEarlyoom(["up"]);
    const guard = startGuard(earlyoom.path, notesDirectory());

    await until(() => guard.output.stdout.includes("up"));

    const pid = earlyoom.pid();

    expect(alive(pid)).toBe(true);

    guard.child.kill("SIGTERM");

    expect(await guard.exited).toBe(0);
    await until(() => !alive(pid));
  });

  it("says so on stderr and exits where earlyoom is missing", async () => {
    const guard = startGuard("/nonexistent/earlyoom", notesDirectory());

    expect(await guard.exited).toBe(0);
    expect(guard.output.stdout).toBe("");
    expect(guard.output.stderr).toContain("no memory guard (/nonexistent/earlyoom is missing)");
  });
});

describe("a command while the guard stops a process", () => {
  it("ends with the note on stderr, and keeps its own output and status", () => {
    const notes = notesDirectory();

    const run = command(`echo out; ${leaveNote("stopped node")}; echo more; exit 3`, notes);

    expect(run).toMatchObject({ status: 3, stdout: "out\nmore\n", stderr: "stopped node\n" });
  });

  it("gets the note when it was stopped by a signal itself", () => {
    const notes = notesDirectory();

    const run = command(`${leaveNote("stopped bash")}; kill -TERM $$`, notes);

    expect(run.signal).toBe("SIGTERM");
    expect(run.stderr).toBe("stopped bash\n");
  });

  it("lists each note left while it ran, in order, and none from before it", () => {
    const notes = notesDirectory();

    command(leaveNote("before"), notes);

    const run = command(`${leaveNote("first")}; sleep 0.01; ${leaveNote("second")}`, notes);

    expect(run.stderr).toBe("first\nsecond\n");
    // The next command started after them all.
    expect(command("echo quiet", notes).stderr).toBe("");
  });

  it("says nothing when the guard stopped nothing, also before it ever ran", () => {
    expect(command("echo fine", notesDirectory())).toMatchObject({
      status: 0,
      stdout: "fine\n",
      stderr: "",
    });
  });

  it("gets the note once, not again from a bash it started, which does not read the file", () => {
    const notes = notesDirectory();

    const run = command(
      `bash -c 'printenv BASH_ENV || echo no BASH_ENV; ${leaveNote("stopped node").replaceAll("'", "'\\''")}'`,
      notes,
    );

    expect(run.stdout).toBe("no BASH_ENV\n");
    expect(run.stderr).toBe("stopped node\n");
  });

  it("gets the guard's note for a process stopped while it waits on it", async () => {
    // The guard announces the stop while the command runs; the command ends a little after, as one whose process
    // was stopped does once the process has died.
    const notes = notesDirectory();
    const go = join(mkdtempSync(join(tmpdir(), "go-")), "go");
    const earlyoom = fakeEarlyoom([sending("SIGTERM", 99, "python3", 5108)], go);
    const guard = startGuard(earlyoom.path, notes);

    await until(() => guard.output.stdout.includes("earlyoom v1.7"));

    const run = command(`touch ${go}; sleep 0.3; echo after`, notes);

    expect(run.stdout).toBe("after\n");
    expect(run.stderr).toContain("memory guard stopped `python3` (pid 99, 5108 MiB)");
  });
});

describe("BASH_ENV of a command", () => {
  it("reads the file where the image has it", () => {
    const notes = notesDirectory();
    const bashEnv = COMMAND_BASH_ENV.replaceAll(COMMAND_BASH, commandBash);

    const run = command(`${leaveNote("stopped node")}; exit 4`, notes, bashEnv);

    expect(run).toMatchObject({ status: 4, stderr: "stopped node\n" });
  });

  it("says nothing on a Container whose older image lacks it", () => {
    const bashEnv = COMMAND_BASH_ENV.replaceAll(COMMAND_BASH, "/nonexistent/command.bash");

    expect(command("echo old; exit 5", notesDirectory(), bashEnv)).toMatchObject({
      status: 5,
      stdout: "old\n",
      stderr: "",
    });
  });
});
