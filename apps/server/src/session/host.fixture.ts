// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` over the faux provider, as the Session DO
// hosts one over the model proxy. Tests drive it with `runInDurableObject()`, evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import { callDurable, Harness } from "@cloudpid/effect-durable";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { sessionExtensions } from "./extensions.ts";
import {
  type Answer,
  type Prompt,
  SessionHost,
  sessionHostLayer,
  type SessionHostService,
} from "./host.ts";

const AGENT = { model: { provider: "faux", modelId: "faux-1" } } as const;

/** A scripted response that calls tool `name` with the JSON arguments `args`. */
const CALL = /^call:(\w+):(.*)$/;

/**
 * Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort, and
 * `call:<tool>:<json arguments>` calls a tool.
 */
type Script = { readonly responses: readonly string[]; readonly next: number };

export class TestSession extends DurableObject {
  #host!: SessionHostService;
  #runtime!: ManagedRuntime.ManagedRuntime<SessionHost | Harness, unknown>;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    const faux = fauxProvider();

    faux.setResponses(Array.from({ length: 8 }, () => this.#step()));

    const models = createModels();

    models.setProvider(faux.provider);
    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionHostLayer({
          storage: ctx.storage,
          models,
          agent: AGENT,
          reset: (reason) => ctx.abort(reason),
          extensions: sessionExtensions,
        }),
      );
      this.#host = Context.get(await this.#runtime.context(), SessionHost);
    });
  }

  /** Whether no work is live; reads only, so it never runs work itself. */
  idle(): Promise<boolean> {
    return Effect.runPromise(this.#host.idle);
  }

  submit(prompt: Prompt): Promise<number> {
    return Effect.runPromise(this.#host.submit(prompt));
  }

  prompt(prompt: Prompt): Promise<Answer> {
    return Effect.runPromise(this.#host.prompt(prompt));
  }

  /** The text of each tool result in the root transcript, oldest first. */
  toolResults(): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root(AGENT);

        const page = yield* callDurable("entries", (context) =>
          root.entries({}, 100, undefined, context),
        );

        return Arr.flatMap(Arr.reverse(page.items), (entry) => {
          const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;

          return message?.role === "toolResult"
            ? [
                Arr.join(
                  Arr.flatMap(message.content, (block) =>
                    block.type === "text" ? [block.text] : [],
                  ),
                  "",
                ),
              ]
            : [];
        });
      }),
    );
  }

  script(responses: readonly string[]): void {
    this.ctx.storage.kv.put("script", { responses, next: 0 } satisfies Script);
  }

  override async alarm(): Promise<void> {
    await Effect.runPromise(this.#host.alarm);
  }

  /** The next scripted response; the script position is stored before the response is used. */
  #step(): FauxResponseStep {
    return (_request, options) => {
      const script = this.ctx.storage.kv.get<Script>("script") ?? { responses: [], next: 0 };
      const text = script.responses[script.next] ?? "unscripted";

      this.ctx.storage.kv.put("script", { ...script, next: script.next + 1 });

      const call = CALL.exec(text);

      if (call !== null) {
        return fauxAssistantMessage([fauxToolCall(call[1] ?? "", JSON.parse(call[2] ?? "{}"))], {
          stopReason: "toolUse",
        });
      }

      if (text !== "hang") return fauxAssistantMessage(text);
      this.hanging.resolve();

      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"));

        if (options?.signal?.aborted === true) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
  }
}

export default {
  fetch: () => new Response("cloudpid Session host test worker"),
};
