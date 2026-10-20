// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` and its `SessionSockets` over the faux provider,
// as the Session DO hosts them over the model proxy. Tests drive it with `runInDurableObject()` and client sockets,
// evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import { callDurable, defineEffectTool, Harness } from "@cloudpid/effect-durable";
import { imageLimitedModels } from "@cloudpid/extensions/browser";
import { scrubbingModels, Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentChange,
  defineExtension,
  type Extension,
  type HarnessOptions,
  type SnapshotEvent,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { sessionSecretsLayer } from "./secrets.ts";
import { sessionSettingsLayer } from "./settings.ts";
import { type Answer, SessionHost, sessionHostLayer, type SessionHostService } from "./host.ts";
import { SessionSockets, sessionSocketsLayer, type SessionSocketsService } from "./sockets.ts";
import type { PushEvent } from "../push/notification.ts";
import { ReportError, SessionRegistry, type SessionStatus } from "./status.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

/** A tool to call, so a Run has a tool call in its transcript: `echo` answers `echo: <text>`. */
const Echo = defineEffectTool({
  name: "echo",
  description: "Echo text back",
  parameters: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: [{ type: "text", text: `echo: ${text}` }] }),
});

/** The models the test provider serves: those the default settings and a Session's choice may name. */
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** The model and thinking level a request asked for. */
export type TestRequest = { readonly model: string; readonly thinking: string | undefined };

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

  // `error:<message>` is a model error that is not worth retrying.
  if (text.startsWith("error:")) {
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: text.slice("error:".length),
    });
  }

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

/** The test Worker's `SECRETS_ENCRYPTION_KEY`. */
const SECRETS_KEY = Redacted.make("test-secrets-encryption-key-0123456789abcdef");

export class TestSession extends DurableObject {
  /** The extensions this Session runs with, installed before any work resumes: `echo`, which uses Secrets, and the secret tools. */
  protected hostExtensions(): Effect.Effect<readonly Extension[], never, Harness | Secrets> {
    return Effect.gen(function* () {
      const tool = yield* Echo;
      const echo = defineExtension({ name: "echo", tools: [tool] });

      return [echo, yield* secretsExtension([tool])];
    });
  }

  /** What builds a conversation's execution environment, if this Session has one. */
  protected hostEnv(): HarnessOptions["env"] | undefined {
    return undefined;
  }

  #host!: SessionHostService;
  #sockets!: SessionSocketsService;
  #runtime!: ManagedRuntime.ManagedRuntime<
    SessionHost | SessionSockets | Harness | Secrets,
    unknown
  >;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Holds back this instance's `gate:` responses until `open()`. */
  readonly #gate = Promise.withResolvers<void>();
  /** Resolves when this instance's model request reaches the gate. */
  readonly gated = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    constructions.set(ctx.id.toString(), (constructions.get(ctx.id.toString()) ?? 0) + 1);

    // As the model proxy's provider is named, so the settings' model ids resolve.
    const faux = fauxProvider({
      provider: "anthropic",
      models: Arr.map(MODELS, (id) => ({ id, reasoning: true })),
    });

    faux.setResponses(Array.from({ length: 8 }, () => this.#step()));

    const models = createModels();

    models.setProvider(faux.provider);
    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionSocketsLayer(ctx).pipe(
          Layer.provideMerge(
            sessionHostLayer({
              storage: ctx.storage,
              // As the Session DO's: every model call is scrubbed of the Secrets the Session holds.
              models: Effect.map(Effect.service(Secrets), (held) =>
                scrubbingModels(imageLimitedModels(models), held),
              ),
              reset: (reason) => ctx.abort(reason),
              extensions: this.hostExtensions(),
              env: this.hostEnv(),
              reportTimeout: "200 millis",
              wakeAt: Effect.flatMap(Effect.service(Secrets), (held) => held.nextExpiry),
              onIdle: Effect.flatMap(Effect.service(Secrets), (held) => held.dropAbandoned),
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SessionRegistry, {
                    report: (status) =>
                      Effect.tryPromise({
                        try: () => this.#report(status),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                    notify: (event) =>
                      Effect.tryPromise({
                        try: () => this.#notify(event),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                  }),
                  sessionSettingsLayer({
                    read: Effect.orDie(Effect.tryPromise(() => this.#readSettings())),
                    kv: ctx.storage.kv,
                    timeout: "200 millis",
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            sessionSecretsLayer({
              encryptionKey: SECRETS_KEY,
              session: ctx.id.toString(),
              storage: ctx.storage.kv,
              sockets: ctx,
              notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
            }),
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

  /** The snapshot a client's watch of the root conversation starts with, as the Session sends it. */
  snapshot(): Promise<SnapshotEvent> {
    const host = this.#host;

    return Effect.runPromise(
      Effect.flatMap(host.root, (root) => Stream.runHead(host.events(root))).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.die("No snapshot"), onSome: Effect.succeed }),
        ),
        Effect.flatMap((batch) => {
          const [first] = batch;

          return first?.type === "snapshot" ? Effect.succeed(first) : Effect.die("Not a snapshot");
        }),
      ),
    );
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
        const root = yield* harness.root({});

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

  /** Stop the root conversation's run, as a client's `abort` does. */
  abortRoot(): Promise<void> {
    return Effect.runPromise(this.#host.abort());
  }

  /** Make notifications fail until `notifications("working")`. */
  notifications(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("notifyMode", mode);
  }

  /** The notifications this Session made, oldest first, counting only those the Registry received. */
  notified(): readonly PushEvent[] {
    return this.ctx.storage.kv.get<PushEvent[]>("notified") ?? [];
  }

  /** How many status reports this Session has tried to make, delivered or not. */
  reportAttempts(): number {
    return this.ctx.storage.kv.get<number>("reportAttempts") ?? 0;
  }

  /** Pick the root conversation's model and thinking level, as a client's `configure` does. */
  configure(change: AgentChange): Promise<void> {
    return Effect.runPromise(this.#host.configure(change));
  }

  /** The model and thinking level of each request the model received, oldest first. */
  requests(): readonly TestRequest[] {
    return this.ctx.storage.kv.get<TestRequest[]>("requests") ?? [];
  }

  /** Make reading the Registry's settings fail until `settingsRegistry("working")`. */
  settingsRegistry(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("settingsMode", mode);
  }

  script(responses: readonly string[]): void {
    this.ctx.storage.kv.put("script", { responses, next: 0 } satisfies Script);
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(
      Effect.flatMap(Effect.service(Secrets), (held) => held.sweep).pipe(
        Effect.andThen(this.#host.alarm),
      ),
    );
  }

  /** Hold `values` as if the owner had entered them for a request. */
  hold(values: Readonly<Record<string, string>>): Promise<void> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const request = { id: "test-hold", conversationId: 1, names: Record.keys(values) };
        const asking = yield* Effect.forkChild(secrets.ask(request));

        yield* Effect.yieldNow;
        yield* secrets.answer(request.id, values);
        yield* Fiber.join(asking);
      }),
    );
  }

  /** This object's storage, as JSON, to check that no Secret value is in it. */
  storageDump(): string {
    return JSON.stringify([...this.ctx.storage.kv.list()]);
  }

  /** The Registry's saved settings overrides; none while no Registry is set. */
  async #readSettings(): Promise<Schema.Json> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined) return {};

    if (kv.get<string>("settingsMode") === "failing") throw new Error("Registry is down");

    return (await this.env.REGISTRIES.getByName(registry).getSettings()).overrides;
  }

  #notify(event: PushEvent): Promise<void> {
    const { kv } = this.ctx.storage;

    if (kv.get<string>("notifyMode") === "failing")
      return Promise.reject(new Error("Registry is down"));

    kv.put("notified", [...(kv.get<PushEvent[]>("notified") ?? []), event]);

    return Promise.resolve();
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
    return (_request, options, _state, model) => {
      const { kv } = this.ctx.storage;

      kv.put("requests", [
        ...(kv.get<TestRequest[]>("requests") ?? []),
        { model: model.id, thinking: options?.reasoning } satisfies TestRequest,
      ]);

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
