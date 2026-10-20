// A pi-durable Harness over memory storage with the coding tools, a scripted model, and a fake execution environment that
// records the commands it is asked to run and on which backend. pi-durable's Harness and the faux provider are
// Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off strictEffectProvide:off preferEffectArray:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  type ExecutionEnv,
  type ExecutionError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { type BashBackend, CodingTools } from "./coding-tools.ts";

const context = BACKGROUND_CONTEXT;

/** A command the fake environment was asked to run. */
export type BackendCall = {
  /** The backend the call asked for; undefined when it ran on the environment itself. */
  readonly backend: BashBackend | undefined;
  readonly command: string;
  readonly timeout?: number | undefined;
};

export type CodingHarnessOptions = {
  /** Whether the environment can run on a chosen backend. */
  readonly backends: boolean;
  readonly exitCode?: number;
};

const callTool = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

type FakeShell = Pick<ExecutionEnv, "cwd" | "exec">;

// SAFETY: the tools under test use only `cwd` and `exec`, which the fake answers.
const asEnv = (fake: FakeShell): ExecutionEnv => fake as ExecutionEnv;

/** An environment whose commands only report where they ran. */
class FakeEnv implements FakeShell {
  readonly cwd = "/workspace";
  readonly #calls: BackendCall[];
  readonly #backend: BashBackend | undefined;
  readonly #exitCode: number;

  constructor(calls: BackendCall[], exitCode: number, backend?: BashBackend) {
    this.#calls = calls;
    this.#exitCode = exitCode;
    this.#backend = backend;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    ctx: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    this.#calls.push({
      backend: this.#backend,
      command: String(command),
      timeout: options?.timeout,
    });
    options?.onOutput?.(`${this.#backend ?? "default"}: ${String(command)}`, ctx, {
      stream: "stdout",
    });

    return ok({ exitCode: this.#exitCode });
  }
}

/** A fake environment that can also run on a chosen backend. */
class FakeBackendEnv extends FakeEnv {
  readonly #calls: BackendCall[];
  readonly #exitCode: number;

  constructor(calls: BackendCall[], exitCode: number) {
    super(calls, exitCode);
    this.#calls = calls;
    this.#exitCode = exitCode;
  }

  onBackend(backend: BashBackend): ExecutionEnv {
    return asEnv(new FakeEnv(this.#calls, this.#exitCode, backend));
  }
}

/** Open a Harness whose conversations run the coding tools in a fake environment. */
export const openCodingHarness = async (options: CodingHarnessOptions) => {
  const calls: BackendCall[] = [];
  const exitCode = options.exitCode ?? 0;
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();

  models.setProvider(faux.provider);
  registry.install(CodingTools);

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () =>
        asEnv(
          options.backends ? new FakeBackendEnv(calls, exitCode) : new FakeEnv(calls, exitCode),
        ),
    },
    context,
  );

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** Call `tool` with `args` as the model, and give the text it saw and whether it was an error. */
  const call = async (name: string, args: ToolCall["arguments"]) => {
    faux.setResponses([() => callTool(name, args), () => fauxAssistantMessage("done")]);
    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);

    const page = await root.entries({}, 50, undefined, context);
    const entry = Arr.findFirst(page.items, (item) => ToolResultEntry.is(item));
    const message = Option.getOrUndefined(entry)?.model?.[0];
    const content = message?.role === "toolResult" ? message.content : [];

    return {
      text: Arr.join(
        Arr.map(content, (block) => (block.type === "text" ? block.text : "")),
        "",
      ),
      isError: message?.role === "toolResult" && message.isError,
    };
  };

  return {
    call,
    calls,
    /** The registration of tool `name`, as the model is offered it. */
    tool: (name: string) => CodingTools.tools?.find((tool) => tool.name === name),
  };
};
