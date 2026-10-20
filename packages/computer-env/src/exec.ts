// `ExecutionEnv.exec` on the Workspace's runtime, through `@cloudflare/computer`'s own RPC client. Every Workspace
// client and exec handle it takes is disposed (computer's stub-disposal contract), including when a timeout or an
// abort returns before the command has stopped.
//
// On the Worker Shell (just-bash in a Dynamic Worker) a command's output arrives once, when it exits: `onOutput` then
// gets all of stdout and then all of stderr, attributed but not interleaved in arrival order. Backends that stream
// (the Container) deliver chunks as they come.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalDate:off globalTimers:off missingPipeableSignature:off newPromise:off preferEffectArray:off
import {
  getWorkspace,
  type RuntimeExecOptions,
  shellQuote,
  type WorkspaceClient,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  type ExecutionErrorCode,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { BackendTarget } from "./env.ts";
import { resolve } from "./paths.ts";

/** How long a killed command may take to stop before `exec` returns without it. */
const KILL_GRACE_MS = 500;

/** How often a kill is repeated while the command has not stopped: the first can arrive before the command starts. */
const KILL_RETRY_MS = 100;

/** Writes a command's complete output to a file, for output past the spill thresholds. */
export type SpillWriter = (output: string) => Promise<string | undefined>;

/** A command and the script the Workspace's shell runs for it. */
type Prepared = { readonly source: string; readonly marker: string | undefined };

/**
 * An argv runs without shell parsing: each argument is quoted. A missing program fails with a marker on stderr, so it
 * can be told from a program that exits 127 itself.
 */
const prepare = (command: string | readonly string[]): Prepared | undefined => {
  if (!(command instanceof Array)) return { source: command, marker: undefined };

  const [program] = command;

  if (program === undefined) return undefined;

  const marker = `computer-env: no such program ${crypto.randomUUID()}`;

  const source = [
    `command -v ${shellQuote(program)} >/dev/null 2>&1 || { printf '%s' ${shellQuote(marker)} >&2; exit 127; }`,
    command.map((argument) => shellQuote(argument)).join(" "),
  ].join("\n");

  return { source, marker };
};

/** Whether `context` was aborted; a call, so a check after an `await` is not narrowed away by one before it. */
const isAborted = (context: Context): boolean => context.abortSignal?.aborted === true;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Counts output against the spill thresholds and keeps all of it once they are crossed. */
class Spill {
  readonly #options: ShellExecOptions["spill"];
  readonly #chunks: string[] = [];
  #bytes = 0;
  #lines = 0;
  #spilled = false;

  constructor(options: ShellExecOptions["spill"]) {
    this.#options = options;
  }

  push(text: string): void {
    if (this.#options === undefined) return;
    this.#chunks.push(text);
    this.#bytes += new TextEncoder().encode(text).length;
    this.#lines += text.split("\n").length - 1;

    const partial = text.endsWith("\n") ? 0 : 1;

    this.#spilled ||=
      this.#bytes > this.#options.afterBytes || this.#lines + partial > this.#options.afterLines;
  }

  async write(writer: SpillWriter): Promise<string | undefined> {
    return this.#spilled ? writer(this.#chunks.join("")) : undefined;
  }
}

export type ExecHost = {
  readonly workspace: WorkspaceHandle;
  /** The backend to run on; undefined runs on the Workspace's default backend. */
  readonly backend: BackendTarget | undefined;
  readonly cwd: string;
  readonly spill: SpillWriter;
  /** Executions still running, so `cleanup()` can kill them. */
  readonly running: Set<string>;
};

/** Run `command` on the host's backend, streaming its output to `options.onOutput`. */
export const exec = async (
  host: ExecHost,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> => {
  if (isAborted(context)) return err(new ExecutionError("aborted", "aborted"));

  const prepared = prepare(command);

  if (prepared === undefined) return err(new ExecutionError("spawn_error", "Empty command"));

  let workspace: WorkspaceClient;

  try {
    workspace = await getWorkspace(host.workspace);
  } catch (cause) {
    return err(new ExecutionError("shell_unavailable", String(cause)));
  }

  // An abort while the client was being acquired fired before any listener could see it.
  if (isAborted(context)) {
    workspace[Symbol.dispose]();

    return err(new ExecutionError("aborted", "aborted"));
  }

  const id = crypto.randomUUID();
  const spill = new Spill(options?.spill);
  let stopped: ExecutionErrorCode | undefined;
  let returned = false;
  let started = false;
  let missing = false;
  let callbackError: ExecutionError | undefined;
  const stop = Promise.withResolvers<void>();

  const kill = (reason: ExecutionErrorCode) => {
    if (stopped !== undefined) return;
    stopped = reason;
    stop.resolve();
  };

  const deliver = (text: string, stream: "stdout" | "stderr") => {
    if (returned || text === "") return;
    spill.push(text);

    if (callbackError !== undefined) return;

    try {
      options?.onOutput?.(text, context, { stream });
    } catch (cause) {
      // As in pi-durable's own environments: a failing output sink kills the command.
      const error = cause instanceof Error ? cause : new Error(String(cause));

      callbackError = new ExecutionError("callback_error", error.message, error);
      kill("callback_error");
    }
  };

  const run = async (): Promise<number> => {
    const execOptions: RuntimeExecOptions & { encoding: "utf8" } = {
      id,
      cwd: resolve(host.cwd, options?.cwd ?? "."),
      encoding: "utf8",
      // The caller bounds and saves output itself.
      output: false,
    };

    if (options?.env !== undefined) execOptions.env = options.env;

    if (host.backend !== undefined) execOptions.backend = host.backend.id;

    using handle = await workspace.runtime.exec(
      host.backend === undefined ? prepared.source : host.backend.script(prepared.source),
      execOptions,
    );

    started = true;

    let exitCode: number | undefined;

    for await (const event of handle) {
      if (event.name === "exit") exitCode = event.code;
      else if (
        event.name === "stderr" &&
        prepared.marker !== undefined &&
        event.value.startsWith(prepared.marker)
      ) {
        missing = true;
        deliver(event.value.slice(prepared.marker.length), "stderr");
      } else deliver(event.value, event.name);
    }

    if (exitCode === undefined)
      throw new Error("The command's output ended without an exit status");

    return exitCode;
  };

  const timeout =
    options?.timeout === undefined
      ? undefined
      : setTimeout(() => kill("timeout"), options.timeout * 1000);

  const onAbort = () => kill("aborted");

  context.abortSignal?.addEventListener("abort", onAbort, { once: true });

  host.running.add(id);

  const execution = run().then(
    (exitCode) => ({ ok: true as const, exitCode }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );

  // A command that outlives its kill grace period still releases its stubs when it ends.
  const finish = execution.finally(() => {
    host.running.delete(id);
    workspace[Symbol.dispose]();
  });

  try {
    const first = await Promise.race([execution, stop.promise]);

    if (first !== undefined && stopped === undefined) {
      // `spawn_error` tells the caller the command never started, so it may try another form of it.
      if (!first.ok) {
        return err(new ExecutionError(started ? "unknown" : "spawn_error", String(first.cause)));
      }

      if (missing) {
        return err(new ExecutionError("spawn_error", `No such program: ${String(command[0])}`));
      }

      const spillPath = await spill.write(host.spill);

      return ok(
        spillPath === undefined
          ? { exitCode: first.exitCode }
          : { exitCode: first.exitCode, spillPath },
      );
    }

    // Killed: wait briefly for the command to stop; a kill sent before it started is sent again.
    const deadline = Date.now() + KILL_GRACE_MS;

    while (Date.now() < deadline) {
      await workspace.runtime.killExec(id).catch(() => undefined);

      if (
        (await Promise.race([finish.then(() => true), sleep(KILL_RETRY_MS).then(() => false)])) ===
        true
      )
        break;
    }

    if (callbackError !== undefined) return err(callbackError);

    const error = new ExecutionError(
      stopped ?? "aborted",
      stopped === "timeout" ? "Command timed out" : "aborted",
    );

    const spillPath = await spill.write(host.spill);

    if (spillPath !== undefined) error.spillPath = spillPath;

    return err(error);
  } finally {
    returned = true;
    clearTimeout(timeout);
    context.abortSignal?.removeEventListener("abort", onAbort);
  }
};

/** Kill every execution in `running`, for an environment's shutdown. */
export const killAll = async (workspace: WorkspaceHandle, running: Set<string>): Promise<void> => {
  if (running.size === 0) return;

  using client = await getWorkspace(workspace);

  await Promise.all([...running].map((id) => client.runtime.killExec(id).catch(() => undefined)));
};
