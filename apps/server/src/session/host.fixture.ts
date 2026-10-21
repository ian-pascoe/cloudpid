// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off globalDateInEffect:off preferEffectArray:off preferEffectRecord:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` and its `SessionSockets` over the faux provider,
// as the Session DO hosts them over the model proxy. Tests drive it with `runInDurableObject()` and client sockets,
// evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import { callDurable, defineEffectTool, Harness } from "@cloudpid/effect-durable";
import {
  Browser,
  BrowserHost,
  type BrowserHostService,
  BrowserSession,
  BrowserHandoffs,
  type HandoffStartInput,
  type HandoffStatus,
  imageLimitedModels,
  makeBrowserSession,
} from "@cloudpid/extensions/browser";
import { OwnerNotifications } from "@cloudpid/extensions/notify";
import { scrubbingModels, Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { Todo, TodoDoc } from "@cloudpid/extensions/todo";
import type { Catalog, CommandOutcome, ConversationId } from "@cloudpid/protocol";
import { ToolSearch, ToolSearchSettings } from "@cloudpid/extensions/tool-search";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  type AgentChange,
  defineExtension,
  type Extension,
  type HarnessOptions,
  ROOT_CONVERSATION_ID,
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
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import type * as Types from "effect/Types";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { sessionBrowserHandoffsLayer } from "./handoffs.ts";
import { pricedModels, REQUEST_COST } from "./priced.fixture.ts";
import { sessionTotals } from "./spend.ts";
import { sessionSecretsLayer } from "./secrets.ts";
import {
  reloadSessionExtensions,
  SessionSettings,
  sessionSettingsLayer,
  toolSearchSettings,
} from "./settings.ts";
import {
  type Answer,
  SessionHost,
  sessionHostLayer,
  type SessionHostService,
  type SlashCommand,
} from "./host.ts";
import { destroySession } from "./lifecycle.ts";
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

/** The Live View link the test browser host mints: recognisable, so a test can look for it where it must not be. */
export const LIVE_VIEW_URL =
  "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/s/page/t?jwt=SECRET-LIVE-VIEW-TOKEN";

/** How long one round of waiting on the test browser host lasts at most, and how long a call may wait past a deadline. */
const HANDOFF_ROUND_MS = 10_000;
const HANDOFF_GRACE_MS = 50;

/** The object's key-value storage, as the test browser host uses it. */
type Kv = DurableObjectStorage["kv"];

/** Rounds of waiting on a handoff, which end early when the test completes it. */
const roundWaiters = new Map<string, () => void>();

/**
 * A browser host that hands a tab over at once and finishes the handoff when the test says (`completeHandoff`). Its
 * state is in the object's storage, as the real host's is in its own object: it outlives an instance of the Session.
 */
const testBrowserHost = (kv: Kv): BrowserHostService => ({
  describe: Effect.succeed("Drives a browser."),
  run: () => Effect.succeed({ output: [{ type: "text", text: "ok" }] }),
  close: Effect.succeed(false),
  startHandoff: (input) =>
    Effect.sync(() => {
      kv.put("handoff-starts", [...(kv.get<HandoffStartInput[]>("handoff-starts") ?? []), input]);

      if (kv.get<HandoffStatus>(`handoff-status:${input.requestId}`) === undefined) {
        kv.put(`handoff-status:${input.requestId}`, { state: "waiting" } satisfies HandoffStatus);
      }

      return { url: LIVE_VIEW_URL, startedAt: Date.now() };
    }),
  waitHandoff: (requestId, maxMs) =>
    Effect.promise(
      () =>
        new Promise<HandoffStatus>((resolve) => {
          const status = () =>
            kv.get<HandoffStatus>(`handoff-status:${requestId}`) ?? { state: "unknown" as const };

          if (status().state !== "waiting") {
            resolve(status());

            return;
          }

          // A round that ends on a timer is a pending timer, which keeps workerd from evicting the object: a test that
          // evicts it mid-wait asks for rounds with no timer (`quiet`), which end only when the test completes the handoff.
          const timer =
            kv.get<boolean>("handoff-quiet") === true
              ? undefined
              : setTimeout(() => resolve(status()), maxMs);

          roundWaiters.set(requestId, () => {
            clearTimeout(timer);
            resolve(status());
          });
        }),
    ),
  endHandoff: (requestId) =>
    Effect.sync(() => {
      kv.put("handoff-ended", [...(kv.get<string[]>("handoff-ended") ?? []), requestId]);
      kv.delete(`handoff-status:${requestId}`);
    }),
});

/** The models the test provider serves: those the default settings and a Session's choice may name. */
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export { REQUEST_COST };

/** The model and thinking level a request asked for. */
export type TestRequest = { readonly model: string; readonly thinking: string | undefined };

/** A request for a Session title as the model received it: the model asked, and its messages (system prompt included) as JSON. */
export type TitleRequest = { readonly model: string; readonly messages: string };

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
  /**
   * The extensions this Session runs with, installed before any work resumes: `echo`, which uses Secrets, the secret
   * tools, the browser tools over a test browser host, and `todo`; and, for a Session whose name starts with
   * `tool-search-`, `tool_search` over the Registry's offered tools, which is installed again when they change.
   */
  protected hostExtensions(): Effect.Effect<
    readonly Extension[],
    never,
    Harness | Secrets | BrowserHandoffs | SessionSettings
  > {
    const { kv } = this.ctx.storage;
    const searching = this.#searching();

    return Effect.gen(function* () {
      const tool = yield* Echo;
      const echo = defineExtension({ name: "echo", tools: [tool] });
      const host = testBrowserHost(kv);

      const browser = yield* Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, makeBrowserSession({ host, storage: kv })),
      );

      const extensions = [echo, yield* secretsExtension([tool]), browser, yield* Todo];

      if (!searching) return extensions;

      const search = yield* ToolSearch(
        Arr.flatMap(extensions, (extension) => Arr.map(extension.tools ?? [], (each) => each.name)),
      ).pipe(Effect.provideServiceEffect(ToolSearchSettings, toolSearchSettings));

      return [...extensions, search];
    });
  }

  /** Whether this Session defers the tools its settings do not offer (the tests that look at it name it so). */
  #searching(): boolean {
    return this.ctx.id.name?.startsWith("tool-search-") === true;
  }

  /** What builds a conversation's execution environment, if this Session has one. */
  protected hostEnv(): HarnessOptions["env"] | undefined {
    return undefined;
  }

  /** The spans this instance's Effects made, in the order they started. */
  readonly #spans: Tracer.NativeSpan[] = [];
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
                scrubbingModels(imageLimitedModels(pricedModels(models, REQUEST_COST)), held),
              ),
              reset: (reason) => ctx.abort(reason),
              extensions: this.hostExtensions(),
              reload: this.#searching() ? reloadSessionExtensions : undefined,
              env: this.hostEnv(),
              reportTimeout: "200 millis",
              wakeAt: Effect.flatMap(Effect.service(Secrets), (held) => held.nextExpiry),
              onIdle: Effect.flatMap(
                Effect.all([Effect.service(Secrets), Effect.service(BrowserHandoffs)]),
                ([held, handoffs]) => Effect.all([held.dropAbandoned, handoffs.dropAbandoned]),
              ),
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
                    titleWanted: Effect.tryPromise({
                      try: () => this.#titleWanted(),
                      catch: (cause) => ReportError.make({ message: String(cause) }),
                    }),
                    setTitle: (title) =>
                      Effect.tryPromise({
                        try: () => this.#setTitle(title),
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
            sessionBrowserHandoffsLayer({
              host: testBrowserHost(ctx.storage.kv),
              storage: ctx.storage.kv,
              sockets: ctx,
              // A short wait and a short deadline, so a test can see a handoff time out.
              timeoutMs: ctx.storage.kv.get<number>("handoff-timeout") ?? 30 * 60_000,
              pollMs: HANDOFF_ROUND_MS,
              graceMs: HANDOFF_GRACE_MS,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    BrowserSession,
                    makeBrowserSession({
                      host: testBrowserHost(ctx.storage.kv),
                      storage: ctx.storage.kv,
                    }),
                  ),
                  Layer.succeed(OwnerNotifications, {
                    notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
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
          // The spans this instance's Effects make, kept to read.
          Layer.provideMerge(
            Layer.succeed(
              Tracer.Tracer,
              Tracer.make({
                span: (options) => {
                  const span = new Tracer.NativeSpan(options);

                  this.#spans.push(span);

                  return span;
                },
              }),
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

  /** Delete the Session's own state, as the Session DO's `destroy` does. */
  destroy(): Promise<void> {
    return this.#runtime.runPromise(
      destroySession({
        state: this.ctx,
        closeBrowser: testBrowserHost(this.ctx.storage.kv).close,
      }),
    );
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

  /** What the Session has spent, in US dollars: every conversation's requests and the title calls'. */
  spent(): Promise<number> {
    const { kv } = this.ctx.storage;

    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        return (yield* Effect.promise(() => sessionTotals(harness.harness, kv))).cost;
      }),
    );
  }

  /** Whether no work is live; reads only, so it never runs work itself. */
  idle(): Promise<boolean> {
    return Effect.runPromise(this.#host.idle);
  }

  submit({ requestId, text }: TestPrompt): Promise<number> {
    return this.#runtime.runPromise(this.#host.submit({ requestId, input: text }));
  }

  prompt({ requestId, text }: TestPrompt): Promise<Answer> {
    return this.#runtime.runPromise(this.#host.prompt({ requestId, input: text }));
  }

  /** The spans of this instance's Effects, as a test reads them: their names and attributes, and whether they ended. */
  spans(): ReadonlyArray<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly ended: boolean;
  }> {
    return Arr.map(this.#spans, (span) => ({
      name: span.name,
      attributes: Object.fromEntries(span.attributes),
      ended: Predicate.isTagged(span.status, "Ended"),
    }));
  }

  /** What the composer of the root conversation, or of a subagent's, offers. */
  catalog(conversationId?: ConversationId): Promise<Catalog> {
    return this.#runtime.runPromise(this.#host.catalog(conversationId));
  }

  /** Run the Session's Slash command `name`: what it did, or why it could not. */
  command(
    name: string,
    args: string,
    conversationId?: ConversationId,
  ): Promise<{ readonly outcome: CommandOutcome } | { readonly failure: string }> {
    const command: Types.Mutable<SlashCommand> = { name, args };

    if (conversationId !== undefined) command.conversationId = conversationId;

    return this.#runtime.runPromise(
      this.#host.command(command).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** The root conversation's entries, oldest first: each one's kind, data, and the text of its message. */
  rootEntries(): Promise<
    ReadonlyArray<{ readonly kind: string; readonly data: unknown; readonly text: string }>
  > {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({ order: "ascending" }, 500, undefined, context),
        );

        return Arr.map(page.items, (entry) => {
          const message = entry.model?.[0];

          const text =
            message === undefined || message.role === "system"
              ? ""
              : Predicate.isString(message.content)
                ? message.content
                : Arr.join(
                    Arr.flatMap(
                      // SAFETY: a user's, an assistant's and a tool result's content are arrays of typed blocks; only
                      // the text ones are read.
                      message.content as ReadonlyArray<{ type: string; text?: string }>,
                      (block) =>
                        block.type === "text" && block.text !== undefined ? [block.text] : [],
                    ),
                    "",
                  );

          return { kind: entry.kind, data: entry.data, text };
        });
      }),
    );
  }

  /**
   * Watch the root conversation's Todo List as a client does: `lists` gets the titles of each list sent, the first being
   * how it stands, until `stop`.
   */
  watchTodos() {
    const lists: (readonly string[])[] = [];

    const fiber = this.#runtime.runFork(
      Stream.runForEach(this.#host.todos(ROOT_CONVERSATION_ID), (tasks) =>
        Effect.sync(() => {
          lists.push(Arr.map(tasks, (task) => task.title));
        }),
      ),
    );

    return { lists, stop: () => void fiber.pipe(Fiber.interrupt, Effect.runFork) };
  }

  /** The tasks of the root conversation's Todo List. */
  todoTitles(): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        const state = yield* callDurable("snapshot", (context) =>
          harness.harness.snapshot(TodoDoc, ROOT_CONVERSATION_ID, context),
        );

        return Arr.map(state?.tasks ?? [], (task) => task.title);
      }),
    );
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

  /**
   * Let this Session name itself, as the Session DO does after its first answer: the `replies` are what the title
   * requests get, in order (`gate:<reply>` waits for `open()`), kept in storage like the script. Without it no title is
   * wanted, so a test that does not look at titles never sees a request for one. The Registry decides, as the real
   * one does, whether the title is wanted and whether it is kept.
   */
  titles(replies: readonly string[]): void {
    this.ctx.storage.kv.put("title-replies", { responses: replies, next: 0 } satisfies Script);
  }

  /** The requests for a title the model received, oldest first: its model and the messages as it saw them. */
  titleRequests(): readonly TitleRequest[] {
    return this.ctx.storage.kv.get<TitleRequest[]>("title-requests") ?? [];
  }

  /** Make the Registry unreachable for the title task until `titleRegistry("working")`. */
  titleRegistry(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("titleMode", mode);
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

  /** The system prompt sections the model's latest request carried, by key. */
  sections(): Readonly<Record<string, string>> {
    return this.ctx.storage.kv.get<Record<string, string>>("sections") ?? {};
  }

  /** The names of the tools each request offered the model, oldest first. */
  offeredTools(): readonly (readonly string[])[] {
    return this.ctx.storage.kv.get<string[][]>("request-tools") ?? [];
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

  /** The handoffs the test browser host was asked to start, oldest first. */
  handoffStarts(): readonly HandoffStartInput[] {
    return this.ctx.storage.kv.get<HandoffStartInput[]>("handoff-starts") ?? [];
  }

  /** The handoffs the test browser host was told to end, oldest first. */
  endedHandoffs(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("handoff-ended") ?? [];
  }

  /** Make the test browser host's rounds of waiting end only when `completeHandoff` does, so the object can be evicted mid-wait. */
  quietHandoffs(): void {
    this.ctx.storage.kv.put("handoff-quiet", true);
  }

  /** Finish handoff `requestId` in the test browser host, as the owner does in Live View. */
  completeHandoff(requestId: string, status: HandoffStatus): void {
    this.ctx.storage.kv.put(`handoff-status:${requestId}`, status);
    roundWaiters.get(requestId)?.();
  }

  /** Every request the model received, as the provider would see its messages, oldest first. */
  requestMessages(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("request-messages") ?? [];
  }

  /** The Harness's own storage (the transcript and everything the Session keeps in `pi_` tables), as JSON. */
  harnessDump(): string {
    const { sql } = this.ctx.storage;

    const tables = sql
      .exec(
        "select name from sqlite_master where type = 'table' and name like 'pi\\_%' escape '\\'",
      )
      .toArray();

    return JSON.stringify(
      tables.flatMap((table) => {
        const name = table["name"];

        return Predicate.isString(name)
          ? [[name, sql.exec(`select * from "${name}"`).toArray()]]
          : [];
      }),
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

  /** Whether the Registry wants a title for this Session: titles are on, and it has neither a title nor an owner's. */
  async #titleWanted(): Promise<boolean> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined || kv.get<Script>("title-replies") === undefined) return false;

    if (kv.get<string>("titleMode") === "failing") throw new Error("Registry is down");

    const session = await this.env.REGISTRIES.getByName(registry).getSession(
      this.ctx.id.name ?? "",
    );

    return session !== null && session.titleSource === null;
  }

  async #setTitle(title: string): Promise<void> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined) return;

    if (kv.get<string>("titleMode") === "failing") throw new Error("Registry is down");

    await this.env.REGISTRIES.getByName(registry).setGeneratedTitle(this.ctx.id.name ?? "", title);
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
    return (request, options, _state, model) => {
      const { kv } = this.ctx.storage;

      // A request for a Session title has its own script and log, so it never shifts the Run's.
      if (JSON.stringify(request.messages).includes("You name conversations")) {
        kv.put("title-requests", [
          ...(kv.get<TitleRequest[]>("title-requests") ?? []),
          { model: model.id, messages: JSON.stringify(request.messages) } satisfies TitleRequest,
        ]);

        const replies = kv.get<Script>("title-replies") ?? { responses: [], next: 0 };
        const reply = replies.responses[replies.next] ?? "unscripted";

        kv.put("title-replies", { ...replies, next: replies.next + 1 });

        if (!reply.startsWith("gate:")) return respond(reply);

        this.gated.resolve();

        return this.#gate.promise.then(() => respond(reply.slice("gate:".length)));
      }

      kv.put("request-messages", [
        ...(kv.get<string[]>("request-messages") ?? []),
        JSON.stringify(request.messages),
      ]);

      // The system prompt sections in effect for this request, replayed from its system messages.
      const sections: Record<string, string> = {};

      for (const message of request.messages) {
        if (message.role !== "system") continue;

        for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) delete sections[key];
          else sections[key] = value;
        }
      }

      kv.put("sections", sections);

      // The tools this request offered, as the transport replays them.
      kv.put("request-tools", [
        ...(kv.get<string[][]>("request-tools") ?? []),
        getCurrentTools(request.messages).map((tool) => tool.name),
      ]);

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
