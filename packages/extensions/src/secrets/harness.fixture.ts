// A pi-durable Harness over memory storage with the secrets extension, the coding tools over a fake environment, and
// stand-in tools, driven by a scripted model whose requests are recorded. Time is a `TestClock`, so a test can pass a
// Secret's lifetime at once. pi-durable's Harness and the faux provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off globalRandom:off preferSchemaOverJson:off strictEffectProvide:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  type JsonObject,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import {
  type ExecutionEnv,
  type ExecutionError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";
import { codingToolsWith } from "../coding-tools.ts";
import { programExtension } from "../program.fixture.ts";
import { secretsExtension } from "./extension.ts";
import { scrubbingModels } from "./models.ts";
import type { KeptSecret } from "./kept.ts";
import type { SecretKeep } from "@cloudpid/protocol";
import {
  type KeepRequest,
  type KeepResult,
  type SecretAsk,
  Secrets,
  secretsLayer,
  type SecretStorage,
} from "./store.ts";
import { openVault } from "./vault.ts";

export const context = BACKGROUND_CONTEXT;

const MASTER = "test-master-key-0123456789abcdef0123456789";

/** A command the fake environment ran, with the environment it was given. */
export type Exec = { readonly command: string; readonly env: Readonly<Record<string, string>> };

/**
 * A shell that expands `$NAME` from the command's environment and prints the command it ran, five characters at a
 * time, so a value it prints arrives split across chunks.
 */
class FakeEnv implements Pick<ExecutionEnv, "cwd" | "exec"> {
  readonly cwd = "/workspace";
  readonly #execs: Exec[];

  constructor(execs: Exec[]) {
    this.#execs = execs;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    ctx: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const env = options?.env ?? {};

    const text = String(command).replace(
      /\$([A-Z_][A-Z0-9_]*)/g,
      (_, name: string) => env[name] ?? "",
    );

    this.#execs.push({ command: String(command), env });

    for (let index = 0; index < text.length; index += 5) {
      options?.onOutput?.(text.slice(index, index + 5), ctx, { stream: "stdout" });
    }

    return ok({ exitCode: 0 });
  }
}

// SAFETY: the tools under test use only `cwd` and `exec`, which the fake answers.
const asEnv = (fake: Pick<ExecutionEnv, "cwd" | "exec">): ExecutionEnv => fake as ExecutionEnv;

/** Stand-ins that use Secrets: `record` keeps the arguments it ran with and returns them as text; `stream` prints
 * `text` in two halves and returns the output the Harness retained. */
const usingSecrets = (recorded: JsonObject[]) =>
  defineExtension({
    name: "using-secrets",
    tools: [
      defineTool({
        name: "record",
        description: "Record text",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (args) => {
          recorded.push(args);

          return { output: [{ type: "text", text: `recorded: ${args.text}` }] };
        },
      }),
      defineTool({
        name: "stream",
        description: "Stream text",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (args, api) => {
          const half = Math.floor(args.text.length / 2);

          api.output(args.text.slice(0, half));
          api.output(args.text.slice(half));

          const retained = api.retainedOutput().text;

          recorded.push({ retained });

          return { output: [{ type: "text", text: "streamed" }] };
        },
      }),
    ],
  });

/** A response that calls tool `name` with `args`. */
export const call = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${Math.random()}` })], {
    stopReason: "toolUse",
  });

export const answer = (text: string): AssistantMessage => fauxAssistantMessage(text);

/** Open a Harness whose model answers each request with the next of `responses`, then "done". */
export const openSecretsHarness = async (
  /** Extensions installed beside the stand-ins, before the secrets extension so its hooks see their results. */
  beside: readonly Extension[] = [],
  /** The Secrets kept for the Session's Environment, as the Registry would hand them. */
  kept?: ReadonlyArray<KeptSecret>,
  /** What keeps the Secrets the owner chooses to keep: it may change `registry.secrets`, which `kept` reads. */
  keep?: (request: KeepRequest, registry: { secrets: KeptSecret[] }) => ReadonlyArray<KeepResult>,
  /** Extensions installed after the secrets extension, as the Session installs `ResultBounds`. */
  after: readonly Extension[] = [],
) => {
  const registry = { secrets: [...(kept ?? [])] };
  const runtime = ManagedRuntime.make(TestClock.layer());
  const execs: Exec[] = [];
  const recorded: JsonObject[] = [];
  const requests: Message[][] = [];
  const announced: (readonly SecretAsk[])[] = [];
  const map = new Map<string, unknown>();

  const storage: SecretStorage = {
    // SAFETY: the store reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  const secrets = await runtime.runPromise(
    Effect.gen(function* () {
      const vault = yield* openVault(MASTER, "session-1");

      return yield* Effect.provide(
        Effect.service(Secrets),
        secretsLayer({
          storage,
          vault,
          announce: (asks) =>
            Effect.sync(() => {
              announced.push(asks);
            }),
          kept: kept === undefined ? undefined : Effect.sync(() => registry.secrets),
          keep:
            keep === undefined
              ? undefined
              : (request) => Effect.sync(() => keep(request, registry)),
        }),
      );
    }),
  );

  const resolving = usingSecrets(recorded);
  const coding = codingToolsWith({});

  const secretsExt = await runtime.runPromise(
    secretsExtension([...(coding.tools ?? []), ...(resolving.tools ?? [])]).pipe(
      Effect.provideService(Secrets, secrets),
    ),
  );

  const faux = fauxProvider();
  const models = createModels();
  const tools = createRegistry();
  let script: AssistantMessage[] = [];

  models.setProvider(faux.provider);

  // As the Session DO installs it: every model call, not only generations, is scrubbed.
  const scrubbed = scrubbingModels(models, secrets);
  faux.setResponses(
    Array.from({ length: 100 }, () => (transcript: { readonly messages: readonly Message[] }) => {
      requests.push(structuredClone([...transcript.messages]));

      return script.shift() ?? answer("done");
    }),
  );
  tools.install(coding);
  tools.install(resolving);
  tools.install(programExtension);

  for (const extension of beside) tools.install(extension);

  tools.install(secretsExt);

  for (const extension of after) tools.install(extension);

  const harness = await Harness.open(
    new MemoryStorage(),
    { models: scrubbed, registry: tools, env: () => asEnv(new FakeEnv(execs)) },
    context,
  );

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** Submit `content` with the model answering `responses` in turn, and wait for the run to end. */
  const prompt = async (content: string, ...responses: AssistantMessage[]) => {
    script = responses;

    return (await root.submit({ type: "input", content }, context)).wait(context);
  };

  /** Wait until `check` holds, for up to five seconds. */
  const until = async (check: () => Promise<boolean>, what: string) => {
    for (let tries = 0; tries < 500; tries++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for ${what}`);
  };

  /** Wait for an ask, and answer it as the owner does in the masked form. */
  const enter = async (values: Readonly<Record<string, string>> | null, choice?: SecretKeep) => {
    await until(
      async () => (await runtime.runPromise(secrets.pending)).length > 0,
      "a Secret request",
    );

    const [ask] = await runtime.runPromise(secrets.pending);

    await runtime.runPromise(secrets.answer(ask!.id, values, choice));

    return ask!;
  };

  /** Hold `values` as if the owner had entered them for an ask the agent made. */
  const hold = async (values: Readonly<Record<string, string>>) => {
    const running = prompt("I need secrets", call("secret_ask", { names: Object.keys(values) }));

    await enter(values);
    await running;
  };

  /** Every stored entry of the root conversation, as JSON. */
  const transcript = async () => {
    const page = await root.entries({ order: "ascending" }, 500, undefined, context);

    return JSON.stringify(page.items);
  };

  /** The text of the last tool result of the root conversation. */
  const lastResult = async () => {
    const page = await root.entries({}, 50, undefined, context);
    const entry = page.items.find((item) => ToolResultEntry.is(item));
    const message = entry?.model?.[0];

    return message?.role === "toolResult"
      ? {
          text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          isError: message.isError,
        }
      : undefined;
  };

  return {
    prompt,
    enter,
    registry,
    hold,
    transcript,
    lastResult,
    execs,
    recorded,
    requests,
    announced,
    /** The Harness's models, which an extension's own model calls (summaries, titles) go through. */
    models: scrubbed,
    dump: () => JSON.stringify([...map]),
    advance: (millis: number) => runtime.runPromise(TestClock.adjust(millis)),
  };
};
