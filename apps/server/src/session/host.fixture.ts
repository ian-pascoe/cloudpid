// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` over the faux provider, as the Session DO
// hosts one over the model proxy. Tests drive it with `runInDurableObject()`, evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { type Answer, openSessionHost, type Prompt, type SessionHost } from "./host.ts";

/** Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort. */
type Script = { readonly responses: readonly string[]; readonly next: number };

export class TestSession extends DurableObject {
  #host!: SessionHost;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    const faux = fauxProvider();

    faux.setResponses(Array.from({ length: 8 }, () => this.#step()));

    const models = createModels();

    models.setProvider(faux.provider);
    void ctx.blockConcurrencyWhile(async () => {
      this.#host = await Effect.runPromise(
        openSessionHost(ctx.storage, {
          models,
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        }),
      );
    });
  }

  submit(prompt: Prompt): Promise<number> {
    return Effect.runPromise(this.#host.submit(prompt));
  }

  prompt(prompt: Prompt): Promise<Answer> {
    return Effect.runPromise(this.#host.prompt(prompt));
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
