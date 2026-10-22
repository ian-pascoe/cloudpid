// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004), as a
// wrapper around computer's `ContainerBackend`:
//
// - Before the first command of each Container start, the bootstrap runs (`mise install` from the Workspace's lockfile,
//   git's identity and credentials). It goes through the backend's own shell, so it runs after computer has pushed the
//   Workspace's files to the Container (which a command is always preceded by) and before the command itself. A command
//   that waits for a bootstrap that failed starts with a note on stderr saying so, and a command killed while it waits
//   is not run.
// - Every command's environment carries mise's settings and the GitHub token (`toolchainEnv`), under what the caller
//   passes, and the token is taken out of what a command prints.
//
// The token is bound to the Workspaces Worker as a secret. It reaches the Container only in a process's environment:
// no file holds it, and nothing here logs it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalTimers:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { inBash, quote } from "@cloudpid/computer-env/shell";
import {
  bootstrapScript,
  type CommandEnv,
  toolchainEnv,
  WORKSPACE_ROOT,
} from "@cloudpid/sandbox-image/toolchains";
import { Redactor } from "./redact.ts";

type Shell = BackendHandle["rpc"]["shell"];

type Execution = Awaited<ReturnType<Shell["exec"]>>;

type ExecEvent = Execution["events"] extends ReadableStream<infer Event> ? Event : never;

/** How long the bootstrap may run: a cold install downloads every Toolchain. */
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;

/** After a failed bootstrap, how long before the next command tries it again; each further failure doubles it. */
const RETRY_AFTER_MS = 60_000;

/** The longest wait between attempts: under the Container's idle stop, so a long-lived Container tries now and then. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;

/** How much of a failed bootstrap's output is reported. */
const REPORTED_OUTPUT = 2_000;

/** The exit status a command gets that was killed before it started (what a SIGTERM leaves). */
const KILLED_STATUS = 143;

export type ToolchainOptions = {
  /** The Container's backend, which the Workspace would otherwise use as it is. */
  readonly backend: WorkspaceBackend;
  /** The GitHub token for git and gh; without one commands run without it. */
  readonly githubToken?: string | undefined;
  /** The identity of commits the agent makes, where the Container has no other; unset parts take the bootstrap's own. */
  readonly git: { readonly name?: string | undefined; readonly email?: string | undefined };
  /**
   * Runs once a bootstrap has succeeded, before the commands that waited for it are sent: the Workspace snapshots the
   * Container's disk here, while nothing else is writing to it. A failure is reported and changes nothing.
   */
  readonly afterInstall?: (() => Promise<void>) | undefined;
  /**
   * The directories the Workspace holds read-only (absolute paths), which the Container makes read-only too so a write
   * there fails instead of staying on the Container. Empty where the Container's `/workspace` is not a real mount.
   */
  readonly readOnlyDirectories?: readonly string[] | undefined;
  /** Where a failed bootstrap is reported (never with the token). */
  readonly warn: (message: string) => void;
  readonly now: () => number;
};

export class ToolchainBackend implements WorkspaceBackend {
  readonly #options: ToolchainOptions;
  readonly #env: CommandEnv;
  /** The Container run the bootstrap last finished in: a new connection to the same Container needs none. */
  #bootstrapped: string | undefined;
  /** The bootstrap of the connection made last, for `runBootstrap`. */
  #latest: Bootstrap | undefined;

  constructor(options: ToolchainOptions) {
    this.#options = options;
    this.#env = toolchainEnv({ githubToken: options.githubToken });
  }

  get id() {
    return this.#options.backend.id;
  }

  get type() {
    return this.#options.backend.type;
  }

  get description() {
    return this.#options.backend.description ?? "";
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const handle = await this.#options.backend.connect(host);

    return { ...handle, rpc: this.#rpc(handle) };
  }

  /**
   * Run the bootstrap of the connection made last, if it has not run, without a command (the early start: docs/spec.md
   * → Backends). A command that arrives meanwhile waits for this one. It never throws: a failure is reported, and starts
   * no wait before the next attempt, so the first command bootstraps as it would have without the early start. Without
   * a connection it does nothing.
   */
  async runBootstrap(): Promise<void> {
    await this.#latest?.ensure({ backoff: false });
  }

  /** The token, if there is one, as the strings to take out of output. */
  get #secret(): string | undefined {
    const { githubToken } = this.#options;

    return githubToken === undefined || githubToken === "" ? undefined : githubToken;
  }

  #rpc(handle: BackendHandle): BackendHandle["rpc"] {
    const shell = handle.rpc.shell;
    const secret = this.#secret;

    const ready = new Bootstrap(
      () => this.#bootstrap(shell),
      this.#options.now,
      handle.runtimeId !== undefined && handle.runtimeId === this.#bootstrapped,
      () => {
        this.#bootstrapped = handle.runtimeId;
      },
    );

    this.#latest = ready;

    /** Commands waiting for the bootstrap, and those among them killed meanwhile: computerd cannot kill what it has not started. */
    const waiting = new Set<string>();
    const killed = new Set<string>();

    const wrapped: Shell = {
      exec: async (input) => {
        const id = input.id;

        if (id !== undefined) waiting.add(id);

        const note = await ready.ensure();

        if (id !== undefined) {
          waiting.delete(id);

          if (killed.delete(id)) return stoppedBeforeStart(id);
        }

        const source =
          note === undefined ? input.source : `printf '%s\\n' ${quote(note)} >&2\n${input.source}`;

        return withRedactedOutput(
          await shell.exec({ ...input, source, env: { ...this.#env, ...input.env } }),
          secret,
        );
      },
      getExec: async (input) => withRedactedOutput(await shell.getExec(input), secret),
      killExec: (input) => {
        if (waiting.has(input.id)) {
          killed.add(input.id);

          return Promise.resolve();
        }

        return shell.killExec(input);
      },
      disposeExec: (input) => shell.disposeExec(input),
    };

    return {
      get sync() {
        return handle.rpc.sync;
      },
      shell: wrapped,
    };
  }

  /** The after-install hook, which never throws: a snapshot is an optimisation. */
  async #installed(): Promise<void> {
    const { afterInstall, warn } = this.#options;

    try {
      await afterInstall?.();
    } catch (cause) {
      warn(
        `After the Toolchain install: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
  }

  /** Run the bootstrap on `shell`; what went wrong, if anything. It reports a failure itself and never throws. */
  async #bootstrap(shell: Shell): Promise<Failure | undefined> {
    const { git, warn } = this.#options;
    const secret = this.#secret;
    const identity: CommandEnv = {};

    if (git.name !== undefined && git.name !== "") identity.CLOUDPID_GIT_NAME = git.name;

    if (git.email !== undefined && git.email !== "") identity.CLOUDPID_GIT_EMAIL = git.email;

    const redact = (text: string) => (secret === undefined ? text : text.replaceAll(secret, "***"));

    try {
      const execution = await shell.exec({
        id: crypto.randomUUID(),
        source: inBash(bootstrapScript(WORKSPACE_ROOT, this.#options.readOnlyDirectories)),
        cwd: WORKSPACE_ROOT,
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
        env: { ...this.#env, ...identity },
      });

      const { code, output } = await drain(execution.events);

      await shell.disposeExec({ id: execution.id }).catch(() => undefined);

      if (code === 0) {
        await this.#installed();

        return undefined;
      }

      const reason =
        code === undefined ? "its output ended without an exit status" : `exit status ${code}`;

      warn(`Toolchain bootstrap failed (${reason}): ${redact(output)}`);

      return { reason, output: redact(output) };
    } catch (cause) {
      warn(`Toolchain bootstrap failed: ${redact(String(cause))}`);

      return { reason: "it could not run", output: redact(String(cause)) };
    }
  }
}

/** Why a bootstrap failed: in a few words, and what it printed (without the token). */
type Failure = { readonly reason: string; readonly output: string };

/**
 * Runs a bootstrap once, for the commands that wait on it, and again after a failure once its wait is over: a minute,
 * doubling with each failure in a row. Each command gets a note while the last attempt failed: the output for those
 * that waited for it, and a pointer for those that come after.
 */
class Bootstrap {
  readonly #run: () => Promise<Failure | undefined>;
  readonly #now: () => number;
  readonly #onDone: () => void;
  #done: boolean;
  #inflight: Promise<string | undefined> | undefined;
  #failedAt: number | undefined;
  #failures = 0;
  #reason = "";

  constructor(
    run: () => Promise<Failure | undefined>,
    now: () => number,
    done: boolean,
    onDone: () => void,
  ) {
    this.#run = run;
    this.#now = now;
    this.#done = done;
    this.#onDone = onDone;
  }

  /**
   * Resolves when a command may be sent: the bootstrap is done, or has failed (a command is not held for it). With
   * the note the command starts with, if the bootstrap has failed. A failure of an attempt made with `backoff: false`
   * (the early start's, which no command asked for) starts no wait: the next command tries again.
   */
  ensure({ backoff = true }: { readonly backoff?: boolean } = {}): Promise<string | undefined> {
    if (this.#done) return Promise.resolve(undefined);

    if (this.#inflight !== undefined) return this.#inflight;

    if (this.#failedAt !== undefined && this.#now() - this.#failedAt < this.#wait()) {
      return Promise.resolve(
        `cloudpid: the Toolchain bootstrap failed earlier (${this.#reason}), so git, gh and other Toolchains may be missing. It is retried automatically; run \`mise install\` to see why.`,
      );
    }

    const inflight = this.#run()
      .then((failure) => {
        if (failure === undefined) {
          this.#done = true;
          this.#failedAt = undefined;
          this.#failures = 0;
          this.#onDone();

          return undefined;
        }

        if (backoff) {
          this.#failedAt = this.#now();
          this.#failures++;
          this.#reason = failure.reason;
        }

        return `cloudpid: the Toolchain bootstrap failed (${failure.reason}), so git, gh and other Toolchains may be missing: ${failure.output}\nRun \`mise install\` to see more. It is retried automatically.`;
      })
      .finally(() => {
        this.#inflight = undefined;
      });

    this.#inflight = inflight;

    return inflight;
  }

  /** How long after the last failure the next attempt waits. */
  #wait(): number {
    return Math.min(RETRY_AFTER_MS * 2 ** (this.#failures - 1), MAX_RETRY_AFTER_MS);
  }
}

/** A command's exit status (if it ended with one) and the end of its output. */
const drain = async (
  stream: ReadableStream<{
    readonly name: string;
    readonly value?: Uint8Array;
    readonly code?: number;
  }>,
): Promise<{ code: number | undefined; output: string }> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  let code: number | undefined;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    const event = next.value;

    if (event.name === "exit") code = event.code;
    else if (event.value !== undefined)
      output = (output + decoder.decode(event.value, { stream: true })).slice(-REPORTED_OUTPUT);
  }

  return { code, output: output.trim() };
};

/** What a command killed while it waited for the bootstrap answers: it never started, and it ended. */
const stoppedBeforeStart = (id: string): Execution => ({
  id,
  events: new ReadableStream({
    start(controller) {
      controller.enqueue({ id, seq: 0, name: "exit", code: KILLED_STATUS });
      controller.close();
    },
  }),
});

/**
 * `execution` with `secret` taken out of its output. What it holds back at the end of a stream (the start of the
 * secret, which turned out not to be one) comes out just before the exit. Without a secret it is `execution` itself.
 */
const withRedactedOutput = (execution: Execution, secret: string | undefined): Execution => {
  if (secret === undefined) return execution;

  const redactors = { stdout: new Redactor(secret), stderr: new Redactor(secret) };
  let last: { id: string; seq: number } | undefined;

  const release = (controller: TransformStreamDefaultController<ExecEvent>) => {
    if (last === undefined) return;

    for (const name of ["stdout", "stderr"] as const) {
      const value = redactors[name].flush();

      if (value.length > 0) controller.enqueue({ ...last, name, value });
    }
  };

  const events = execution.events.pipeThrough(
    new TransformStream<ExecEvent, ExecEvent>({
      transform(event, controller) {
        last = { id: event.id, seq: event.seq };

        if (event.name === "exit") {
          release(controller);
          controller.enqueue(event);

          return;
        }

        const value = redactors[event.name].push(event.value);

        if (value.length > 0) controller.enqueue({ ...event, value });
      },
      flush: release,
    }),
  );

  // The execution may be an RPC stub that its consumer disposes: the redacted one disposes it in turn.
  return Object.assign(
    { id: execution.id, events },
    {
      [Symbol.dispose]: () =>
        // SAFETY: an RPC execution may carry `Symbol.dispose`; a plain one has none, which the optional call covers.
        (execution as Partial<Disposable>)[Symbol.dispose]?.(),
    },
  );
};
