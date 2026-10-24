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
  type BinaryReader,
  err,
  type ExecutionEnv,
  type ExecutionError,
  FileError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { type BashBackend, codingToolsWith } from "./coding-tools.ts";
import type { ImagesService } from "./images.ts";

const context = BACKGROUND_CONTEXT;

/** A command the fake environment was asked to run. */
export type BackendCall = {
  /** The backend the call asked for; undefined when it ran on the environment itself. */
  readonly backend: BashBackend | undefined;
  readonly command: string;
  readonly timeout?: number | undefined;
};

/** What the fake environment answers a command with, instead of naming where it ran. */
export type FakeAnswer = {
  readonly output: string;
  /** The stream the output is on; stdout by default. */
  readonly stream?: "stdout" | "stderr";
  readonly exitCode?: number;
};

/** How the fake environment answers `command` on `backend`; undefined for the default answer. */
export type Respond = (backend: BashBackend | undefined, command: string) => FakeAnswer | undefined;

export type CodingHarnessOptions = {
  /** Whether the environment can run on a chosen backend. */
  readonly backends: boolean;
  readonly exitCode?: number;
  /** Answers for some commands; every other prints where it ran, as `<backend>: <command>`. */
  readonly respond?: Respond;
  /** The files the environment holds, by absolute path, for `read`. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
  /** The Images binding `read` prepares images with; none by default. */
  readonly images?: ImagesService;
  /**
   * Whether a path is Container-only, as the environment answers `containerOnly`; `"fails"` answers with an error.
   * Without it, the environment has no `containerOnly`.
   */
  readonly containerOnly?: ((path: string) => boolean) | "fails";
};

/** What the model saw of a call: the text, whether it was an error, and the images, when there were any. */
export type CallResult = {
  text: string;
  isError: boolean;
  images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
};

/** What the environment's file reads did: the most bytes one read asked for. */
export type FileReads = { largest: number };

const callTool = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

type FakeShell = Pick<
  ExecutionEnv,
  "cwd" | "exec" | "absolutePath" | "exists" | "openBinaryReader"
>;

// SAFETY: the tools under test use only `cwd`, `exec` and the file reads `read` makes, which the fake answers.
const asEnv = (fake: FakeShell): ExecutionEnv => fake as ExecutionEnv;

/** A reader of `bytes` that records the largest read in `reads`. */
const readerOf = (path: string, bytes: Uint8Array, reads: FileReads): BinaryReader => ({
  info: async () =>
    ok({ name: path, path, kind: "file" as const, size: bytes.byteLength, mtimeMs: 0 }),
  read: async (offset, length) => {
    reads.largest = Math.max(reads.largest, length);

    return ok(bytes.slice(offset, offset + length));
  },
  scanLines: async () => err(new FileError("not_supported", "Not a text file", path)),
  close: async () => {},
});

/** What every fake environment of one Harness shares. */
type FakeSetup = {
  readonly calls: BackendCall[];
  readonly exitCode: number;
  readonly respond: Respond;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly reads: FileReads;
  /** The paths of each `containerOnly` call. */
  readonly asked: (readonly string[])[];
};

/** An environment whose commands report where they ran (or answer as `respond` says), and whose files are `files`. */
class FakeEnv implements FakeShell {
  readonly cwd = "/workspace";
  readonly #calls: BackendCall[];
  readonly #backend: BashBackend | undefined;
  readonly #exitCode: number;
  readonly #respond: Respond;
  readonly #files: Readonly<Record<string, Uint8Array>>;
  readonly #reads: FileReads;

  constructor(setup: FakeSetup, backend?: BashBackend) {
    this.#calls = setup.calls;
    this.#exitCode = setup.exitCode;
    this.#respond = setup.respond;
    this.#files = setup.files;
    this.#reads = setup.reads;
    this.#backend = backend;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(path.startsWith("/") ? path : `${this.cwd}/${path}`);
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    return ok(path in this.#files);
  }

  async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const bytes = this.#files[path];

    return bytes === undefined
      ? err(new FileError("not_found", "No such file", path))
      : ok(readerOf(path, bytes, this.#reads));
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
    const answer = this.#respond(this.#backend, String(command));

    options?.onOutput?.(
      answer?.output ?? `${this.#backend ?? "default"}: ${String(command)}`,
      ctx,
      { stream: answer?.stream ?? "stdout" },
    );

    return ok({ exitCode: answer?.exitCode ?? this.#exitCode });
  }
}

/** A fake environment that can also run on a chosen backend. */
class FakeBackendEnv extends FakeEnv {
  readonly #setup: FakeSetup;

  constructor(setup: FakeSetup) {
    super(setup);
    this.#setup = setup;
  }

  onBackend(backend: BashBackend): ExecutionEnv {
    return asEnv(new FakeEnv(this.#setup, backend));
  }
}

/** A fake environment with backends that says which paths are Container-only, as `isContainerOnly` does. */
class FakeContainerOnlyEnv extends FakeBackendEnv {
  readonly #asked: (readonly string[])[];
  readonly #isContainerOnly: ((path: string) => boolean) | "fails";

  constructor(setup: FakeSetup, isContainerOnly: ((path: string) => boolean) | "fails") {
    super(setup);
    this.#asked = setup.asked;
    this.#isContainerOnly = isContainerOnly;
  }

  async containerOnly(paths: readonly string[]): Promise<Result<readonly boolean[], FileError>> {
    this.#asked.push(paths);

    const isContainerOnly = this.#isContainerOnly;

    return isContainerOnly === "fails"
      ? err(new FileError("unknown", "The Workspace did not answer", paths[0] ?? ""))
      : ok(paths.map((path) => isContainerOnly(path)));
  }
}

/** The environment `options` describe. */
const fakeEnv = (options: CodingHarnessOptions, setup: FakeSetup): ExecutionEnv => {
  if (!options.backends) return asEnv(new FakeEnv(setup));

  return asEnv(
    options.containerOnly === undefined
      ? new FakeBackendEnv(setup)
      : new FakeContainerOnlyEnv(setup, options.containerOnly),
  );
};

/** Open a Harness whose conversations run the coding tools in a fake environment. */
export const openCodingHarness = async (options: CodingHarnessOptions) => {
  const calls: BackendCall[] = [];
  const reads: FileReads = { largest: 0 };
  const asked: (readonly string[])[] = [];

  const setup: FakeSetup = {
    calls,
    exitCode: options.exitCode ?? 0,
    respond: options.respond ?? (() => undefined),
    files: options.files ?? {},
    reads,
    asked,
  };

  const tools = codingToolsWith(options.images === undefined ? {} : { images: options.images });
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();

  models.setProvider(faux.provider);
  registry.install(tools);

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => fakeEnv(options, setup),
    },
    context,
  );

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /**
   * Call `tool` with `args` as the model, and give the text it saw and whether it was an error; and the images it saw,
   * when there were any.
   */
  const call = async (name: string, args: ToolCall["arguments"]) => {
    faux.setResponses([() => callTool(name, args), () => fauxAssistantMessage("done")]);
    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);

    const page = await root.entries({}, 50, undefined, context);
    const entry = Arr.findFirst(page.items, (item) => ToolResultEntry.is(item));
    const message = Option.getOrUndefined(entry)?.model?.[0];
    const content = message?.role === "toolResult" ? message.content : [];

    const images = Arr.flatMap(content, (block) =>
      block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : [],
    );

    const result: CallResult = {
      text: Arr.join(
        Arr.map(content, (block) => (block.type === "text" ? block.text : "")),
        "",
      ),
      isError: message?.role === "toolResult" && message.isError,
    };

    if (images.length > 0) result.images = images;

    return result;
  };

  return {
    call,
    calls,
    reads,
    /** The paths of each `containerOnly` call the environment answered. */
    asked,
    /** The registration of tool `name`, as the model is offered it. */
    tool: (name: string) => tools.tools?.find((tool) => tool.name === name),
  };
};
