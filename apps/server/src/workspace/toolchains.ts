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
//   end of its output, later ones a pointer to it, and it is due again at the next Container start. The Environment's
//   own Setup Script, from its Container settings, runs first, in `/workspace`. The Setup Scripts, and no other script
//   or command, get the Environment's Secrets marked for the Build, as `$PI_SECRET_<NAME>`, from the Workspace's copy.
// - Then, after the hook that snapshots the disk (so no service is writing to it meanwhile), the Start Scripts run: the
//   Environment's, then each repo's `.agents/start.sh`, at every Container start, each bounded by 5 minutes and
//   reported like a Setup Script.
// - Every command's environment carries the Environment's variables, under mise's settings and the GitHub token
//   (`toolchainEnv`), under what the caller passes, and the token and the Environment's kept Secrets are taken out of
//   what a command prints (a Secret as its reference). The variables, the Environment's scripts and its Toolchains
//   (the root `mise.toml` the bootstrap writes) are read once per Container start, at its bootstrap.
//
// The token is bound to the Workspaces Worker as a secret. It reaches the Container only in a process's environment:
// no file holds it, and nothing here logs it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalTimers:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import type { ContainerSettings } from "@cloudpid/config";
import { type KeptSecret, secretReference } from "@cloudpid/extensions/secrets/core";
import { inBash, quote } from "@cloudpid/computer-env/shell";
import {
  BOOTSTRAP_CHANGED,
  bootstrapScript,
  type CommandEnv,
  ENVIRONMENT_SETUP_FILE,
  ENVIRONMENT_START_FILE,
  environmentSetupScript,
  environmentStartScriptRun,
  pendingSetupScripts,
  repoSetupScriptOf,
  scriptTimedOut,
  SETUP_SCRIPT,
  SETUP_TIMEOUT_SECONDS,
  setupScriptRun,
  START_SCRIPT,
  START_TIMEOUT_SECONDS,
  startScriptDirectories,
  startScriptRun,
  toolchainEnv,
  WORKSPACE_ROOT,
} from "@cloudpid/sandbox-image/toolchains";
import { buildSecretEnvironment } from "./environment-secrets.ts";
import type { IdleStop } from "./idle.ts";
import { type Redaction, Redactor } from "./redact.ts";

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

/** How long computer lets a Start Script's exec run, on the same terms. */
const START_EXEC_TIMEOUT_MS = (START_TIMEOUT_SECONDS + 60) * 1000;

/** How long finding the due Setup Scripts, or the Start Scripts, may take: a hash of a file in each repo. */
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
  /**
   * The Workspace's Container settings as they are now, read at the start of each bootstrap: their variables reach the
   * bootstrap, the scripts and every command of that Container start, their Setup and Start Scripts run in it, and
   * their Toolchains are the root `mise.toml` it writes. Without it, or when it fails, there are none (the base
   * Toolchains).
   */
  readonly settings?: (() => Promise<BootstrapSettings>) | undefined;
  /**
   * The Environment's kept Secrets the Workspace holds, taken out of what commands print as the token is: `read` at
   * each command's start, `known` (what is in memory) for the reports of the bootstrap and its scripts. The Setup
   * Scripts also get those marked for the Build (`buildSecretEnvironment`) from `read`.
   */
  readonly secrets?:
    | {
        readonly read: () => Promise<ReadonlyArray<KeptSecret>>;
        readonly known: () => ReadonlyArray<KeptSecret>;
      }
    | undefined;
  /** The identity of commits the agent makes, where the Container has no other; unset parts take the bootstrap's own. */
  readonly git: { readonly name?: string | undefined; readonly email?: string | undefined };
  /**
   * Runs once a bootstrap has succeeded, before the commands that waited for it are sent: the Workspace snapshots the
   * Container's disk here, while nothing else is writing to it, when `changed` says the bootstrap changed it: the
   * install ended its output with `BOOTSTRAP_CHANGED` (mise installed a Toolchain), or a Setup Script succeeded. A
   * failed Setup Script alone does not count: it runs again at the next Container start. A failure of the hook is
   * reported and changes nothing.
   */
  readonly afterInstall?: ((changed: boolean) => Promise<void>) | undefined;
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
  /** What every command gets whatever the Environment: `toolchainEnv`'s. */
  readonly #toolchainEnv: CommandEnv;
  /** What the commands of the Container start bootstrapped last get: the Environment's variables under `#toolchainEnv`. */
  #env: CommandEnv;
  /** The Container run the bootstrap last finished in: a new connection to the same Container needs none. */
  #bootstrapped: string | undefined;
  /** The bootstrap of the connection made last, for `runBootstrap`. */
  #latest: Bootstrap | undefined;
  /**
   * The Setup and Start Scripts that failed at that run's start, if any, and whether a command that started has had the full note:
   * until one has, the next one gets it; after, each gets a pointer to it.
   */
  #scriptsFailed: { readonly report: ScriptReport; seen: boolean } | undefined;

  constructor(options: ToolchainOptions) {
    this.#options = options;
    this.#toolchainEnv = toolchainEnv({ githubToken: options.githubToken });
    this.#env = this.#toolchainEnv;
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

  /** What to take out of output: the token (as `***`) and each kept Secret (as its reference). */
  #redactions(secrets: ReadonlyArray<KeptSecret>): Redaction[] {
    const token = this.#secret;

    return [
      ...(token === undefined ? [] : [{ value: token, mask: "***" }]),
      ...secrets.map((kept) => ({ value: kept.value, mask: secretReference(kept.name) })),
    ];
  }

  /** The kept Secrets the Workspace holds now; what is in memory when they cannot be read. Never throws. */
  async #heldSecrets(): Promise<ReadonlyArray<KeptSecret>> {
    const secrets = this.#options.secrets;

    if (secrets === undefined) return [];

    try {
      return await secrets.read();
    } catch {
      return secrets.known();
    }
  }

  #rpc(handle: BackendHandle): BackendHandle["rpc"] {
    const shell = handle.rpc.shell;

    const ready = new Bootstrap(
      () => this.#bootstrap(shell),
      this.#options.now,
      handle.runtimeId !== undefined && handle.runtimeId === this.#bootstrapped,
      (scripts) => {
        this.#bootstrapped = handle.runtimeId;
        this.#scriptsFailed = scripts === undefined ? undefined : { report: scripts, seen: false };
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

        const note = bootstrapNote ?? this.#scriptsNote(handle.runtimeId);

        const source =
          note === undefined ? input.source : `printf '%s\\n' ${quote(note)} >&2\n${input.source}`;

        const redactions = this.#redactions(await this.#heldSecrets());

        return withRedactedOutput(
          await shell.exec({ ...input, source, env: { ...this.#env, ...input.env } }),
          redactions,
        );
      },
      getExec: async (input) =>
        withRedactedOutput(await shell.getExec(input), this.#redactions(await this.#heldSecrets())),
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
   * What a command that starts in the Container run `runtimeId` is told of the Setup and Start Scripts that failed at its start: the
   * full note if no command that started has had it yet (one that waited may have been killed), else a pointer.
   */
  #scriptsNote(runtimeId: string | undefined): string | undefined {
    const failed = this.#scriptsFailed;

    if (failed === undefined || runtimeId !== this.#bootstrapped) return undefined;

    if (failed.seen) return failed.report.pointer;

    failed.seen = true;

    return failed.report.note;
  }

  /** The after-install hook, which never throws: a snapshot is an optimisation. */
  async #installed(changed: boolean): Promise<void> {
    const { afterInstall, warn } = this.#options;

    try {
      await afterInstall?.(changed);
    } catch (cause) {
      warn(
        `After the Toolchain install: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
  }

  /** `text` without the token and the kept Secrets this instance knows. */
  #redact(text: string): string {
    return this.#redactions(this.#options.secrets?.known() ?? []).reduce(
      (redacted, { value, mask }) => (value === "" ? redacted : redacted.replaceAll(value, mask)),
      text,
    );
  }

  /** The length of the longest secret taken out of output, for what may be cut through one. */
  get #longest(): number {
    return Math.max(
      this.#secret?.length ?? 0,
      ...(this.#options.secrets?.known() ?? []).map((kept) => kept.value.length),
    );
  }

  /**
   * How much of an exec's output to keep for its report: the reported length and the longest secret's, so that a secret
   * cut by the start of what is kept can be dropped whole (`#tail`).
   */
  get #kept(): number {
    return REPORTED_OUTPUT + this.#longest;
  }

  /**
   * The end of an exec's output to report, kept with `#kept`: without the secrets, then, if the output was `cut`,
   * without the longest secret's length of characters (where the rest of one cut by the start may be), then cut to
   * length.
   */
  #tail({ output, cut }: Ran): string {
    const redacted = this.#redact(output);
    const whole = cut ? redacted.slice(this.#longest) : redacted;

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
      const environment = await this.#environment();

      this.#env = { ...environment.variables, ...this.#toolchainEnv };

      return await this.#installAndSetUp(shell, environment);
    } finally {
      await activity?.end().catch(log);
    }
  }

  /**
   * The Environment's variables, scripts and Toolchains as the Workspace holds them now; none when they cannot be read.
   * Never throws.
   */
  async #environment(): Promise<BootstrapSettings> {
    const { settings, warn } = this.#options;

    try {
      return (await settings?.()) ?? NO_BOOTSTRAP_SETTINGS;
    } catch (cause) {
      warn(
        `Container settings: could not read them, so this Container start has no variables, no Environment scripts and the base Toolchains: ${String(cause instanceof Error ? cause.message : cause)}`,
      );

      return NO_BOOTSTRAP_SETTINGS;
    }
  }

  /**
   * Install the Toolchains, then run the Setup Scripts that are due, the after-install hook and the Start Scripts, in
   * that order, so a snapshot keeps what the Setup Scripts installed (and their time is not the snapshot's) and no
   * service a Start Script starts is writing to the disk while it is taken. It reports a failure itself.
   */
  async #installAndSetUp(shell: Shell, environment: BootstrapSettings): Promise<Outcome> {
    const { git, warn } = this.#options;
    const identity: CommandEnv = {};

    if (git.name !== undefined && git.name !== "") identity.CLOUDPID_GIT_NAME = git.name;

    if (git.email !== undefined && git.email !== "") identity.CLOUDPID_GIT_EMAIL = git.email;

    let failure: Failure;

    try {
      const ran = await runToEnd(
        shell,
        {
          source: inBash(
            bootstrapScript(WORKSPACE_ROOT, this.#options.readOnlyDirectories, undefined, {
              toolchains: environment.toolchains,
            }),
          ),
          cwd: WORKSPACE_ROOT,
          timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          env: { ...this.#env, ...identity },
        },
        this.#kept,
      );

      if (ran.code === 0) {
        const setup = await this.#runSetupScripts(shell, environment.setupScript);

        await this.#installed(ran.changed || setup.succeeded);

        const start = await this.#runStartScripts(shell, environment.startScript);

        return { ok: true, scripts: combined([setup.report, start]) };
      }

      failure = this.#failure(ran);
    } catch (cause) {
      failure = this.#couldNotRun(cause);
    }

    warn(`Toolchain bootstrap failed (${failure.reason}): ${failure.output}`);

    return { ok: false, failure };
  }

  /**
   * Run each due Setup Script, one after the other, with a command's environment: the Environment's (`source`) first,
   * then the repos'. What to tell commands of those that did not succeed, if any, and whether any succeeded (which
   * changed the disk). Never throws.
   */
  async #runSetupScripts(shell: Shell, source: string): Promise<SetupScriptsRun> {
    const { warn } = this.#options;
    let due: string[];

    try {
      const listed = await runToEnd(shell, {
        source: inBash(
          pendingSetupScripts(WORKSPACE_ROOT, undefined, { source, file: ENVIRONMENT_SETUP_FILE }),
        ),
        cwd: WORKSPACE_ROOT,
        timeoutMs: SETUP_LIST_TIMEOUT_MS,
        env: this.#env,
      });

      if (listed.code !== 0) throw new Error(`${exitReason(listed.code)}: ${listed.output}`);

      due = listed.output
        .split("\n")
        .filter((line) => line === ENVIRONMENT_SETUP_FILE || line.startsWith(`${WORKSPACE_ROOT}/`));
    } catch (cause) {
      const message = this.#redact(String(cause instanceof Error ? cause.message : cause));

      warn(`Setup Scripts: could not find the due ones: ${message}`);

      const report = {
        note: `cloudpid: could not tell which repos' Setup Script (${SETUP_SCRIPT}) to run (${message}), so their dependencies may be missing. They are looked for again at the next Container start.`,
        pointer: `cloudpid: the repos' Setup Scripts (${SETUP_SCRIPT}) could not be run at this Container's start, so their dependencies may be missing. They are looked for again at the next Container start.`,
      };

      return { report, succeeded: false };
    }

    const notes: string[] = [];
    const pointers: string[] = [];
    const failed: string[] = [];
    let succeeded = false;

    // The Secrets marked for the Build, which a Workspace's Setup Scripts get as the Build's do; no other script does.
    const env =
      due.length === 0
        ? this.#env
        : { ...this.#env, ...buildSecretEnvironment(await this.#heldSecrets()) };

    for (const line of due) {
      const ofEnvironment = line === ENVIRONMENT_SETUP_FILE;
      const script = ofEnvironment ? environmentSetupScript() : repoSetupScriptOf(line);

      const failure = await this.#runScript(
        shell,
        {
          source: setupScriptRun(script),
          cwd: script.directory,
          timeoutMs: SETUP_EXEC_TIMEOUT_MS,
          env,
        },
        SETUP_TIMEOUT_SECONDS,
      );

      if (failure === undefined) {
        succeeded = true;

        continue;
      }

      if (ofEnvironment) {
        warn(`The Environment's Setup Script failed (${failure.reason}): ${failure.output}`);
        notes.push(
          `cloudpid: the Environment's Setup Script failed (${failure.reason}), so dependencies may be missing: ${failure.output}\nIt runs again at the next Container start; run \`bash ${ENVIRONMENT_SETUP_FILE}\` in ${WORKSPACE_ROOT} to try it now.`,
        );
        pointers.push(
          `cloudpid: the Environment's Setup Script failed at this Container's start, so dependencies may be missing. It runs again at the next Container start; run \`bash ${ENVIRONMENT_SETUP_FILE}\` in ${WORKSPACE_ROOT} to try it now.`,
        );

        continue;
      }

      warn(`Setup Script of ${line} failed (${failure.reason}): ${failure.output}`);
      failed.push(line);
      notes.push(
        `cloudpid: the Setup Script ${line}/${SETUP_SCRIPT} failed (${failure.reason}), so the repo's dependencies may be missing: ${failure.output}\nIt runs again at the next Container start; run \`bash ${SETUP_SCRIPT}\` in ${line} to try it now.`,
      );
    }

    if (failed.length > 0) {
      pointers.push(
        `cloudpid: the Setup Script (${SETUP_SCRIPT}) of ${failed.join(", ")} failed at this Container's start, so dependencies may be missing. It runs again at the next Container start; run \`bash ${SETUP_SCRIPT}\` in the repo to try it now.`,
      );
    }

    if (notes.length === 0) return { report: undefined, succeeded };

    return { report: { note: notes.join("\n"), pointer: pointers.join("\n") }, succeeded };
  }

  /**
   * Run the Start Scripts, one after the other, with a command's environment: the Environment's (`source`), when it has
   * one, then each repo's. What to tell commands of those that did not succeed, if any. Never throws.
   */
  async #runStartScripts(shell: Shell, source: string): Promise<ScriptReport | undefined> {
    const { warn } = this.#options;
    const notes: string[] = [];
    const pointers: string[] = [];
    const failed: string[] = [];

    if (source !== "") {
      const failure = await this.#runStartScript(
        shell,
        environmentStartScriptRun(source),
        WORKSPACE_ROOT,
      );

      if (failure !== undefined) {
        warn(`The Environment's Start Script failed (${failure.reason}): ${failure.output}`);
        notes.push(
          `cloudpid: the Environment's Start Script failed (${failure.reason}), so the services it starts may not be running: ${failure.output}\nIt runs again at the next Container start; run \`bash ${ENVIRONMENT_START_FILE}\` in ${WORKSPACE_ROOT} to try it now.`,
        );
        pointers.push(
          `cloudpid: the Environment's Start Script failed at this Container's start, so services may not be running. It runs again at the next Container start; run \`bash ${ENVIRONMENT_START_FILE}\` in ${WORKSPACE_ROOT} to try it now.`,
        );
      }
    }

    let directories: string[] = [];

    try {
      const listed = await runToEnd(shell, {
        source: inBash(startScriptDirectories(WORKSPACE_ROOT)),
        cwd: WORKSPACE_ROOT,
        timeoutMs: SETUP_LIST_TIMEOUT_MS,
        env: this.#env,
      });

      if (listed.code !== 0) throw new Error(`${exitReason(listed.code)}: ${listed.output}`);

      directories = listed.output
        .split("\n")
        .filter((line) => line.startsWith(`${WORKSPACE_ROOT}/`));
    } catch (cause) {
      const message = this.#redact(String(cause instanceof Error ? cause.message : cause));

      warn(`Start Scripts: could not find them: ${message}`);
      notes.push(
        `cloudpid: could not tell which repos' Start Script (${START_SCRIPT}) to run (${message}), so their services may not be running. They are looked for again at the next Container start.`,
      );
      pointers.push(
        `cloudpid: the repos' Start Scripts (${START_SCRIPT}) could not be run at this Container's start, so their services may not be running. They are looked for again at the next Container start.`,
      );
    }

    for (const directory of directories) {
      const failure = await this.#runStartScript(
        shell,
        startScriptRun({ directory, file: START_SCRIPT }),
        directory,
      );

      if (failure === undefined) continue;

      warn(`Start Script of ${directory} failed (${failure.reason}): ${failure.output}`);
      failed.push(directory);
      notes.push(
        `cloudpid: the Start Script ${directory}/${START_SCRIPT} failed (${failure.reason}), so the services it starts may not be running: ${failure.output}\nIt runs again at the next Container start; run \`bash ${START_SCRIPT}\` in ${directory} to try it now.`,
      );
    }

    if (failed.length > 0) {
      pointers.push(
        `cloudpid: the Start Script (${START_SCRIPT}) of ${failed.join(", ")} failed at this Container's start, so services may not be running. It runs again at the next Container start; run \`bash ${START_SCRIPT}\` in the repo to try it now.`,
      );
    }

    return notes.length === 0
      ? undefined
      : { note: notes.join("\n"), pointer: pointers.join("\n") };
  }

  /** Run the Start Script run `source` in `directory`; why it failed, if it did. Never throws. */
  #runStartScript(shell: Shell, source: string, directory: string): Promise<Failure | undefined> {
    return this.#runScript(
      shell,
      { source, cwd: directory, timeoutMs: START_EXEC_TIMEOUT_MS },
      START_TIMEOUT_SECONDS,
      // The one way a Start Script that works runs past its time: a service it started holds the exec's output.
      " (a service it starts must detach: `setsid nohup cmd >/tmp/cmd.log 2>&1 &`)",
    );
  }

  /**
   * Run the Setup or Start Script run `input` (a script of `@cloudpid/sandbox-image/toolchains`, bounded by
   * `timeoutSeconds`) with a command's environment, or `input.env`; why it failed, if it did, with `timedOutHint` after
   * the reason of one stopped for its time. Never throws.
   */
  async #runScript(
    shell: Shell,
    input: {
      readonly source: string;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly env?: CommandEnv | undefined;
    },
    timeoutSeconds: number,
    timedOutHint: string = "",
  ): Promise<Failure | undefined> {
    try {
      const ran = await runToEnd(
        shell,
        { ...input, source: inBash(input.source), env: input.env ?? this.#env },
        this.#kept,
      );

      if (ran.code === 0) return undefined;

      return scriptTimedOut(ran.code, ran.output)
        ? {
            reason: `it ran past ${timeoutSeconds / 60} minutes and was stopped${timedOutHint}`,
            output: this.#tail(ran),
          }
        : this.#failure(ran);
    } catch (cause) {
      return this.#couldNotRun(cause);
    }
  }
}

/** What a bootstrap reads of the Environment's Container settings: its variables, scripts and Toolchains. */
export type BootstrapSettings = Pick<
  ContainerSettings,
  "variables" | "setupScript" | "startScript" | "toolchains"
>;

const NO_BOOTSTRAP_SETTINGS: BootstrapSettings = {
  variables: {},
  setupScript: "",
  startScript: "",
  toolchains: "",
};

/** Why a bootstrap or a script failed: in a few words, and what it printed (without the token). */
type Failure = { readonly reason: string; readonly output: string };

/**
 * What to tell commands of the Setup and Start Scripts that failed at a Container's start: the note with their output,
 * for the first command that starts after them, and a pointer to it for the later ones.
 */
type ScriptReport = { readonly note: string; readonly pointer: string };

/** `reports` as one, a line of each; undefined when there are none. */
const combined = (reports: ReadonlyArray<ScriptReport | undefined>): ScriptReport | undefined => {
  const present = reports.filter((report) => report !== undefined);

  return present.length === 0
    ? undefined
    : {
        note: present.map((report) => report.note).join("\n"),
        pointer: present.map((report) => report.pointer).join("\n"),
      };
};

/** What a bootstrap's Setup Scripts came to: what to tell commands of those that failed, and whether any succeeded. */
type SetupScriptsRun = { readonly report: ScriptReport | undefined; readonly succeeded: boolean };

/** What a bootstrap came to: why it failed, or, when it did not, what the scripts it ran have to report. */
type Outcome =
  | { readonly ok: false; readonly failure: Failure }
  | { readonly ok: true; readonly scripts: ScriptReport | undefined };

/**
 * How an exec ended: its exit status, if it ended with one, and the end of its output, and whether that was `cut`; and
 * whether its stdout ended with `BOOTSTRAP_CHANGED` (the bootstrap's last line when it changed the Container's disk),
 * read from stdout alone so no other output can come in between.
 */
type Ran = {
  readonly code: number | undefined;
  readonly output: string;
  readonly cut: boolean;
  readonly changed: boolean;
};

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
  readonly #onDone: (scripts: ScriptReport | undefined) => void;
  #done: boolean;
  #inflight: Promise<string | undefined> | undefined;
  #failedAt: number | undefined;
  #failures = 0;
  #reason = "";

  constructor(
    run: () => Promise<Outcome>,
    now: () => number,
    done: boolean,
    onDone: (scripts: ScriptReport | undefined) => void,
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
          this.#onDone(outcome.scripts);

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
  const stdoutDecoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  let cut = false;
  // The end of stdout, enough to hold the marker.
  let stdout = "";
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

      if (event.name === "stdout") {
        stdout = (stdout + stdoutDecoder.decode(event.value, { stream: true })).slice(
          -(BOOTSTRAP_CHANGED.length + 2),
        );
      }
    }
  }

  return {
    code,
    output: output.trimEnd(),
    cut,
    changed: stdout.trimEnd().endsWith(BOOTSTRAP_CHANGED),
  };
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
 * `execution` with `secrets` taken out of its output. What it holds back at the end of a stream (the start of a
 * secret, which turned out not to be one) comes out just before the exit. Without secrets it is `execution` itself.
 */
const withRedactedOutput = (execution: Execution, secrets: ReadonlyArray<Redaction>): Execution => {
  if (secrets.length === 0) return execution;

  const redactors = { stdout: new Redactor(secrets), stderr: new Redactor(secrets) };
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
