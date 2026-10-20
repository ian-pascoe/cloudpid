// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` and its `SessionSockets` over the faux provider,
// as the Session DO hosts them over the model proxy. Tests drive it with `runInDurableObject()` and client sockets,
// evict it, and run its alarm.
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
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { sessionExtensions } from "./extensions.ts";
import { type Answer, SessionHost, sessionHostLayer, type SessionHostService } from "./host.ts";
import { SessionSockets, sessionSocketsLayer, type SessionSocketsService } from "./sockets.ts";
import { ReportError, SessionRegistry, type SessionStatus } from "./status.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const AGENT = { model: { provider: "faux", modelId: "faux-1" } } as const;

/** A scripted response that calls tool `name` with the JSON arguments `args`. */
const CALL = /^call:(\w+):(.*)$/;

/**
 * Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort,
 * `call:<tool>:<json arguments>` calls a tool, and `gate:<response>` gives `response` once the test opens the gate.
 */
type Script = { readonly responses: readonly string[]; readonly next: number };

/** The scripted response `text`: a tool call or an answer. */
const respond = (text: string) => {
  const call = CALL.exec(text);

  return call === null
    ? fauxAssistantMessage(text)
    : fauxAssistantMessage([fauxToolCall(call[1] ?? "", JSON.parse(call[2] ?? "{}"))], {
        stopReason: "toolUse",
      });
};

declare global {
  /** See `constructions`. */
  var testSessionConstructions: Map<string, number> | undefined;
}

/**
 * How many instances of each test Session were constructed, by object ID. Kept in the isolate's global scope, which
 * the tests share, so a test can read it without waking an object.
 */
export const constructions = (globalThis.testSessionConstructions ??= new Map<string, number>());

/** Text submitted to the root conversation, as the tests write it. */
type TestPrompt = { readonly requestId: string; readonly text: string };

export class TestSession extends DurableObject {
  #host!: SessionHostService;
  #sockets!: SessionSocketsService;
  #runtime!: ManagedRuntime.ManagedRuntime<SessionHost | SessionSockets | Harness, unknown>;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Holds back this instance's `gate:` responses until `open()`. */
  readonly #gate = Promise.withResolvers<void>();
  /** Resolves when this instance's model request reaches the gate. */
  readonly gated = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    constructions.set(ctx.id.toString(), (constructions.get(ctx.id.toString()) ?? 0) + 1);

    const faux = fauxProvider();

    faux.setResponses(Array.from({ length: 8 }, () => this.#step()));

    const models = createModels();

    models.setProvider(faux.provider);
    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionSocketsLayer(ctx).pipe(
          Layer.provideMerge(
            sessionHostLayer({
              storage: ctx.storage,
              models,
              agent: AGENT,
              reset: (reason) => ctx.abort(reason),
              extensions: sessionExtensions,
              reportTimeout: "200 millis",
            }).pipe(
              Layer.provide(
                Layer.succeed(SessionRegistry, {
                  report: (status) =>
                    Effect.tryPromise({
                      try: () => this.#report(status),
                      catch: (cause) => ReportError.make({ message: String(cause) }),
                    }),
                }),
              ),
            ),
          ),
        ),
      );

      const context = await this.#runtime.context();

      this.#host = Context.get(context, SessionHost);
      this.#sockets = Context.get(context, SessionSockets);
    });
  }

  /** A client's socket to the Session, as the Session DO answers the main Worker's upgrade. */
  override async fetch(): Promise<Response> {
    return new Response(null, {
      status: 101,
      webSocket: await Effect.runPromise(this.#sockets.connect),
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await Effect.runPromise(this.#sockets.receive(socket, message));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await Effect.runPromise(this.#sockets.drop(socket));
  }

  /** Let this instance's `gate:` responses through. */
  open(): void {
    this.#gate.resolve();
  }

  /** Whether no work is live; reads only, so it never runs work itself. */
  idle(): Promise<boolean> {
    return Effect.runPromise(this.#host.idle);
  }

  submit({ requestId, text }: TestPrompt): Promise<number> {
    return Effect.runPromise(this.#host.submit({ requestId, input: text }));
  }

  prompt({ requestId, text }: TestPrompt): Promise<Answer> {
    return Effect.runPromise(this.#host.prompt({ requestId, input: text }));
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

  /** Report this Session's status to the Registry object named `registry`, as the Session DO does to the Registry DO. */
  reportTo(registry: string): void {
    this.ctx.storage.kv.put("registry", registry);
  }

  /** Make status reports fail until `reports("working")`, or hang. */
  reports(mode: "working" | "failing" | "hanging"): void {
    this.ctx.storage.kv.put("reportMode", mode);
  }

  /** The statuses this Session reported, oldest first, counting only reports the Registry received. */
  reported(): readonly SessionStatus[] {
    return this.ctx.storage.kv.get<SessionStatus[]>("reported") ?? [];
  }

  /** How many status reports this Session has tried to make, delivered or not. */
  reportAttempts(): number {
    return this.ctx.storage.kv.get<number>("reportAttempts") ?? 0;
  }

  script(responses: readonly string[]): void {
    this.ctx.storage.kv.put("script", { responses, next: 0 } satisfies Script);
  }

  override async alarm(): Promise<void> {
    await Effect.runPromise(this.#host.alarm);
  }

  async #report(status: SessionStatus): Promise<void> {
    const registry = this.ctx.storage.kv.get<string>("registry");

    if (registry === undefined) return;

    const { kv } = this.ctx.storage;
    const mode = kv.get<string>("reportMode");

    kv.put("reportAttempts", (kv.get<number>("reportAttempts") ?? 0) + 1);

    if (mode === "failing") throw new Error("Registry is down");

    if (mode === "hanging") await new Promise(() => undefined);

    await this.env.REGISTRIES.getByName(registry).setSessionStatus(
      this.ctx.id.name ?? "",
      status,
      Date.now(),
    );
    kv.put("reported", [...(kv.get<SessionStatus[]>("reported") ?? []), status]);
  }

  /** The next scripted response; the script position is stored before the response is used. */
  #step(): FauxResponseStep {
    return (_request, options) => {
      const script = this.ctx.storage.kv.get<Script>("script") ?? { responses: [], next: 0 };
      const text = script.responses[script.next] ?? "unscripted";

      this.ctx.storage.kv.put("script", { ...script, next: script.next + 1 });

      if (text.startsWith("gate:")) {
        this.gated.resolve();

        return this.#gate.promise.then(() => respond(text.slice("gate:".length)));
      }

      if (text !== "hang") return respond(text);
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
