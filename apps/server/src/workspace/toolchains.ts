// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004), as a
// wrapper around computer's `ContainerBackend`:
//
// - Before the first command of each Container start, the bootstrap runs (`mise install` from the Workspace's lockfile,
//   git's identity and credentials). It goes through the backend's own shell, so it runs after computer has pushed the
//   Workspace's files to the Container (which a command is always preceded by) and before the command itself.
// - Every command's environment carries the GitHub token and the temp directory that stays on the ignored side
//   (`toolchainEnv`), under what the caller passes.
//
// The token is bound to the Workspaces Worker as a secret. It reaches the Container only in a process's environment:
// no file holds it, and nothing here logs it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalTimers:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { inBash } from "@cloudpid/computer-env/shell";
import {
  bootstrapScript,
  type CommandEnv,
  toolchainEnv,
  WORKSPACE_ROOT,
} from "@cloudpid/sandbox-image/toolchains";

type Shell = BackendHandle["rpc"]["shell"];

/** How long the bootstrap may run: a cold install downloads every Toolchain. */
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;

/** After a failed bootstrap, how long before the next command tries it again. */
const RETRY_AFTER_MS = 60_000;

/** How much of a failed bootstrap's output is reported. */
const REPORTED_OUTPUT = 2_000;

export type ToolchainOptions = {
  /** The Container's backend, which the Workspace would otherwise use as it is. */
  readonly backend: WorkspaceBackend;
  /** The GitHub token for git and gh; without one commands run without it. */
  readonly githubToken?: string | undefined;
  /** The identity of commits the agent makes, where the Container has no other; unset parts take the bootstrap's own. */
  readonly git: { readonly name?: string | undefined; readonly email?: string | undefined };
  /** Where a failed bootstrap is reported (never with the token). */
  readonly warn: (message: string) => void;
  readonly now: () => number;
};

export class ToolchainBackend implements WorkspaceBackend {
  readonly #options: ToolchainOptions;
  readonly #env: CommandEnv;
  /** The Container run the bootstrap last finished in: a new connection to the same Container needs none. */
  #bootstrapped: string | undefined;

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

  #rpc(handle: BackendHandle): BackendHandle["rpc"] {
    const shell = handle.rpc.shell;

    const ready = new Bootstrap(
      () => this.#bootstrap(shell),
      this.#options.now,
      handle.runtimeId !== undefined && handle.runtimeId === this.#bootstrapped,
      () => {
        this.#bootstrapped = handle.runtimeId;
      },
    );

    const wrapped: Shell = {
      exec: async (input) => {
        await ready.ensure();

        return shell.exec({ ...input, env: { ...this.#env, ...input.env } });
      },
      getExec: (input) => shell.getExec(input),
      killExec: (input) => shell.killExec(input),
      disposeExec: (input) => shell.disposeExec(input),
    };

    return {
      get sync() {
        return handle.rpc.sync;
      },
      shell: wrapped,
    };
  }

  /** Run the bootstrap on `shell`; whether it succeeded. It reports a failure itself and never throws. */
  async #bootstrap(shell: Shell): Promise<boolean> {
    const { githubToken, git, warn } = this.#options;
    const identity: CommandEnv = {};

    if (git.name !== undefined && git.name !== "") identity.CLOUDPID_GIT_NAME = git.name;

    if (git.email !== undefined && git.email !== "") identity.CLOUDPID_GIT_EMAIL = git.email;

    const secrets = githubToken === undefined || githubToken === "" ? [] : [githubToken];

    const redact = (text: string) =>
      secrets.reduce((out, secret) => out.replaceAll(secret, "***"), text);

    try {
      const execution = await shell.exec({
        id: crypto.randomUUID(),
        source: inBash(bootstrapScript(WORKSPACE_ROOT)),
        cwd: WORKSPACE_ROOT,
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
        env: { ...this.#env, ...identity },
      });

      const { code, output } = await drain(execution.events);

      await shell.disposeExec({ id: execution.id }).catch(() => undefined);

      if (code === 0) return true;

      const reason =
        code === undefined ? "its output ended without an exit status" : `exit status ${code}`;

      warn(`Toolchain bootstrap failed (${reason}): ${redact(output)}`);
    } catch (cause) {
      warn(`Toolchain bootstrap failed: ${redact(String(cause))}`);
    }

    return false;
  }
}

/** Runs a bootstrap once, for the commands that wait on it, and again a minute after a failure. */
class Bootstrap {
  readonly #run: () => Promise<boolean>;
  readonly #now: () => number;
  readonly #onDone: () => void;
  #done: boolean;
  #inflight: Promise<void> | undefined;
  #failedAt: number | undefined;

  constructor(run: () => Promise<boolean>, now: () => number, done: boolean, onDone: () => void) {
    this.#run = run;
    this.#now = now;
    this.#done = done;
    this.#onDone = onDone;
  }

  /** Resolves when a command may be sent: the bootstrap is done, or has failed (a command is not held for it). */
  ensure(): Promise<void> {
    if (this.#done) return Promise.resolve();

    if (this.#inflight !== undefined) return this.#inflight;

    if (this.#failedAt !== undefined && this.#now() - this.#failedAt < RETRY_AFTER_MS) {
      return Promise.resolve();
    }

    const inflight = this.#run()
      .then((ok) => {
        if (ok) {
          this.#done = true;
          this.#failedAt = undefined;
          this.#onDone();
        } else {
          this.#failedAt = this.#now();
        }
      })
      .finally(() => {
        this.#inflight = undefined;
      });

    this.#inflight = inflight;

    return inflight;
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
