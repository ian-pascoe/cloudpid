// Throwaway probe for #143 (never merged): does computer's sync hold for a process started with the platform's
// `ctx.container.exec`, outside computerd? Reached through a token-guarded temporary route on the Workspaces Worker.
// @effect-diagnostics globalRandom:off cryptoRandomUUID:off asyncFunction:off globalTimers:off globalDate:off preferEffectArray:off missingPipeableSignature:off newPromise:off globalConsole:off
/* oxlint-disable */

export interface ProbeFs {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface ProbeDeps {
  readonly container: () => Container | undefined;
  readonly fs: ProbeFs;
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly push: () => Promise<void>;
  readonly pull: () => Promise<void>;
  readonly signal: () => void;
  readonly runOnContainer: (
    script: string,
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  readonly kv: { get(key: string): unknown; put(key: string, value: unknown): void };
  readonly abort: () => void;
}

const DIR = "/workspace/probe-143";
let instanceId: string | undefined;
const instance = () => (instanceId ??= crypto.randomUUID().slice(0, 8));
const VERSION = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "");

const timed = async <A>(f: () => Promise<A>): Promise<{ ms: number; value: A }> => {
  const start = Date.now();
  const value = await f();
  return { ms: Date.now() - start, value };
};

/** An interactive shell on a PTY: commands are written to its stdin, each followed by a marker its output ends at. */
class Pty {
  #buffer = "";
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #marker = 0;
  readonly done: Promise<void>;

  constructor(readonly process: ExecProcess) {
    if (process.stdin === null || process.stdout === null)
      throw new Error("pty without stdin/stdout");
    this.#writer = process.stdin.getWriter();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    this.done = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.#buffer += decoder.decode(value as Uint8Array, { stream: true });
      }
    })().catch((cause) => {
      this.#buffer += `\n[read failed: ${String(cause)}]`;
    });
  }

  get raw(): string {
    return this.#buffer;
  }

  async write(text: string): Promise<void> {
    await this.#writer.write(this.#encoder.encode(text));
  }

  /** Run `command` and answer its output (the echo of the command line included) and `$?`. */
  async run(command: string, timeoutMs = 20_000): Promise<{ output: string; status: string }> {
    const n = ++this.#marker;
    const from = this.#buffer.length;
    await this.write(`${command}; printf '__M%s_%s__\\n' ${n} $?\n`);
    const pattern = new RegExp(`__M${n}_(\\d+)__`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(this.#buffer.slice(from));
      if (match !== null) {
        const output = stripAnsi(this.#buffer.slice(from, from + match.index));
        return { output, status: match[1] ?? "?" };
      }
      if (Date.now() > deadline)
        return { output: stripAnsi(this.#buffer.slice(from)), status: "timeout" };
      await sleep(50);
    }
  }
}

const execOutput = async (
  container: Container,
  argv: string[],
  options: ContainerExecOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const process = await container.exec(argv, { stdout: "pipe", stderr: "pipe", ...options });
  const { stdout, stderr, exitCode } = await process.output();
  return {
    exitCode,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

const within = <A>(promise: Promise<A>, ms: number): Promise<A | "timeout"> =>
  Promise.race([promise, sleep(ms).then(() => "timeout" as const)]);

const ENV_NAMES = "env | cut -d= -f1 | sort | tr '\\n' ' '";
const FACTS = `id; echo "pwd=$(pwd)"; echo "shell=$0"; echo "fs=$(stat -f -c %T /workspace)"; echo "tty=$(tty)"; grep -E ' /workspace ' /proc/mounts || echo 'no /workspace in /proc/mounts'; echo "env: $(${ENV_NAMES})"`;

export const runProbe = async (op: string, deps: ProbeDeps): Promise<unknown> => {
  const steps: Record<string, unknown> = {};
  const step = async (name: string, f: () => Promise<unknown>) => {
    const start = Date.now();
    try {
      steps[name] = { ms: Date.now() - start, ...(await f().then((value) => ({ value }))) };
      (steps[name] as { ms: number }).ms = Date.now() - start;
    } catch (cause) {
      steps[name] = { ms: Date.now() - start, error: String((cause as Error)?.stack ?? cause) };
    }
  };
  const container = () => {
    const c = deps.container();
    if (c === undefined) throw new Error("no ctx.container");
    return c;
  };

  if (op === "abort") {
    setTimeout(() => deps.abort(), 10);
    return { aborting: true, instance: instance() };
  }

  if (op === "check-long") {
    const pid = deps.kv.get("probe-143:long-pid");
    await step("connected", async () => ({ running: deps.container()?.running }));
    await step("ps", () =>
      execOutput(container(), [
        "bash",
        "-c",
        `ps -o pid,pgid,stat,etime,cmd -p ${String(pid)} || echo "pid ${String(pid)} gone"; ps -eo pid,cmd | grep -c 'sleep 901' `,
      ]),
    );
    return { op, pid, instance: instance(), version: VERSION, at: new Date().toISOString(), steps };
  }

  // 1. Connect through computer, so the bootstrap runs and the files are pushed.
  const nonce = Math.random().toString(36).slice(2, 10);
  await step("1-connect-through-computer", async () => {
    const ran = await deps.runOnContainer(`${FACTS}; echo "BASH_ENV=$BASH_ENV"`);
    return ran;
  });

  if (op === "start-long") {
    await step("start-long", async () => {
      const process = await container().exec(["bash", "-c", "echo $$; exec sleep 901"], {
        pty: { cols: 80, rows: 24 },
      });
      const pty = new Pty(process);
      for (let i = 0; i < 100 && !/\d+/.test(pty.raw); i++) await sleep(50);
      const pid = Number(/(\d+)/.exec(pty.raw)?.[1]);
      deps.kv.put("probe-143:long-pid", pid);
      return { platformPid: process.pid, pid, raw: pty.raw };
    });
    return { op, instance: instance(), steps };
  }

  // 5. The exec's environment, without and with a PTY.
  await step("5-exec-pipes-no-options", () => execOutput(container(), ["bash", "-c", FACTS]));
  await step("5-exec-pipes-cwd-workspace", () =>
    execOutput(container(), ["bash", "-c", FACTS], { cwd: "/workspace" }),
  );

  let pty: Pty | undefined;
  await step("5-pty-start", async () => {
    const started = await timed(() =>
      container().exec(["bash", "-i"], { pty: { cols: 80, rows: 24 }, cwd: "/workspace" }),
    );
    pty = new Pty(started.value);
    return {
      startMs: started.ms,
      pid: started.value.pid,
      isPty: started.value.isPty,
      stderrNull: started.value.stderr === null,
    };
  });
  if (pty === undefined) return { op, steps };
  const shell = pty;

  await step("5-pty-facts", () => shell.run(FACTS));
  await step("5-pty-size-before", () => shell.run("stty size; tput cols"));
  await step("5-pty-resize-120x40", async () => {
    shell.process.resize(120, 40);
    await sleep(200);
    return shell.run("stty size");
  });
  await step("5-pty-mise-and-tools", () =>
    shell.run("command -v mise node git gh; echo PATH=$PATH"),
  );

  // 2. Worker Shell side → push → the PTY process reads it.
  const doFile = `${DIR}/from-do-${nonce}.txt`;
  await step("2-do-write", async () => {
    await deps.ensureDirectory(DIR);
    await deps.fs.writeFile(doFile, `hello-from-do-${nonce}\n`);
    return { doFile };
  });
  await step("2-pty-read-before-push", () => shell.run(`cat ${doFile}`));
  await step("2-push", async () => (await timed(deps.push)).ms);
  await step("2-pty-read-after-push", () => shell.run(`cat ${doFile}`));

  // 2b. The file-change signal's own push (no explicit push), as the agent's file tools trigger it.
  const autoFile = `${DIR}/auto-${nonce}.txt`;
  await step("2b-do-write-and-signal", async () => {
    await deps.fs.writeFile(autoFile, `auto-${nonce}\n`);
    deps.signal();
    return { autoFile };
  });
  await step("2b-pty-poll-until-seen", async () => {
    const start = Date.now();
    for (let i = 0; i < 40; i++) {
      const ran = await shell.run(`test -f ${autoFile} && cat ${autoFile}`);
      if (ran.status === "0") return { seenAfterMs: Date.now() - start, ran };
      await sleep(250);
    }
    return { seen: false, afterMs: Date.now() - start };
  });

  // 2c. inotify in the PTY process for a DO write (the file-change signal should wake it).
  await step("2c-inotify-available", () => shell.run("command -v inotifywait || echo none"));

  // 3. The PTY process writes → pull → the Worker Shell side reads it.
  const ptyFile = `${DIR}/from-pty-${nonce}.txt`;
  await step("3-pty-write", () => shell.run(`echo hello-from-pty-${nonce} > ${ptyFile} && sync`));
  await step("3-do-exists-before-pull", () => deps.fs.exists(ptyFile));
  await step("3-pull", async () => (await timed(deps.pull)).ms);
  await step("3-do-read-after-pull", async () =>
    (await deps.fs.exists(ptyFile)) ? deps.fs.readFile(ptyFile, "utf8") : "MISSING",
  );

  // 4. Delete and rename (and a new directory) in the PTY process → pull.
  const renamed = `${DIR}/renamed-${nonce}.txt`;
  await step("4-pty-delete-rename-mkdir", () =>
    shell.run(
      `rm ${doFile} && mv ${ptyFile} ${renamed} && mkdir -p ${DIR}/dir-${nonce}/sub && echo nested > ${DIR}/dir-${nonce}/sub/f.txt`,
    ),
  );
  await step("4-pull", async () => (await timed(deps.pull)).ms);
  await step("4-do-after-pull", async () => ({
    deletedGone: !(await deps.fs.exists(doFile)),
    renameSourceGone: !(await deps.fs.exists(ptyFile)),
    renamedTarget: (await deps.fs.exists(renamed))
      ? await deps.fs.readFile(renamed, "utf8")
      : "MISSING",
    nested: (await deps.fs.exists(`${DIR}/dir-${nonce}/sub/f.txt`))
      ? await deps.fs.readFile(`${DIR}/dir-${nonce}/sub/f.txt`, "utf8")
      : "MISSING",
  }));

  // 4b. Does a computer command's own pull (after it) bring a PTY write too?
  const viaCommand = `${DIR}/via-command-${nonce}.txt`;
  await step("4b-pty-write", () => shell.run(`echo via-command > ${viaCommand}`));
  await step("4b-computer-command", () => deps.runOnContainer("true"));
  await step("4b-do-exists-after-command", () => deps.fs.exists(viaCommand));

  // 4c. Conflict: both sides change one file between syncs.
  const both = `${DIR}/both-${nonce}.txt`;
  await step("4c-conflict", async () => {
    await deps.fs.writeFile(both, "base\n");
    await deps.push();
    await shell.run(`echo container-side > ${both}`);
    await deps.fs.writeFile(both, "do-side\n");
    await deps.pull();
    const afterPull = await deps.fs.readFile(both, "utf8");
    await deps.push();
    const container = await shell.run(`cat ${both}`);
    return { afterPull, container };
  });

  // Timings of a push and a pull of nothing.
  await step("5-push-pull-of-nothing", async () => {
    const push: number[] = [];
    const pull: number[] = [];
    for (let i = 0; i < 5; i++) {
      push.push((await timed(deps.push)).ms);
      pull.push((await timed(deps.pull)).ms);
    }
    return { push, pull };
  });

  // kill(): an interactive bash ignores SIGTERM; does kill() reach it and its children?
  await step("kill-background-child", async () => {
    const child = await shell.run("sleep 777 & echo child=$!");
    const killed = await timed(async () => {
      shell.process.kill();
      return within(shell.process.exitCode, 3_000);
    });
    let killed9: unknown;
    if (killed.value === "timeout") {
      shell.process.kill(9);
      killed9 = await within(shell.process.exitCode, 3_000);
    }
    await sleep(300);
    const ps = await execOutput(container(), [
      "bash",
      "-c",
      "ps -eo pid,pgid,stat,cmd | grep '[s]leep 777' || echo 'no sleep 777'",
    ]);
    return { child, killDefault: killed, killed9, ps };
  });

  await step("kill-session-from-another-exec", async () => {
    const process = await container().exec(["bash", "-i"], { pty: { cols: 80, rows: 24 } });
    const p = new Pty(process);
    const sid = await p.run("sleep 780 & (sleep 781 &); echo SID=$(ps -o sid= -p $$ | tr -d ' ')");
    const innerSid = /SID=(\d+)/.exec(sid.output.split("\n").slice(-3).join("\n"))?.[1] ?? "none";
    const killer = await execOutput(container(), [
      "bash",
      "-c",
      `sid=${innerSid}; echo "exec pid=${process.pid} inner sid=$sid"; pkill -KILL -s "$sid"; sleep 0.3; ps -eo pid,pgid,sid,cmd | grep -E '[s]leep 78(0|1)|[b]ash -i' || echo 'none left'`,
    ]);
    return { sid, killer, exit: await within(process.exitCode, 3_000) };
  });

  await step("env-option-replaces-or-merges", () =>
    execOutput(container(), ["bash", "-c", ENV_NAMES], { env: { PATH: "/usr/bin:/bin", PROBE: "1" } }),
  );
  await step("env-option-pty", async () => {
    const process = await container().exec(["bash", "--norc", "-i"], {
      pty: { cols: 80, rows: 24 },
      env: { PATH: "/usr/bin:/bin", PROBE: "1", TERM: "xterm-256color" },
    });
    const p = new Pty(process);
    const ran = await p.run(ENV_NAMES);
    process.kill(9);
    return ran;
  });

  await step("exit-code", async () => {
    const process = await container().exec(["bash", "-i"], { pty: { cols: 80, rows: 24 } });
    const p = new Pty(process);
    await p.write("exit 3\n");
    return { exitCode: await within(process.exitCode, 5_000) };
  });

  await step("non-pty-kill-group", async () => {
    const process = await container().exec(["bash", "-c", "sleep 778 & sleep 779; wait"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await sleep(500);
    process.kill();
    const exit = await within(process.exitCode, 3_000);
    await sleep(300);
    const ps = await execOutput(container(), [
      "bash",
      "-c",
      "ps -eo pid,pgid,stat,cmd | grep -E '[s]leep 77(8|9)' || echo 'none left'",
    ]);
    return { exit, ps };
  });

  return { op, nonce, steps };
};
