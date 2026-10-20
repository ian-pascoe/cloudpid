// The coding tools: pi-durable's `read`, `write`, and `edit`, and a `bash` that can choose where its command runs
// (docs/spec.md → Backends). `bash` is pi-durable's own tool with one more argument, `backend`; the rest of its
// behavior (streaming, output limits, spill, exit status) is pi-durable's.
//
// `backend` is explicit here: the model chooses. (Choosing for it from the command is a heuristic that would sit in
// front of this argument.) A call that names no backend runs wherever the environment runs commands by default, the
// Worker Shell on a Workspace.
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
  'Run the command on one of two backends, chosen with `backend` (default "worker"). Both see the same files in /workspace.',
  "- worker: a shell inside a Worker (just-bash). It starts instantly and handles text and file commands: cat, grep, sed, awk, jq, ls, git status and git diff. It cannot run native (ELF) binaries, so no node, npm, python, compilers, or test runners.",
  "- container: a real Linux container (Debian) with network access. Use it for anything that needs a real binary: npm, node, test runners, compilers, package managers, and toolchains installed with mise. It takes several seconds to start the first time, so prefer worker for simple text commands.",
].join("\n");

const parameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  backend: Type.Optional(
    Type.Union([Type.Literal("worker"), Type.Literal("container")], {
      description: "Where to run the command (default: worker); see the tool description",
    }),
  ),
});

const bash: ToolRegistration<typeof parameters> = defineTool({
  ...base,
  description: `${base.description}\n\n${backendDescription}`,
  parameters,
  async execute({ backend, ...args }, api, context) {
    // The default backend is the environment's own; naming it changes nothing where the environment has only one.
    if (backend === undefined) return base.execute(args, api, context);

    if (hasBackends(api.env)) {
      return base.execute(args, { ...api, env: api.env.onBackend(backend) }, context);
    }

    if (backend === "worker") return base.execute(args, api, context);

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
