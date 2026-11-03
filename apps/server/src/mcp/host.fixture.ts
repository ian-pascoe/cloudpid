// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off
// The workerd test Durable Object that hosts `McpHost`'s methods over its SQLite storage, as the McpHost DO does, in one
// long-lived runtime, with a Registry and an engine the test scripts (`docs/architecture/mcp-connections.md` →
// Testing): what the pull asks and the Registry answers (or that it cannot), the `${NAME}` values it resolves, what
// each discovery of and request to a server's URL answers (or holds until released or aborted), and a clock the test
// moves forward.
// A test may hand the engine's work to the real `McpEngine` instead (`useRealEngine`), the test Worker's own entrypoint,
// over RPC, so a call goes Session → host → engine → a fake server end to end.
import {
  HostFailed,
  type McpAccessTokenAnswer,
  type McpAccessTokenInput,
  type McpApply,
  type McpApplyResult,
  type McpEngineDiscoverResult,
  type McpEngineMethods,
  type McpHostRequestInput,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpEnginePriorEncoded,
  type McpAuthReport,
  type McpEngineRequestEncoded,
  type McpEngineRequestResult,
  type McpEngineTargetEncoded,
  type McpRequestStart,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
  type McpServerLogRequest,
  type McpServerLogResult,
  type McpServersAnswer,
  type McpServersRequest,
  type McpServerValuesAnswer,
} from "@cloudpid/mcp/types";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { mcpEngineClient } from "./engine.ts";
import { mcpHostLayer, mcpHostMethods, McpRegistryUnavailable } from "./host.ts";
import { environmentOfMcpHost } from "./name.ts";
import { type McpHostStoreService, openMcpHostStore, type StoredSet } from "./store.ts";

/** What the test Registry asked of the pull: the Environment, and the hash the host held. */
export type PullAsked = {
  readonly environment: string;
  readonly heldHash: string | undefined;
};

/**
 * One scripted discovery: its answer, whether it waits for `release` first, and whether the RPC itself fails instead
 * (`reject`, its error's message), as an engine out of reach does.
 */
export type EngineScript = {
  readonly result: typeof McpEngineDiscoverResult.Encoded;
  readonly hold?: boolean;
  readonly reject?: string;
};

/**
 * One scripted request: as `EngineScript`, with the engine's answer to a request, and the `auth(stale)` asks the engine
 * makes first, in order, as its connection does (`[false]` for a token, `[false, true]` for a 401 and its retry).
 */
export type RequestScript = {
  /** The engine `op` this answers; when absent, a `tools/call` or a `tasks/*` request. Each `op` takes the scripts of its own, in order. */
  readonly op?: string;
  readonly result: typeof McpEngineRequestResult.Encoded;
  /**
   * Answer a completed call with this many bytes as a native byte stream, produced on pull (a `highWaterMark` of 0, so
   * nothing is pulled until a reader asks), as the engine answers a result over 1 MiB, in place of its `result`'s value.
   */
  readonly streamBytes?: number;
  /** As `streamBytes`, the stream carrying this JSON text: a result over 1 MiB that a decoder can read. */
  readonly streamJson?: Schema.Json;
  /** The stream's first pull waits for `releaseStreams()`: a read that has its answer and is slow to take it. */
  readonly holdStream?: boolean;
  readonly hold?: boolean;
  readonly reject?: string;
  readonly auth?: ReadonlyArray<boolean>;
};

/**
 * A request the engine was given: the target, the rows passed as `prior`, the request, the hooks' names, and the
 * tokens its `auth` asks were answered with.
 */
export type EngineRequest = EngineCall & {
  readonly request: McpEngineRequestEncoded;
  readonly tokens: ReadonlyArray<string | undefined>;
};

/** A discovery the engine was asked for: the target as it crossed, the rows passed as `prior`, and the hooks' names. */
export type EngineCall = {
  readonly target: McpEngineTargetEncoded;
  readonly prior: McpEnginePriorEncoded;
  readonly hooks: ReadonlyArray<string>;
};

/** What the scripts of a stdio server are keyed by is `stdio:<name>` (an HTTP server's is its URL). */
/** What `target`'s scripts are keyed by. */
const keyOf = (target: McpEngineTargetEncoded) =>
  target.kind === "http" ? target.url : `stdio:${target.name}`;

/** A clock `offset` ms ahead of `base`, sleeping as `base` does. */
const shiftedClock = (base: Clock.Clock, offset: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset(),
  currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + offset()),
  currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  currentTimeNanos: Effect.sync(
    () => base.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  ),
  monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: base.monotonicTimeNanos,
  sleep: (duration) => base.sleep(duration),
});

/** A span the host made, as a test reads it: its name, its trace, its parent and what it recorded. */
export type RecordedSpan = {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | undefined;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, string | number | boolean>>;
  }>;
};

/** `attributes`' scalar values: what crosses RPC, and all the host records. */
const scalars = (attributes: Readonly<Record<string, unknown>>) =>
  Record.filter(
    attributes,
    (value): value is string | number | boolean =>
      Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value),
  );

const isHostFailed = Schema.is(HostFailed);

/** `result`, an answer the test expects: a `HostFailed` throws, so the test fails with its message. */
const answered = <A extends object>(result: A | HostFailed): A => {
  if (isHostFailed(result)) throw new Error(result.message);

  return result;
};

const unscripted = (url: string): typeof McpEngineDiscoverResult.Encoded => ({
  kind: "failed",
  // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- the engine's answer as it crosses, encoded
  error: { _tag: "Unreachable", message: `Nothing scripted for ${url}` },
  state: {},
});

/**
 * The host's services over `store` alone, for a test that runs a method in the object over storage of its own (one
 * that refuses): a Registry that cannot be reached and an engine with nothing scripted.
 */
export const hostServicesOver = (store: McpHostStoreService) =>
  mcpHostLayer({
    store,
    registry: {
      serverSet: () => Effect.fail(McpRegistryUnavailable.make({ message: "No Registry" })),
      serverValues: () => Effect.fail(McpRegistryUnavailable.make({ message: "No Registry" })),
      accessToken: () => Effect.fail(McpRegistryUnavailable.make({ message: "No Registry" })),
      reportAuth: () => Effect.fail(McpRegistryUnavailable.make({ message: "No Registry" })),
    },
    engine: mcpEngineClient({
      discover: async (target) => unscripted(keyOf(target)),
      request: () => Promise.reject(new Error("Nothing scripted")),
    }),
  });

export class TestMcpHost extends DurableObject {
  readonly #store = openMcpHostStore(this.ctx.storage);

  readonly #asked: Array<PullAsked> = [];

  /** What the Registry answers the pull: the answer, or null for a Registry that cannot be reached. */
  #answer: McpServerSetAnswer | null = { hash: "", signInsRevision: 0 };

  /** What the Registry answers for a server's values, by name; none resolves every name to `value`. */
  readonly #values = new Map<string, McpServerValuesAnswer>();

  /** What the Registry answers `mcpAccessToken` for a server, in order, the last one for good; none: `required`. */
  readonly #tokens = new Map<string, Array<McpAccessTokenAnswer | "unreachable">>();

  readonly #tokenAsks: Array<McpAccessTokenInput> = [];

  /** The child ends the host told its handler of, in order. */
  readonly #ended: Array<{ conn: string; workspace: string; spawn: string | undefined }> = [];

  /** What the host asked the Registry for a server's values with. */
  readonly #valueAsks: Array<{
    readonly server: string;
    readonly workspace?: string | undefined;
  }> = [];

  readonly #reports: Array<McpAuthReport> = [];

  readonly #scripts = new Map<string, Array<EngineScript>>();

  readonly #held = new Map<string, Array<() => void>>();

  readonly #calls: Array<EngineCall> = [];

  /** Every span the host's runtime made, with its attributes, and every log line, as text. */
  readonly #observed: Array<string> = [];

  readonly #spans: Array<Tracer.NativeSpan> = [];

  readonly #requestScripts = new Map<string, Array<RequestScript>>();

  readonly #requests: Array<EngineRequest> = [];

  /** How many times a scripted stream was pulled. */
  #pulls = 0;

  #offset = 0;

  /** The real engine, once a test asks for it: the test Worker's `McpEngine` entrypoint, over RPC. */
  #real: McpEngineMethods | undefined;

  /** The pulls of streams that wait (`holdStream`) for `releaseStreams()`. */
  readonly #gated: Array<() => void> = [];

  /**
   * `script`'s completed answer with its value as a stream of `streamBytes` bytes, or of its `streamJson`'s text,
   * pulled 64 KiB at a time.
   */
  #streamed(script: RequestScript): typeof McpEngineRequestResult.Encoded {
    const text =
      script.streamJson === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(script.streamJson));

    const total = text?.byteLength ?? script.streamBytes ?? 0;
    let sent = 0;
    let gated = script.holdStream === true;

    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          this.#pulls++;

          if (gated) {
            gated = false;
            await new Promise<void>((resolve) => this.#gated.push(resolve));
          }

          if (sent >= total) return controller.close();

          const size = Math.min(64 * 1024, total - sent);

          controller.enqueue(text?.slice(sent, sent + size) ?? new Uint8Array(size).fill(97));
          sent += size;
        },
      },
      { highWaterMark: 0 },
    );

    // SAFETY: a completed answer whose value is a stream, as the engine returns it past 1 MiB.
    return {
      ...script.result,
      result: { kind: "stream", body, bytes: total },
    } as typeof McpEngineRequestResult.Encoded;
  }

  readonly #engine: McpEngineMethods = {
    request: async (target, prior, request, hooks) => {
      if (this.#real !== undefined) return this.#real.request(target, prior, request, hooks);

      const tokens: Array<string | undefined> = [];

      // @effect-diagnostics-next-line preferEffectRecord:off -- the hooks' names as they crossed, whatever they are.
      this.#requests.push({ target, prior, request, hooks: Object.keys(hooks), tokens });

      const queue = this.#requestScripts.get(keyOf(target)) ?? [];

      const next = queue.findIndex((each) =>
        each.op === undefined ? !request.op.startsWith("resources/") : each.op === request.op,
      );

      const script = next < 0 ? undefined : queue.splice(next, 1)[0];

      if (script === undefined) {
        throw new Error(`No ${request.op} request scripted for ${keyOf(target)}`);
      }

      for (const stale of script.auth ?? []) tokens.push(await hooks.auth?.(stale));

      if (script.hold === true) await this.#holdUntilReleased(keyOf(target));

      if (script.reject !== undefined) throw new Error(script.reject);

      if (script.streamBytes !== undefined || script.streamJson !== undefined) {
        return this.#streamed(script);
      }

      return script.result;
    },
    discover: async (target, prior, hooks) => {
      if (this.#real !== undefined) return this.#real.discover(target, prior, hooks);

      // @effect-diagnostics-next-line preferEffectRecord:off -- the hooks' names as they crossed, whatever they are.
      this.#calls.push({ target, prior, hooks: Object.keys(hooks) });

      const queue = this.#scripts.get(keyOf(target)) ?? [];
      const script = queue.shift();

      if (script === undefined) return unscripted(keyOf(target));

      if (script.hold === true) await this.#holdUntilReleased(keyOf(target));

      if (script.reject !== undefined) throw new Error(script.reject);

      return script.result;
    },
  };

  readonly #runtime = ManagedRuntime.make(
    mcpHostLayer({
      store: this.#store,
      registry: {
        serverSet: (input) =>
          Effect.suspend(() => {
            this.#asked.push(input);

            return this.#answer === null
              ? Effect.fail(McpRegistryUnavailable.make({ message: "The Registry did not answer" }))
              : Effect.succeed(this.#answer);
          }),
        serverValues: (input) =>
          Effect.sync(() => {
            this.#valueAsks.push(input);

            return (
              this.#values.get(input.server) ?? {
                status: "values",
                env: {},
                headers: {},
                missing: [],
              }
            );
          }),
        accessToken: (input) =>
          Effect.suspend(() => {
            this.#tokenAsks.push(input);

            const queue = this.#tokens.get(input.server);
            const next = queue === undefined || queue.length === 0 ? undefined : queue[0];

            // The last scripted answer stays.
            if (queue !== undefined && queue.length > 1) queue.shift();

            if (next === "unreachable") {
              return Effect.fail(
                McpRegistryUnavailable.make({ message: "The Registry did not answer" }),
              );
            }

            return Effect.succeed<McpAccessTokenAnswer>(
              next ?? { status: "required", reason: "Not signed in" },
            );
          }),
        reportAuth: (report) =>
          Effect.sync(() => {
            this.#reports.push(report);

            return { status: "recorded", resolved: [] };
          }),
      },
      engine: mcpEngineClient(this.#engine),
      processEnded: (conn, workspace, spawn) =>
        Effect.sync(() => {
          this.#ended.push({ conn, workspace, spawn });
        }),
      references: Layer.mergeAll(
        Layer.succeed(
          Clock.Clock,
          shiftedClock(Clock.Clock.defaultValue(), () => this.#offset),
        ),
        Layer.succeed(
          Tracer.Tracer,
          Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);

              this.#observed.push(span.name);

              // The attributes are read when the span is read: they are set after it starts.
              this.#spans.push(span);

              return span;
            },
          }),
        ),
        Logger.layer([
          Logger.make((entry) => {
            this.#observed.push(`${JSON.stringify(entry.message)} ${Cause.pretty(entry.cause)}`);
          }),
        ]),
      ),
    }),
  );

  readonly #methods = mcpHostMethods(environmentOfMcpHost(this.ctx.id.name), this.#runtime);

  /**
   * Hand every discovery and request to the real `McpEngine`, the test Worker's own entrypoint (`ctx.exports`), whose
   * outbound `fetch`es the test routes to its fake servers.
   */
  useRealEngine(): void {
    // SAFETY: the test Worker exports `McpEngine` (`workerd.fixture.ts`), whose loopback stub answers its methods.
    this.#real = (this.ctx.exports as { readonly McpEngine: McpEngineMethods }).McpEngine;
  }

  /** Script the Registry's answer to the pull. */
  script(answer: McpServerSetAnswer | null): void {
    this.#answer = answer;
  }

  /** Script the Registry's answer for `server`'s `${NAME}` values. */
  scriptValues(server: string, answer: McpServerValuesAnswer): void {
    this.#values.set(server, answer);
  }

  /** The child ends the host told its handler of, in order. */
  endedProcesses(): ReadonlyArray<{
    readonly conn: string;
    readonly workspace: string;
    readonly spawn: string | undefined;
  }> {
    return this.#ended;
  }

  /** What the host asked the Registry for the values of a server with, in order. */
  valueAsks(): ReadonlyArray<{ readonly server: string; readonly workspace?: string | undefined }> {
    return this.#valueAsks;
  }

  /** Script the Registry's answers to `mcpAccessToken` for `server`, in order; the last one stays. */
  scriptToken(server: string, answers: ReadonlyArray<McpAccessTokenAnswer | "unreachable">): void {
    this.#tokens.set(server, [...answers]);
  }

  /** What the host asked `mcpAccessToken` for, in order. */
  tokenAsks(): ReadonlyArray<McpAccessTokenInput> {
    return this.#tokenAsks;
  }

  /** What the host reported to the Registry, in order. */
  reports(): ReadonlyArray<McpAuthReport> {
    return this.#reports;
  }

  /** Queue the engine's answers to the next discoveries of `url`, in order. */
  scriptEngine(url: string, scripts: ReadonlyArray<EngineScript>): void {
    this.#scripts.set(url, [...(this.#scripts.get(url) ?? []), ...scripts]);
  }

  /** Queue the engine's answers to the next requests to `url`, in order. */
  scriptRequest(url: string, scripts: ReadonlyArray<RequestScript>): void {
    this.#requestScripts.set(url, [...(this.#requestScripts.get(url) ?? []), ...scripts]);
  }

  /** The requests the engine was given, in order. */
  engineRequests(): ReadonlyArray<EngineRequest> {
    return this.#requests;
  }

  /** Pending until `release(url)`. */
  #holdUntilReleased(url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#held.set(url, [...(this.#held.get(url) ?? []), resolve]);
    });
  }

  /** Let the held discoveries and requests of `url` answer. */
  release(url: string): void {
    for (const resolve of this.#held.get(url) ?? []) resolve();

    this.#held.delete(url);
  }

  /** Let the streams that wait for it (`holdStream`) be pulled. */
  releaseStreams(): void {
    for (const resolve of this.#gated.splice(0)) resolve();
  }

  /** The discoveries the engine was asked for, in order. */
  engineCalls(): ReadonlyArray<EngineCall> {
    return this.#calls;
  }

  /** Move the host's clock `ms` forward. */
  advance(ms: number): void {
    this.#offset += ms;
  }

  /** What the pull has asked of the Registry so far. */
  asked(): ReadonlyArray<PullAsked> {
    return this.#asked;
  }

  apply(input: McpApply): Promise<McpApplyResult> {
    return Effect.runPromise(this.#methods.apply(input));
  }

  async requestStart(request: McpRequestStart): Promise<McpRequestStartAnswer> {
    return answered(await Effect.runPromise(this.#methods.requestStart(request)));
  }

  /** `serverLog` as the host answers it, whatever it answers. */
  serverLog(request: McpServerLogRequest): Promise<McpServerLogResult> {
    return Effect.runPromise(this.#methods.serverLog(request));
  }

  /** The spans the host made so far, in the order they started. */
  spans(): ReadonlyArray<RecordedSpan> {
    return this.#spans.map((span) => ({
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      parentId: Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId)),
      attributes: scalars(Record.fromEntries(span.attributes)),
      events: span.events.map(([name, , attributes]) => ({
        name,
        attributes: scalars(attributes),
      })),
    }));
  }

  async servers(request: McpServersRequest): Promise<McpServersAnswer> {
    return answered(await Effect.runPromise(this.#methods.servers(request)));
  }

  /** A Session's call, as the McpHost DO answers it: with the caller's hooks, which live as long as this call. */
  request(
    input: typeof McpHostRequestInput.Encoded,
    hooks: McpHostRequestHooks,
  ): Promise<McpHostRequestResult> {
    return Effect.runPromise(this.#methods.request(input, hooks));
  }

  /**
   * A Session's call, answered here, in this Durable Object, before it crosses to the caller: what the host returned
   * of a streamed result, and whether it had read any of it (a locked or pulled stream).
   */
  async requestStreamed(
    input: typeof McpHostRequestInput.Encoded,
  ): Promise<{ readonly tag: string; readonly stream: { locked: boolean; bytes: number } | null }> {
    const answer = await Effect.runPromise(this.#methods.request(input, {}));

    if (!Predicate.isTagged(answer, "Completed") || answer.result.kind !== "stream") {
      return { tag: answer._tag, stream: null };
    }

    const { body, bytes } = answer.result;

    return { tag: answer._tag, stream: { locked: body.locked, bytes } };
  }

  /** How many times a scripted stream was pulled so far. */
  streamPulls(): number {
    return this.#pulls;
  }

  /** The set as the store holds it. */
  readSet(): StoredSet | null {
    return this.#store.readSet();
  }

  /** The era and Legacy session rows of `conn`, an HTTP server's or a stdio server's in `workspace`. */
  prior(conn: string, workspace?: string): McpEnginePriorEncoded {
    return this.#store.prior(conn, workspace);
  }

  /** The session rows of `conn`: its Workspaces' (`''` for an HTTP server's), and the spawn id each was last heard on. */
  sessionRows(
    conn: string,
  ): ReadonlyArray<{ readonly workspace: string; readonly spawn: string | null }> {
    return this.ctx.storage.sql
      .exec<{ workspace: string; spawn: string | null }>(
        "SELECT workspace, spawn FROM mcp_sessions WHERE conn = ? ORDER BY workspace",
        conn,
      )
      .toArray();
  }

  /** The pages of App HTML the host keeps: hash and size, by hash. */
  appPages(): ReadonlyArray<{ readonly hash: string; readonly bytes: number }> {
    return this.ctx.storage.sql
      .exec<{ hash: string; bytes: number }>(
        "SELECT hash, bytes FROM mcp_app_html_meta ORDER BY hash",
      )
      .toArray();
  }

  /** What each (`conn`, URI) read last: its page's hash and the inventory `version` it was read at. */
  appUiRows(): ReadonlyArray<{
    readonly conn: string;
    readonly uri: string;
    readonly hash: string;
    readonly version: string;
  }> {
    return this.ctx.storage.sql
      .exec<{ conn: string; uri: string; hash: string; version: string }>(
        "SELECT conn, uri, hash, version FROM mcp_app_ui ORDER BY conn, uri",
      )
      .toArray();
  }

  /** What the host's runtime logged, and every span it made with its attributes, as text: to look for what must not be there. */
  observed(): string {
    return JSON.stringify([
      this.#observed,
      this.#spans.map(({ name, attributes, events }) => ({
        name,
        attributes: [...attributes],
        events,
      })),
    ]);
  }

  /** Every table's rows as text, to look for what must not be there. */
  dump(): string {
    return JSON.stringify(
      [
        "mcp_meta",
        "mcp_servers",
        "mcp_inventories",
        "mcp_status",
        "mcp_eras",
        "mcp_sessions",
        "mcp_logs",
        "mcp_app_ui",
        "mcp_app_html_meta",
      ].map((table) => this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
    );
  }
}
