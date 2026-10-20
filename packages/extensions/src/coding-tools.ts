// The coding tools: pi-durable's `read`, `write`, and `edit`, and a `bash` that chooses where its command runs
// (docs/spec.md → Backends). `bash` is pi-durable's own tool with one more argument, `backend`; the rest of its
// behavior (streaming, output limits, spill, exit status) is pi-durable's.
//
// A call that names a `backend` runs there. One that names none is routed by its command (`bash-routing.ts`): the Worker
// Shell, unless the command needs a real binary, so the Container starts only when a command needs it. An environment
// with no backends runs every command on itself.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { routeCommand } from "./bash-routing.ts";

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
  "Commands run on one of two backends that share the same files in /workspace. Routing is automatic: the command's programs decide, and an explicit `backend` overrides it.",
  "- worker: a shell inside a Worker (just-bash). It starts instantly and runs text and file commands: cat, grep, rg, sed, awk, jq, find, sort, head, tar, ls and the like, with pipes, redirects, and globs, plus git for status, diff, log, show, add, and commit. It has no network and cannot run native (ELF) binaries, so no node, npm, python, compilers, test runners, curl, or gh.",
  "- container: a real Linux container (Debian) with network access. It runs anything that needs a real binary: npm, node, python, test runners, compilers, package managers, gh, mise toolchains, git clone/push/pull (with the GitHub token), and scripts (./script.sh). The first command takes several seconds to start it.",
  'Without `backend`, a command goes to the Container when it uses any program the worker lacks (or one you cannot tell, like a script path or `$CMD`) and to the worker otherwise. Set `backend` to override: `"container"` for a command that failed on the worker with "command not found" or an unsupported feature, `"worker"` to force the fast shell.',
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

const bash: ToolRegistration<typeof parameters> = defineTool({
  ...base,
  description: `${base.description}\n\n${backendDescription}`,
  parameters,
  async execute({ backend, ...args }, api, context) {
    if (hasBackends(api.env)) {
      const chosen = backend ?? routeCommand(args.command).backend;

      return base.execute(args, { ...api, env: api.env.onBackend(chosen) }, context);
    }

    // An environment with one backend runs every command there; only a Container is something it cannot give.
    if (backend !== "container") return base.execute(args, api, context);

    throw new Error(
      `This environment has no container backend: run the command without \`backend\`.`,
    );
  },
});

/** `read`, `write`, `edit`, and `bash` with a `backend` argument. */
export const CodingTools = defineExtension({
  name: "coding-tools",
  tools: [createReadTool(), createWriteTool(), createEditTool(), bash],
});
