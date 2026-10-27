// The coding tools: pi-durable's `write` and `edit`; its `read`, wrapped so every image it returns fits the
// conversation (`./images/read.ts`, docs/spec.md → Filesystem and tools); and a `bash` that chooses where its command
// runs (docs/spec.md → Backends). `bash` is pi-durable's own tool with one more argument, `backend`; the rest of its
// behavior (streaming, output limits, spill, exit status) is pi-durable's.
//
// A call that names a `backend` runs there. One that names none is routed by its command (`bash-routing.ts`): the Worker
// Shell, unless the command needs a real binary, so the Container (the costly backend) starts only when a command needs
// it. A program the router does not know is asked of the Worker Shell first (`command -v`, remembered for the tool's
// life), and a command that writes no file runs again on the Container when the Worker Shell says it cannot run it (a
// missing program, an option its version lacks, a syntax it does not parse). A command naming a Container-only path
// (GLOSSARY.md), which the Worker Shell cannot see, goes to the Container: the environment says which of the command's
// paths are (`containerOnly`, one call), and a command that writes no file runs again on the Container when the Worker
// Shell said it did not find one. An environment with no backends runs every command on itself.
//
// `read`, `write` and `edit` reach Container-only paths through the Container (the environment's doing); their
// descriptions say so.
//
// The `coding_tools` section tells the model to use `read`, `edit` and `write` for files rather than shell commands or
// scripts, and to leave the Container to the commands that need it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  hook,
  type JsonObject,
  NestedCallDoc,
  section,
  ToolTask,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type {
  ExecutionEnv,
  FileError,
  Result,
  ShellOutputInfo,
} from "@earendil-works/pi-durable/env";
import {
  commandPaths,
  missingPaths,
  probeAnswer,
  probeScript,
  resolveRoute,
  routeCommand,
  workerShellCannot,
  type BashRoute,
  type WorkerOutput,
} from "./bash-routing.ts";
import { byteLength, capturedDiffs, oldFile, writeDetails } from "./call-diff.ts";
import { Images, type ImagesService, readTool } from "./images.ts";

/** Where a `bash` command can run: the Worker Shell (`worker`) or the Container (`container`). */
export type BashBackend = "worker" | "container";

/** An execution environment that runs commands on a backend of the model's choosing. */
export interface BackendEnv {
  /** The same environment, running its commands on `backend`. */
  onBackend(backend: BashBackend): ExecutionEnv;
}

const hasBackends = (env: ExecutionEnv | undefined): env is ExecutionEnv & BackendEnv =>
  env !== undefined && "onBackend" in env;

/** An execution environment that knows which paths are Container-only: only its Container has their files. */
export interface ContainerOnlyEnv {
  /** For each absolute, normalized path, whether it is a Container-only path. */
  containerOnly(
    paths: readonly string[],
    context: Context,
  ): Promise<Result<readonly boolean[], FileError>>;
}

const knowsContainerOnly = (env: ExecutionEnv): env is ExecutionEnv & ContainerOnlyEnv =>
  "containerOnly" in env;

/** The first of `paths` that `env` says is Container-only; undefined for none, and when it cannot say. */
const firstContainerOnly = async (
  env: ContainerOnlyEnv,
  paths: readonly string[],
  context: Context,
): Promise<string | undefined> => {
  if (paths.length === 0) return undefined;

  try {
    const result = await env.containerOnly(paths, context);

    return result.ok ? paths.find((_, at) => result.value[at] === true) : undefined;
  } catch {
    // An environment that cannot answer leaves the command where the rest of its route put it.
    return undefined;
  }
};

/** What `read`, `write` and `edit` add to their descriptions. */
const CONTAINER_ONLY_FILES =
  "Paths only the container has (anything outside /workspace, /tmp included, and dependency, build and cache directories such as node_modules, .venv, target and .cache inside it) are read and written through the container, which starts if needed; their files are on its disk and in its snapshot, not in the Workspace's files.";

/** `tool`, telling the model that it reaches Container-only paths through the Container. */
const throughContainer = <T extends { readonly description: string }>(tool: T): T => ({
  ...tool,
  description: `${tool.description} ${CONTAINER_ONLY_FILES}`,
});

const base = createBashTool();

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** The path as `write` itself resolves it: unusual spaces become spaces, and a leading `@` is dropped. */
const writtenPath = (path: string): string => {
  const normalized = path.replace(UNICODE_SPACES, " ");

  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
};

/**
 * pi-durable's `write`, recording the Call diff in the result's `details` (`./call-diff.ts`): the file is read before it
 * is written, and the patch made once the write has succeeded. Nothing about the diff can fail the write or its result:
 * a diff that cannot be made leaves the result as `write` made it. The old text is read outside pi-durable's per-file
 * mutation queue (which it does not export), so two writes to one file at once may show each other's text as old.
 */
const writeTool = () => {
  const write = createWriteTool();

  return defineTool({
    ...write,
    async execute(args, api, context) {
      const env = api.env;

      const before = await (async () => {
        try {
          const absolute = await env?.absolutePath(writtenPath(args.path), context);

          return env === undefined || absolute === undefined || !absolute.ok
            ? undefined
            : await oldFile(env, absolute.value, byteLength(args.content), context);
        } catch {
          return undefined;
        }
      })();

      const result = await write.execute(args, api, context);

      if (before === undefined) return result;

      try {
        // SAFETY: a `RecordedDiff` holds strings and booleans only, and leaves out the fields it does not have.
        const details = writeDetails(args.path, before, args.content) as JsonObject;

        return { ...result, details };
      } catch {
        return result;
      }
    },
  });
};

const backendDescription = [
  "Commands run on one of two backends that share the same files in /workspace. Routing is automatic: leave `backend` unset and the cheapest backend that can run the command is chosen.",
  "- worker: a shell inside a Worker (just-bash). It starts instantly and costs almost nothing. It runs text and file commands: cat, grep, rg, sed, awk, jq, find, sort, head, diff, tar, ls and the like, with cd, pipes, redirects, globs, loops, `case` and substitutions, plus a read-only git: `git status` (one `XY path` line per changed file, `?` for untracked, nothing when clean; the staged column can be wrong, so use `git status --short` on the container after a `git add`), `git log --oneline`, `git rev-parse HEAD`, `git branch`, `git ls-files`. It has no network and cannot run native (ELF) binaries, so no node, npm, python, compilers, test runners, curl, or gh.",
  "- container: a real Linux container (Ubuntu 24.04) with network access, and the costly backend: it takes several seconds to start and is billed while it runs. It runs anything that needs a real binary: npm, node, python, test runners, compilers, package managers, gh, mise toolchains, docker (start its daemon with `cloudpid-dockerd`), all other git (diff, show, add, commit, branch changes, clone, push, pull; the GitHub token is set: git takes the one for the repo's owner, and gh the one for the repos of its working directory, so run gh in the repo), and scripts (./script.sh). When it stops answering (every container command hangs, `echo` included), restart it with `container_restart`.",
  "- Paths only the container has: anything outside /workspace (/tmp and ~ included), and dependency, build and cache directories inside it such as node_modules, .venv, target and .cache. Their files are on the container's disk and in its snapshot, not in the Workspace's files, so the worker does not see them: a command naming one runs on the container by itself, and `read`, `write` and `edit` reach them through the container too, starting it if needed.",
  'Without `backend`, a command runs on the worker when the worker has every program in it and names no path only the container has, and on the container otherwise (also for a script path or `$CMD`); a command that writes no file is rerun on the container by itself when the worker rejects a program or option, or cannot find a path only the container has. So never set `backend` for reading, searching or listing (and to view a file, use `read` rather than `cat`). Override it with `"container"` only when the worker ran a command and its output was wrong; `"worker"` forces the fast shell.',
].join("\n");

const parameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  backend: Type.Optional(
    Type.Union([Type.Literal("worker"), Type.Literal("container")], {
      description:
        "Where to run the command (default: chosen from the command); see the tool description",
    }),
  ),
});

/** Thrown out of a Worker Shell attempt the Container should run instead; its message says why. */
// @effect-diagnostics-next-line extendsNativeError:off -- caught by `bash` itself, never in an Effect's failure channel.
class RunOnContainer extends Error {}

/**
 * Which of `programs` the Worker Shell of `worker` has, asking it about those `known` does not hold. An answer cut short
 * answers none and is not remembered, so the command goes to the Container this once.
 */
const workerHas = async (
  worker: ExecutionEnv,
  programs: readonly string[],
  known: Map<string, boolean>,
  context: Context,
): Promise<ReadonlySet<string>> => {
  const asked = programs.filter((name) => !known.has(name));

  if (asked.length > 0) {
    let stdout = "";

    const result = await worker.exec(
      probeScript(asked),
      { onOutput: (text, _context, info) => (stdout += info.stream === "stdout" ? text : "") },
      context,
    );

    const present = result.ok ? probeAnswer(asked, stdout) : undefined;

    if (present !== undefined) for (const name of asked) known.set(name, present.has(name));
  }

  return new Set(programs.filter((name) => known.get(name) === true));
};

type ExecResult = Awaited<ReturnType<ExecutionEnv["exec"]>>;

type OutputChunk = [text: string, context: Context, info: ShellOutputInfo];

/**
 * Why `result`, a command's on the Worker Shell with `output`, should run on the Container instead: the Worker Shell
 * could not run it, or (asked of `containerOnlyMissing`) did not find a path only the Container has.
 */
const containerReason = async (
  result: ExecResult,
  output: WorkerOutput,
  containerOnlyMissing: ((output: WorkerOutput) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> => {
  if (!result.ok) {
    return result.error.code === "spawn_error"
      ? `the worker could not (${result.error.message})`
      : undefined;
  }

  const cannot = workerShellCannot(output);

  if (cannot !== undefined) return `the worker could not (${cannot})`;

  const path = await containerOnlyMissing?.(output);

  return path === undefined ? undefined : `${path} is only on the container`;
};

/** How a command that writes no file is judged after its Worker Shell run, to run it again on the Container. */
type Rerun = {
  /** The first path the Worker Shell did not find that only the Container has; undefined when the environment cannot say. */
  readonly containerOnlyMissing:
    | ((output: WorkerOutput) => Promise<string | undefined>)
    | undefined;
};

/**
 * `worker`, holding back each command's output until it has ended. When `rerun` is given (the command writes no file)
 * and the Worker Shell could not run it (`workerShellCannot`, or it never started) or did not find a path only the
 * Container has, the attempt throws `RunOnContainer` with nothing delivered; otherwise its output is delivered as it came.
 */
const attemptOn = (worker: ExecutionEnv, rerun: Rerun | undefined): ExecutionEnv => {
  const attempt: Pick<ExecutionEnv, "cwd" | "exec"> = {
    cwd: worker.cwd,
    exec: async (command, options, context) => {
      const chunks: OutputChunk[] = [];

      const result = await worker.exec(
        command,
        { ...options, onOutput: (...chunk) => chunks.push(chunk) },
        context,
      );

      if (rerun !== undefined) {
        const output = { stdout: "", stderr: "" };

        for (const [text, , info] of chunks) output[info.stream] += text;

        const reason = await containerReason(result, output, rerun.containerOnlyMissing);

        if (reason !== undefined) throw new RunOnContainer(reason);
      }

      for (const chunk of chunks) options?.onOutput?.(...chunk);

      return result;
    },
  };

  // SAFETY: pi-durable's `bash` uses only the environment's `cwd` and `exec` (`prepareExecution`, `runCommand`).
  return attempt as ExecutionEnv;
};

/** `bash`, whose routing remembers which programs its environments' Worker Shell has in `known`. */
const bashTool = (known: Map<string, boolean>): ToolRegistration<typeof parameters> =>
  defineTool({
    ...base,
    description: `${base.description}\n\n${backendDescription}`,
    parameters,
    async execute({ backend, ...args }, api, context) {
      const env = api.env;

      if (!hasBackends(env)) {
        // An environment with one backend runs every command there; only a Container is something it cannot give.
        if (backend !== "container") return base.execute(args, api, context);

        throw new Error(
          `This environment has no container backend: run the command without \`backend\`.`,
        );
      }

      const runOn = (on: ExecutionEnv) => base.execute(args, { ...api, env: on }, context);

      if (backend !== undefined) return runOn(env.onBackend(backend));

      const worker = env.onBackend("worker");

      const route: BashRoute = await resolveRoute(routeCommand(args.command), (programs) =>
        workerHas(worker, programs, known, context),
      );

      if (route.backend === "container") return runOn(env.onBackend("container"));

      // A command naming a Container-only path goes to the Container before it runs: the Worker Shell cannot see it.
      const judge = knowsContainerOnly(env) ? env : undefined;
      const named = judge === undefined ? undefined : commandPaths(args.command, env.cwd);

      if (
        judge !== undefined &&
        named !== undefined &&
        (await firstContainerOnly(judge, named.paths, context)) !== undefined
      ) {
        return runOn(env.onBackend("container"));
      }

      const asked = new Set(named?.paths);

      // Of the paths the Worker Shell did not find, those not asked about already: those were not Container-only.
      const containerOnlyMissing =
        judge === undefined || named === undefined
          ? undefined
          : (output: WorkerOutput) =>
              firstContainerOnly(
                judge,
                missingPaths(output, named.directories).filter((path) => !asked.has(path)),
                context,
              );

      try {
        return await runOn(
          attemptOn(worker, route.writes === undefined ? { containerOnlyMissing } : undefined),
        );
      } catch (error) {
        if (!(error instanceof RunOnContainer)) throw error;

        api.diagnostic({
          severity: "info",
          code: "container_fallback",
          message: `Ran on the container: ${error.message}`,
        });

        return runOn(env.onBackend("container"));
      }
    },
  });

/** What the model is told about the coding tools: each line, with the tools whose offer brings it. */
const GUIDELINES: readonly { readonly tools: readonly string[]; readonly line: string }[] = [
  {
    tools: ["read"],
    line: "Use `read` to look at files, not `cat`, `head`, `tail`, `sed -n` or `nl` in `bash`; read a range with its offset and limit.",
  },
  {
    tools: ["edit"],
    line: "Use `edit` to change a file: several `edits[]` in one call for separate places in one file. Never change files through `bash`: no python, node or perl scripts, `sed -i`, `awk`, heredocs or `cat >` to rewrite them.",
  },
  { tools: ["write"], line: "Use `write` only for a new file or a complete rewrite." },
  {
    tools: ["read", "write", "edit"],
    line: "Paths only the container has (anything outside /workspace, `/tmp` included, and dependency, build and cache directories such as `node_modules`, `.venv`, `target` and `.cache` inside it) are reached through the container: `read`, `write` and `edit` read and write them there, starting it if needed. Their files are on the container's disk and in its snapshot, not in the Workspace's files.",
  },
  {
    tools: ["grep", "find", "ls"],
    line: "Use `grep`, `find` and `ls` to search and list files rather than `bash`.",
  },
  {
    tools: ["bash"],
    line: "Use `bash` for what the file tools cannot do: tests, builds, package managers, git, and running programs. Leave its `backend` unset: routing keeps reads, searches and text processing on the cheap worker shell and starts the costly container only for what needs it (real binaries, the network, and git beyond status, log --oneline, branch and ls-files). Run related container commands together in one call (`pnpm install && pnpm test`) rather than one by one. A command naming a path only the container has (outside /workspace, `/tmp` included, or a dependency, build or cache directory such as `node_modules` inside it) is sent there by itself.",
  },
];

const Guidelines = section("coding_tools", (input) => {
  const offered = new Set(input.agent.tools.map((tool) => tool.name));

  const lines = GUIDELINES.flatMap(({ tools, line }) =>
    tools.some((tool) => offered.has(tool)) ? [`- ${line}`] : [],
  );

  return lines.length === 0 ? undefined : lines.join("\n");
});

/**
 * Puts the Call diffs of the `edit` and `write` calls a `codemode` script made in its result's `details`, keyed by the
 * call's number in the script: `details.diffs`. Each nested call's result is in its caller's `NestedCallDoc` when the
 * script ends, so this reads them there, in the `afterTool` of the `codemode` call itself. A script that failed partway
 * has its finished calls' diffs; one stopped before its result is stored has none (the Changes still show its changes).
 */
const CodemodeDiffs = hook(ToolTask, {
  afterTool: async (call, result, api, context) => {
    if (call.parent !== undefined || call.name !== "codemode" || result.details === undefined) {
      return undefined;
    }

    // The diffs are an extra: a failure to read them leaves the script's result as it is, and never fails the call.
    try {
      const diffs = await capturedDiffs(result.details, async (id) => {
        const nested = await api.snapshot(NestedCallDoc, api.taskId, `c${id}`, context);

        return nested?.result?.details;
      });

      if (Record.isEmptyRecord(diffs)) return undefined;

      // SAFETY: `result.details` is a JSON object here (`capturedDiffs` read its `calls`), and the diffs hold JSON values.
      const details = { ...(result.details as JsonObject), diffs } as JsonObject;

      return { ...result, details };
    } catch {
      return undefined;
    }
  },
});

/** What the coding tools are built with. */
export type CodingToolsOptions = {
  /** The Images binding `read` prepares images with (`./images.ts`); without one, pi-durable's own checks apply. */
  readonly images?: ImagesService;
};

/** `read`, `write`, `edit`, and `bash` with a `backend` argument, and the `coding_tools` section that says when to use each. */
export const codingToolsWith = (options: CodingToolsOptions): Extension =>
  defineExtension({
    name: "coding-tools",
    tools: [
      throughContainer(options.images === undefined ? createReadTool() : readTool(options.images)),
      throughContainer(writeTool()),
      throughContainer(createEditTool()),
      // Every Worker Shell runs computer's shell at the version the Workspaces Worker deployed, so one answer serves them
      // all; a Workspace DO still on older code may differ, and a command it cannot run falls back as any other does.
      bashTool(new Map()),
    ],
    sections: [Guidelines],
    hooks: [CodemodeDiffs],
  });

/** The coding tools, with `read` preparing images through the Session's `Images` binding. */
export const CodingTools: Effect.Effect<Extension, never, Images> = Effect.map(Images, (images) =>
  codingToolsWith({ images }),
);
