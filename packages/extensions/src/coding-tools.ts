// The coding tools: pi-durable's `write` and `edit`; its `read`, wrapped so every image it returns fits the
// conversation (`./images/read.ts`, docs/spec.md → Filesystem and tools); and a `bash` that chooses where its command
// runs (docs/spec.md → Backends). `bash` is pi-durable's own tool with one more argument, `backend`; the rest of its
// behavior (streaming, output limits, spill, exit status) is pi-durable's.
//
// A call that names a `backend` runs there. One that names none is routed by its command (`bash-routing.ts`): the Worker
// Shell, unless the command needs a real binary, so the Container (the costly backend) starts only when a command needs
// it. A program the router does not know is asked of the Worker Shell first (`command -v`, remembered for the tool's
// life), and a command that writes no file runs again on the Container when the Worker Shell says it cannot run it (a
// missing program, an option its version lacks, a syntax it does not parse). An environment with no backends runs every command on itself.
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
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import {
  probeAnswer,
  probeScript,
  resolveRoute,
  routeCommand,
  workerShellCannot,
  type BashRoute,
} from "./bash-routing.ts";
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

const base = createBashTool();

const backendDescription = [
  "Commands run on one of two backends that share the same files in /workspace. Routing is automatic: leave `backend` unset and the cheapest backend that can run the command is chosen.",
  "- worker: a shell inside a Worker (just-bash). It starts instantly and costs almost nothing. It runs text and file commands: cat, grep, rg, sed, awk, jq, find, sort, head, diff, tar, ls and the like, with cd, pipes, redirects, globs, loops, `case` and substitutions, plus a read-only git: `git status` (one `XY path` line per changed file, `?` for untracked, nothing when clean; the staged column can be wrong, so use `git status --short` on the container after a `git add`), `git log --oneline`, `git rev-parse HEAD`, `git branch`, `git ls-files`. It has no network and cannot run native (ELF) binaries, so no node, npm, python, compilers, test runners, curl, or gh.",
  "- container: a real Linux container (Ubuntu 24.04) with network access, and the costly backend: it takes several seconds to start and is billed while it runs. It runs anything that needs a real binary: npm, node, python, test runners, compilers, package managers, gh, mise toolchains, docker (start its daemon with `cloudpid-dockerd`), all other git (diff, show, add, commit, branch changes, clone, push, pull; the GitHub token is set), and scripts (./script.sh). When it stops answering (every container command hangs, `echo` included), restart it with `restart_container`.",
  'Without `backend`, a command runs on the worker when the worker has every program in it, and on the container otherwise (also for a script path or `$CMD`); a command that writes no file is rerun on the container by itself when the worker rejects a program or option. So never set `backend` for reading, searching or listing (and to view a file, use `read` rather than `cat`). Override it with `"container"` only when the worker ran a command and its output was wrong; `"worker"` forces the fast shell.',
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

/** Why `result`, a command's on the Worker Shell with `chunks` of output, should run on the Container instead. */
const containerReason = (
  result: Awaited<ReturnType<ExecutionEnv["exec"]>>,
  chunks: readonly OutputChunk[],
): string | undefined => {
  if (!result.ok) return result.error.code === "spawn_error" ? result.error.message : undefined;

  const output = { stdout: "", stderr: "" };

  for (const [text, , info] of chunks) output[info.stream] += text;

  return workerShellCannot(output);
};

type OutputChunk = [text: string, context: Context, info: ShellOutputInfo];

/**
 * `worker`, holding back each command's output until it has ended. When `rerunnable` (the command writes no file) and
 * the Worker Shell could not run it (`workerShellCannot`, or it never started), the attempt throws `RunOnContainer`
 * with nothing delivered; otherwise its output is delivered as it came.
 */
const attemptOn = (worker: ExecutionEnv, rerunnable: boolean): ExecutionEnv => {
  const attempt: Pick<ExecutionEnv, "cwd" | "exec"> = {
    cwd: worker.cwd,
    exec: async (command, options, context) => {
      const chunks: OutputChunk[] = [];

      const result = await worker.exec(
        command,
        { ...options, onOutput: (...chunk) => chunks.push(chunk) },
        context,
      );

      const reason = rerunnable ? containerReason(result, chunks) : undefined;

      if (reason !== undefined) throw new RunOnContainer(reason);

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

      try {
        return await runOn(attemptOn(worker, route.writes === undefined));
      } catch (error) {
        if (!(error instanceof RunOnContainer)) throw error;

        api.diagnostic({
          severity: "info",
          code: "container_fallback",
          message: `Ran on the container: the worker could not (${error.message})`,
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
    tools: ["grep", "find", "ls"],
    line: "Use `grep`, `find` and `ls` to search and list files rather than `bash`.",
  },
  {
    tools: ["bash"],
    line: "Use `bash` for what the file tools cannot do: tests, builds, package managers, git, and running programs. Leave its `backend` unset: routing keeps reads, searches and text processing on the cheap worker shell and starts the costly container only for what needs it (real binaries, the network, and git beyond status, log --oneline, branch and ls-files). Run related container commands together in one call (`pnpm install && pnpm test`) rather than one by one.",
  },
];

const Guidelines = section("coding_tools", (input) => {
  const offered = new Set(input.agent.tools.map((tool) => tool.name));

  const lines = GUIDELINES.flatMap(({ tools, line }) =>
    tools.some((tool) => offered.has(tool)) ? [`- ${line}`] : [],
  );

  return lines.length === 0 ? undefined : lines.join("\n");
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
      options.images === undefined ? createReadTool() : readTool(options.images),
      createWriteTool(),
      createEditTool(),
      // Every Worker Shell runs computer's shell at the version the Workspaces Worker deployed, so one answer serves them
      // all; a Workspace DO still on older code may differ, and a command it cannot run falls back as any other does.
      bashTool(new Map()),
    ],
    sections: [Guidelines],
  });

/** The coding tools, with `read` preparing images through the Session's `Images` binding. */
export const CodingTools: Effect.Effect<Extension, never, Images> = Effect.map(Images, (images) =>
  codingToolsWith({ images }),
);
