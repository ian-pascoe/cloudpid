// The image's entrypoint (docs/architecture/container.md → Exit reports): computerd's output passes through,
// and when computerd exits on its own its last lines reach the report host. The script runs for real, under bash,
// around a fake computerd, and reports to a local HTTP server standing in for the Workspace DO's intercept.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off asyncFunction:off globalDate:off newPromise:off
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import { MEMORY_GUARD_AVOID } from "@cloudpid/sandbox-image/memory-guard";
import {
  EXIT_REPORT_BASE64_MARKER,
  EXIT_REPORT_BASE64_MIN,
  EXIT_REPORT_BYTES,
  EXIT_REPORT_HOST,
  EXIT_REPORT_LINES,
  EXIT_REPORT_PATH,
} from "@cloudpid/sandbox-image/supervisor";

const script = join(sandboxImageContext, "supervise");
const source = readFileSync(script, "utf8");
const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");

type Report = { readonly method: string; readonly path: string; readonly body: string };

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A server that records what it is sent, as the Workspace DO's intercept would receive it. */
const reportServer = async () => {
  const reports: Report[] = [];

  const server = createServer((request: IncomingMessage, response) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      reports.push({ method: request.method ?? "", path: request.url ?? "", body });
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());

  // SAFETY: a server listening on a TCP port has an `AddressInfo` address.
  return { reports, port: (server.address() as AddressInfo).port };
};

/** A fake computerd: a bash script doing `behaviour`. */
const fakeComputerd = (behaviour: string) => {
  const dir = mkdtempSync(join(tmpdir(), "supervise-"));
  const path = join(dir, "computerd");

  writeFileSync(path, `#!/bin/bash\n${behaviour}\n`);
  chmodSync(path, 0o755);

  return path;
};

type Run = { readonly status: number | null; readonly stdout: string };

const supervise = (
  computerd: string,
  port: number,
  signal?: NodeJS.Signals,
  env: Record<string, string> = {},
) =>
  new Promise<Run>((resolve) => {
    const child = spawn("bash", [script], {
      env: {
        PATH: process.env.PATH,
        CLOUDPID_COMPUTERD: computerd,
        CLOUDPID_REPORT_HOST: "127.0.0.1",
        CLOUDPID_REPORT_PORT: String(port),
        // No memory guard unless a test gives one, whatever the machine has installed.
        CLOUDPID_MEMORY_GUARD: "/nonexistent/cloudpid-memory-guard",
        CLOUDPID_EARLYOOM: "/nonexistent/earlyoom",
        CLOUDPID_MEMORY_NOTES: join(mkdtempSync(join(tmpdir(), "memory-notes-")), "notes"),
        ...env,
      },
    });

    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;

      // Stop the supervisor once computerd is up, as the platform does.
      if (signal !== undefined && stdout.includes("ready")) child.kill(signal);
    });
    child.on("close", (status) => resolve({ status, stdout }));
  });

describe("the supervisor", () => {
  it("is the image's entrypoint, and computerd runs under it", () => {
    expect(dockerfile).toMatch(
      /^COPY --chmod=755 supervise \/usr\/local\/bin\/cloudpid-supervise$/m,
    );
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/cloudpid-supervise"\]$/m);
    expect(source).toContain("${CLOUDPID_COMPUTERD:-/usr/local/bin/computerd}");
  });

  it("reports where the Workspace DO listens, with as much as it keeps", () => {
    expect(source).toContain(`\${CLOUDPID_REPORT_HOST:-${EXIT_REPORT_HOST}}`);
    expect(source).toContain(`report_path=${EXIT_REPORT_PATH}\n`);
    expect(source).toContain(`keep_lines=${EXIT_REPORT_LINES}\n`);
    expect(source).toContain(`keep_bytes=${EXIT_REPORT_BYTES}\n`);
    expect(source).toContain(`base64_min=${EXIT_REPORT_BASE64_MIN}\n`);
    expect(source).toContain(`base64_marker='${EXIT_REPORT_BASE64_MARKER}'\n`);
  });

  it("passes computerd's output through, and posts its status and last lines when it exits on its own", async () => {
    const { reports, port } = await reportServer();

    const computerd = fakeComputerd(
      'for i in $(seq 1 250); do echo "line $i"; done; echo "boom" >&2; exit 3',
    );

    const run = await supervise(computerd, port);

    expect(run.status).toBe(3);
    expect(run.stdout).toContain("line 1\n");
    expect(run.stdout).toContain("line 250\nboom\n");
    expect(reports).toHaveLength(1);

    const [report] = reports;

    expect(report?.method).toBe("POST");
    expect(report?.path).toBe(EXIT_REPORT_PATH);

    const [head, output] = (report?.body ?? "").split("\n\n");

    expect(head).toMatch(/^status=3\nuptime=\d+$/);

    const lines = (output ?? "").trimEnd().split("\n");

    expect(lines).toHaveLength(EXIT_REPORT_LINES);
    expect(lines[0]).toBe("line 52");
    expect(lines.at(-1)).toBe("boom");
  });

  it("collapses data URLs' payloads in the report, so the crash lines survive, and leaves the passthrough alone", async () => {
    const { reports, port } = await reportServer();
    const payloadLength = 200_000;

    // The crash comes first and file contents in data URLs after it, 200 KB a line, the last one cut off without a
    // newline: far more than the report holds, so only collapsing keeps the crash in it.
    const computerd = fakeComputerd(
      [
        `payload=$(head -c ${payloadLength} /dev/zero | tr '\\0' 'A')`,
        'echo "uncaughtException: Error: log 1234: append after exit"',
        'echo "    at EventLog.append (computerd:1:1)"',
        'for i in 1 2 3; do echo "log {\\"url\\":\\"data:image/png;base64,$payload\\",\\"after\\":$i} tail $i"; done',
        'echo "short data:text/plain;base64,QUJD kept"',
        'printf "cut off data:application/pdf;base64,%s" "$payload"',
        "exit 1",
      ].join("\n"),
    );

    const run = await supervise(computerd, port);

    expect(run.status).toBe(1);
    // The Container's log has everything.
    expect(run.stdout).toContain(`data:image/png;base64,${"A".repeat(payloadLength)}`);
    expect(run.stdout).toContain(`data:application/pdf;base64,${"A".repeat(payloadLength)}`);

    const body = reports[0]?.body ?? "";

    expect(body).toContain("uncaughtException: Error: log 1234: append after exit\n");
    expect(body).toContain("    at EventLog.append (computerd:1:1)\n");
    expect(body).toContain(
      `data:image/png;base64,${EXIT_REPORT_BASE64_MARKER}","after":3} tail 3\n`,
    );
    expect(body).toContain("short data:text/plain;base64,QUJD kept\n");
    expect(body.endsWith(`cut off data:application/pdf;base64,${EXIT_REPORT_BASE64_MARKER}`)).toBe(
      true,
    );
    expect(body).not.toContain("AAAAAAAAAA");
  });

  it("reports a computerd that a signal killed, with the shell's status for it", async () => {
    const { reports, port } = await reportServer();
    const computerd = fakeComputerd('echo "going"; kill -KILL $$');

    const run = await supervise(computerd, port);

    expect(run.status).toBe(137);
    expect(reports[0]?.body).toMatch(/^status=137\n/);
  });

  it("stops computerd when it is asked to, and reports nothing", async () => {
    const { reports, port } = await reportServer();
    const computerd = fakeComputerd('trap "exit 0" TERM; echo ready; while :; do sleep 0.1; done');

    const run = await supervise(computerd, port, "SIGTERM");

    expect(run.status).toBe(0);
    expect(reports).toEqual([]);
  });

  it("exits with computerd's status when the report host does not answer", async () => {
    // A port nothing listens on.
    const { port } = await reportServer();

    closers.splice(0).forEach((close) => close());

    const run = await supervise(fakeComputerd("echo bye; exit 1"), port);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("bye\n");
  });

  /** A computerd store, with SQLite's write-ahead log and shared memory files beside it, and a computerd that lists them. */
  const storeOnDisk = () => {
    const dir = mkdtempSync(join(tmpdir(), "computerd-store-"));
    const db = join(dir, "state.db");

    for (const file of [db, `${db}-wal`, `${db}-shm`]) writeFileSync(file, "sync state");

    const computerd = fakeComputerd(
      `for f in "$COMPUTERD_DB" "$COMPUTERD_DB-wal" "$COMPUTERD_DB-shm"; do [ -e "$f" ] && echo "kept \${f##*/}"; done; exit 0`,
    );

    return { db, computerd };
  };

  it("deletes computerd's store before computerd starts when the launch asks for a reset (a Build)", async () => {
    const { port } = await reportServer();
    const { db, computerd } = storeOnDisk();

    const run = await supervise(computerd, port, undefined, {
      COMPUTERD_DB: db,
      CLOUDPID_RESET_STORE: "1",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(db)).toBe(false);
  });

  it("keeps computerd's store otherwise (a Workspace's own snapshot)", async () => {
    const { port } = await reportServer();
    const { db, computerd } = storeOnDisk();

    const run = await supervise(computerd, port, undefined, { COMPUTERD_DB: db });

    expect(run.stdout).toBe("kept state.db\nkept state.db-wal\nkept state.db-shm\n");
  });

  it("does not wait on a process computerd left holding its output", async () => {
    const { reports, port } = await reportServer();
    // A background child keeps computerd's stdout open long after computerd exits.
    const computerd = fakeComputerd('sleep 30 & echo "left one"; exit 2');
    const started = Date.now();

    const run = await supervise(computerd, port);

    expect(run.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(reports[0]?.body).toContain("left one");
  }, 15_000);
});

/** A fake earlyoom: it records its arguments and its pid, says it is up, and runs until it is stopped, as earlyoom does. */
const fakeEarlyoom = () => {
  const dir = mkdtempSync(join(tmpdir(), "earlyoom-"));
  const path = join(dir, "earlyoom");
  const args = join(dir, "args");
  const pid = join(dir, "pid");

  writeFileSync(
    path,
    `#!/bin/bash\nprintf '%s\\n' "$@" >${args}\necho $$ >${pid}\necho "earlyoom up"\nexec sleep 600\n`,
  );
  chmodSync(path, 0o755);

  return { path, args, pid };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** The image's guard, around `earlyoom`. */
const withGuard = (earlyoom: string) => ({
  CLOUDPID_MEMORY_GUARD: join(sandboxImageContext, "cloudpid-memory-guard"),
  CLOUDPID_EARLYOOM: earlyoom,
});

describe("the supervisor's memory guard", () => {
  it("runs the guard beside computerd, its lines where computerd's go, and stops it with computerd", async () => {
    const { reports, port } = await reportServer();
    const earlyoom = fakeEarlyoom();
    // Long enough for the guard to have started.
    const computerd = fakeComputerd('sleep 0.5; echo "computerd out"; exit 1');
    const started = Date.now();

    const run = await supervise(computerd, port, undefined, withGuard(earlyoom.path));

    expect(run.status).toBe(1);
    // earlyoom's arguments are the guard's (`memory-guard.test.ts`).
    expect(readFileSync(earlyoom.args, "utf8")).toContain(`--avoid\n${MEMORY_GUARD_AVOID}\n`);
    // Its lines go where computerd's do: the Container's log and the exit report.
    expect(run.stdout).toContain("earlyoom up\n");
    expect(run.stdout).toContain("computerd out\n");
    expect(reports[0]?.body).toContain("earlyoom up\n");
    // Stopped with computerd, and nothing waited on its output.
    expect(alive(Number(readFileSync(earlyoom.pid, "utf8")))).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("stops the guard too when the supervisor is asked to stop", async () => {
    const { reports, port } = await reportServer();
    const earlyoom = fakeEarlyoom();

    const computerd = fakeComputerd(
      'trap "exit 0" TERM; sleep 0.5; echo ready; while :; do sleep 0.1; done',
    );

    const run = await supervise(computerd, port, "SIGTERM", withGuard(earlyoom.path));

    expect(run.status).toBe(0);
    expect(reports).toEqual([]);
    expect(alive(Number(readFileSync(earlyoom.pid, "utf8")))).toBe(false);
  });

  it("starts computerd all the same where the guard or earlyoom is missing", async () => {
    const { port } = await reportServer();

    for (const env of [{}, withGuard("/nonexistent/earlyoom")]) {
      const run = await supervise(fakeComputerd("echo bye; exit 0"), port, undefined, env);

      expect(run).toEqual({ status: 0, stdout: "bye\n" });
    }
  });

  it("clears the notes a snapshot kept before computerd starts: they are not this Container start's", async () => {
    const { port } = await reportServer();
    const notes = join(mkdtempSync(join(tmpdir(), "memory-notes-")), "notes");

    mkdirSync(notes);
    writeFileSync(join(notes, "1700000000000000"), "an old note");

    const computerd = fakeComputerd(
      '[ -e "$CLOUDPID_MEMORY_NOTES" ] && echo "still there"; exit 0',
    );

    const run = await supervise(computerd, port, undefined, { CLOUDPID_MEMORY_NOTES: notes });

    expect(run.stdout).toBe("");
    expect(existsSync(notes)).toBe(false);
  });
});
