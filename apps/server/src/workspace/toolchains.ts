// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004), as a
// wrapper around computer's `ContainerBackend`:
//
// - Before the first command of each Container start, the bootstrap runs (`mise install` from the Workspace's lockfile,
//   git's identity and credentials). It goes through the backend's own shell, so it runs after computer has pushed the
//   Workspace's files to the Container (which a command is always preceded by) and before the command itself. A command
//   that waits for a bootstrap that failed starts with a note on stderr saying so, and a command killed while it waits
//   is not run.
// - Once the Toolchains are installed, the bootstrap runs each repo's Setup Script (`.agents/setup.sh`) that is due: one
//   whose content has not succeeded on this Container's disk yet. Each is an exec of its own, bounded by 15 minutes. A
//   failed or stopped one does not hold commands back: the first command that starts after it gets a note carrying the
//   end of its output, later ones a pointer to it, and it is due again at the next Container start.
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
  pendingSetupScripts,
  SETUP_SCRIPT,
  SETUP_TIMEOUT_SECONDS,
  setupScriptRun,
  setupScriptTimedOut,
  toolchainEnv,
  WORKSPACE_ROOT,
} from "@cloudpid/sandbox-image/toolchains";
import type { IdleStop } from "./idle.ts";
import { Redactor } from "./redact.ts";

type Shell = BackendHandle["rpc"]["shell"];

type Execution = Awaited<ReturnType<Shell["exec"]>>;

type ExecEvent = Execution["events"] extends ReadableStream<infer Event> ? Event : never;

/** How long the bootstrap may run: a cold install downloads every Toolchain. */
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;

/**
 * How long computer lets a Setup Script's exec run: the script's own limit, which stops it, and a minute for that to
 * happen and the result to come back.
 */
const SETUP_EXEC_TIMEOUT_MS = (SETUP_TIMEOUT_SECONDS + 60) * 1000;

/** How long finding the due Setup Scripts may take: a hash of a file in each repo. */
const SETUP_LIST_TIMEOUT_MS = 60_000;

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
  /**
   * Told when a bootstrap begins and ends, so the Container counts as in use while it runs (the idle stop): a Setup
   * Script can outlast the idle time, and the command that waited for it may have gone.
   */
  readonly activity?: Pick<IdleStop, "begin" | "end"> | undefined;
  /** Where a failed bootstrap or Setup Script is reported (never with the token). */
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
  /**
   * The Setup Scripts that failed at that run's start, if any, and whether a command that started has had the full note:
   * until one has, the next one gets it; after, each gets a pointer to it.
   */
  #setupFailed: { readonly report: SetupReport; seen: boolean } | undefined;

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
      (setup) => {
        this.#bootstrapped = handle.runtimeId;
        this.#setupFailed = setup === undefined ? undefined : { report: setup, seen: false };
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

        const bootstrapNote = await ready.ensure();

        if (id !== undefined) {
          waiting.delete(id);

          if (killed.delete(id)) return stoppedBeforeStart(id);
        }

        const note = bootstrapNote ?? this.#setupNote(handle.runtimeId);

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

  /**
   * What a command that starts in the Container run `runtimeId` is told of the Setup Scripts that failed at its start: the
   * full note if no command that started has had it yet (one that waited may have been killed), else a pointer.
   */
  #setupNote(runtimeId: string | undefined): string | undefined {
    const failed = this.#setupFailed;

    if (failed === undefined || runtimeId !== this.#bootstrapped) return undefined;

    if (failed.seen) return failed.report.pointer;

    failed.seen = true;

    return failed.report.note;
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

  /** `text` without the token. */
  #redact(text: string): string {
    const secret = this.#secret;

    return secret === undefined ? text : text.replaceAll(secret, "***");
  }

  /**
   * How much of an exec's output to keep for its report: the reported length and a token's, so that a token cut by the
   * start of what is kept can be dropped whole (`#tail`).
   */
  get #kept(): number {
    return REPORTED_OUTPUT + (this.#secret?.length ?? 0);
  }

  /**
   * The end of an exec's output to report, kept with `#kept`: without the token, then, if the output was `cut`, without
   * its first token's length of characters (where the rest of a token cut by the start may be), then cut to length.
   */
  #tail({ output, cut }: Ran): string {
    const redacted = this.#redact(output);
    const whole = cut ? redacted.slice(this.#secret?.length ?? 0) : redacted;

    return whole.slice(-REPORTED_OUTPUT).trim();
  }

  /** Why an exec failed, from how it ended. */
  #failure(ran: Ran): Failure {
    return { reason: exitReason(ran.code), output: this.#tail(ran) };
  }

  /** Why an exec failed that could not be run (`cause`). */
  #couldNotRun(cause: unknown): Failure {
    return { reason: "it could not run", output: this.#redact(String(cause)) };
  }

  /** Run the bootstrap on `shell`, the Container counting as in use meanwhile. Never throws. */
  async #bootstrap(shell: Shell): Promise<Outcome> {
    const { activity, warn } = this.#options;

    const log = (cause: unknown) =>
      warn(`idle stop: tracking the bootstrap failed: ${String(cause)}`);

    await activity?.begin().catch(log);

    try {
      return await this.#installAndSetUp(shell);
    } finally {
      await activity?.end().catch(log);
    }
  }

  /**
   * Install the Toolchains, then run the Setup Scripts that are due and the after-install hook, in that order, so a
   * snapshot keeps what the scripts installed (and their time is not the snapshot's). It reports a failure itself.
   */
  async #installAndSetUp(shell: Shell): Promise<Outcome> {
    const { git, warn } = this.#options;
    const identity: CommandEnv = {};

    if (git.name !== undefined && git.name !== "") identity.CLOUDPID_GIT_NAME = git.name;

    if (git.email !== undefined && git.email !== "") identity.CLOUDPID_GIT_EMAIL = git.email;

    let failure: Failure;

    try {
      const ran = await runToEnd(
        shell,
        {
          source: inBash(bootstrapScript(WORKSPACE_ROOT, this.#options.readOnlyDirectories)),
          cwd: WORKSPACE_ROOT,
          timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          env: { ...this.#env, ...identity },
        },
        this.#kept,
      );

      if (ran.code === 0) {
        const setup = await this.#runSetupScripts(shell);

        await this.#installed();

        return { ok: true, setup };
      }

      failure = this.#failure(ran);
    } catch (cause) {
      failure = this.#couldNotRun(cause);
    }

    warn(`Toolchain bootstrap failed (${failure.reason}): ${failure.output}`);

    return { ok: false, failure };
  }

  /**
   * Run each due Setup Script, one after the other, with a command's environment; what to tell commands of those that
   * did not succeed, if any. Never throws.
   */
  async #runSetupScripts(shell: Shell): Promise<SetupReport | undefined> {
    const { warn } = this.#options;
    let due: string[];

    try {
      const listed = await runToEnd(shell, {
        source: inBash(pendingSetupScripts(WORKSPACE_ROOT)),
        cwd: WORKSPACE_ROOT,
        timeoutMs: SETUP_LIST_TIMEOUT_MS,
        env: this.#env,
      });

      if (listed.code !== 0) throw new Error(`${exitReason(listed.code)}: ${listed.output}`);

      due = listed.output.split("\n").filter((line) => line.startsWith(`${WORKSPACE_ROOT}/`));
    } catch (cause) {
      const message = this.#redact(String(cause instanceof Error ? cause.message : cause));

      warn(`Setup Scripts: could not find the due ones: ${message}`);

      return {
        note: `cloudpid: could not tell which repos' Setup Script (${SETUP_SCRIPT}) to run (${message}), so their dependencies may be missing. They are looked for again at the next Container start.`,
        pointer: `cloudpid: the repos' Setup Scripts (${SETUP_SCRIPT}) could not be run at this Container's start, so their dependencies may be missing. They are looked for again at the next Container start.`,
      };
    }

    const notes: string[] = [];
    const failed: string[] = [];

    for (const directory of due) {
      const failure = await this.#runSetupScript(shell, directory);

      if (failure === undefined) continue;

      warn(`Setup Script of ${directory} failed (${failure.reason}): ${failure.output}`);
      failed.push(directory);
      notes.push(
        `cloudpid: the Setup Script ${directory}/${SETUP_SCRIPT} failed (${failure.reason}), so the repo's dependencies may be missing: ${failure.output}\nIt runs again at the next Container start; run \`bash ${SETUP_SCRIPT}\` in ${directory} to try it now.`,
      );
    }

    if (failed.length === 0) return undefined;

    return {
      note: notes.join("\n"),
      pointer: `cloudpid: the Setup Script (${SETUP_SCRIPT}) of ${failed.join(", ")} failed at this Container's start, so dependencies may be missing. It runs again at the next Container start; run \`bash ${SETUP_SCRIPT}\` in the repo to try it now.`,
    };
  }

  /** Run the Setup Script of the repo in `directory`; why it failed, if it did. Never throws. */
  async #runSetupScript(shell: Shell, directory: string): Promise<Failure | undefined> {
    try {
      const ran = await runToEnd(
        shell,
        {
          source: inBash(setupScriptRun(directory)),
          cwd: directory,
          timeoutMs: SETUP_EXEC_TIMEOUT_MS,
          env: this.#env,
        },
        this.#kept,
      );

      if (ran.code === 0) return undefined;

      return setupScriptTimedOut(ran.code, ran.output)
        ? {
            reason: `it ran past ${SETUP_TIMEOUT_SECONDS / 60} minutes and was stopped`,
            output: this.#tail(ran),
          }
        : this.#failure(ran);
    } catch (cause) {
      return this.#couldNotRun(cause);
    }
  }
}

/** Why a bootstrap or a Setup Script failed: in a few words, and what it printed (without the token). */
type Failure = { readonly reason: string; readonly output: string };

/**
 * What to tell commands of the Setup Scripts that failed at a Container's start: the note with their output, for the
 * first command that starts after them, and a pointer to it for the later ones.
 */
type SetupReport = { readonly note: string; readonly pointer: string };

/** What a bootstrap came to: why it failed, or, when it did not, what the Setup Scripts it ran have to report. */
type Outcome =
  | { readonly ok: false; readonly failure: Failure }
  | { readonly ok: true; readonly setup: SetupReport | undefined };

/** How an exec ended: its exit status, if it ended with one, and the end of its output, and whether that was `cut`. */
type Ran = { readonly code: number | undefined; readonly output: string; readonly cut: boolean };

/** An exec's failure in a few words, from its exit status. */
const exitReason = (code: number | undefined): string =>
  code === undefined ? "its output ended without an exit status" : `exit status ${code}`;

/**
 * Run `input` on `shell` to its end, then release the exec; how it ended, with the last `keep` characters of its output
 * (all of it without `keep`).
 */
const runToEnd = async (
  shell: Shell,
  input: Omit<Parameters<Shell["exec"]>[0], "id">,
  keep?: number,
): Promise<Ran> => {
  const execution = await shell.exec({ id: crypto.randomUUID(), ...input });

  try {
    return await drain(execution.events, keep);
  } finally {
    await shell.disposeExec({ id: execution.id }).catch(() => undefined);
  }
};

/**
 * Runs a bootstrap once, for the commands that wait on it, and again after a failure once its wait is over: a minute,
 * doubling with each failure in a row. Each command gets a note while the last attempt failed: the output for those
 * that waited for it, and a pointer for those that come after. A bootstrap whose Setup Scripts failed has not failed:
 * it is done, and what the scripts report goes to `onDone`.
 */
class Bootstrap {
  readonly #run: () => Promise<Outcome>;
  readonly #now: () => number;
  readonly #onDone: (setup: SetupReport | undefined) => void;
  #done: boolean;
  #inflight: Promise<string | undefined> | undefined;
  #failedAt: number | undefined;
  #failures = 0;
  #reason = "";

  constructor(
    run: () => Promise<Outcome>,
    now: () => number,
    done: boolean,
    onDone: (setup: SetupReport | undefined) => void,
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
      .then((outcome) => {
        if (outcome.ok) {
          this.#done = true;
          this.#failedAt = undefined;
          this.#failures = 0;
          this.#onDone(outcome.setup);

          return undefined;
        }

        const { failure } = outcome;

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

/** How a command ended: its exit status (if it ended with one) and its output, or its last `keep` characters. */
const drain = async (
  stream: ReadableStream<{
    readonly name: string;
    readonly value?: Uint8Array;
    readonly code?: number;
  }>,
  keep?: number,
): Promise<Ran> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  let cut = false;
  let code: number | undefined;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    const event = next.value;

    if (event.name === "exit") code = event.code;
    else if (event.value !== undefined) {
      output += decoder.decode(event.value, { stream: true });

      if (keep !== undefined && output.length > keep) {
        output = output.slice(-keep);
        cut = true;
      }
    }
  }

  return { code, output: output.trimEnd(), cut };
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
