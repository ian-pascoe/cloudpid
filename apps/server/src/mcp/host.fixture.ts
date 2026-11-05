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
  type McpEngineListenResult,
  type McpEngineMethods,
  type McpErrorWire,
  type McpListenFilter,
  type McpHostRequestInput,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpEnginePriorEncoded,
  type McpAuthReport,
  type McpEngineRequestEncoded,
  type McpEngineRequestResult,
  type McpEngineTargetEncoded,
  type McpRequestStart,
  type McpRequestStartResult,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
  type McpServerLogRequest,
  type McpServerLogResult,
  type McpServersAnswer,
  type McpServersRequest,
  type McpServersResult,
  type McpServerValuesAnswer,
  type McpInputRequest,
} from "@cloudpid/mcp/types";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
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
import type { Mutable } from "effect/Types";
import { mcpEngineClient } from "./engine.ts";
import { mcpHostLayer, mcpHostMethods, McpRegistryUnavailable } from "./host.ts";
import type { KeepAliveAlarm } from "./keep-alive.ts";
import { environmentOfMcpHost } from "./name.ts";
import { type McpHostStoreService, openMcpHostStore, type StoredSet } from "./store.ts";
import type { WatchRow } from "./watch-store.ts";

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
  /** The deprecated features the engine tells the host the server used (`onDeprecated`), before it answers. */
  readonly deprecated?: ReadonlyArray<string>;
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
  /** As `EngineScript.deprecated`. */
  readonly deprecated?: ReadonlyArray<string>;
  /** Questions the server asks, one after another, through the caller's `onInput` before the call is answered. */
  readonly asks?: ReadonlyArray<typeof McpInputRequest.Encoded>;
};

/**
 * One scripted listen: what the engine answers (`failed`, or `listening` with `honored`, by default every URI asked for,
 * and the `era` it speaks, `modern` by default), and whether the RPC itself fails instead (`reject`).
 */
export type ListenScript = {
  readonly failed?: typeof McpErrorWire.Encoded;
  readonly honored?: ReadonlyArray<string>;
  readonly era?: "modern" | "legacy";
  readonly spawn?: string;
  readonly reject?: string;
};

/** A listen the engine was given, as a test reads it: where, with which filter, and whether the host has closed it. */
export type ListenOpened = {
  readonly url: string;
  readonly filter: typeof McpListenFilter.Encoded;
  /** The host closed it (its `stop` stream ended). */
  readonly stopped: boolean;
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

/** A sleep of at least this long (the hold timer's) can be woken by `advanceAndWake`. */
const LONG_SLEEP_MS = 60_000;

/** A clock `offset` ms ahead of `base`, sleeping as `base` does; a long sleep also ends when `advanceAndWake` passes it. */
const shiftedClock = (
  base: Clock.Clock,
  offset: () => number,
  sleepers: Set<{ readonly wakeAt: number; readonly wake: () => void }>,
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset(),
  currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + offset()),
  currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  currentTimeNanos: Effect.sync(
    () => base.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  ),
  monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: base.monotonicTimeNanos,
  sleep: (duration) => {
    const ms = Duration.toMillis(duration);

    if (ms < LONG_SLEEP_MS) return base.sleep(duration);

    const wakeAt = offset() + ms;

    return Effect.raceFirst(
      base.sleep(duration),
      Effect.callback<void>((resume) => {
        const sleeper = { wakeAt, wake: () => resume(Effect.void) };

        sleepers.add(sleeper);

        return Effect.sync(() => {
          sleepers.delete(sleeper);
        });
      }),
    );
  },
});

/** A span the host made, as a test reads it: its name, its trace, its parent and what it recorded. */
export type RecordedSpan = {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | undefined;
  /** Whether a tracer exports it: a span the host started unsampled is recorded here and goes nowhere. */
  readonly sampled: boolean;
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

/** An alarm that is never set, for a runtime over storage of its own. */
const NO_ALARM: KeepAliveAlarm = {
  setAlarm: () => Promise.resolve(),
  deleteAlarm: () => Promise.resolve(),
};

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
      listen: () => Promise.reject(new Error("Nothing scripted")),
    }),
    alarm: NO_ALARM,
  });

/** `store` whose members throw while `refused(member)`. */
const guardMembers = (
  store: McpHostStoreService,
  refused: (member: string) => boolean,
): McpHostStoreService =>
  new Proxy(store, {
    get: (target, key: string) => {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a proxy trap reads a member of a plain object
      const member: unknown = Reflect.get(target, key);

      if (!Predicate.isFunction(member)) return member;

      return (...args: ReadonlyArray<unknown>) => {
        if (refused(key)) throw new Error(`The storage refused ${key}`);

        return member(...args);
      };
    },
  });

/**
 * The store's members that write, kept by hand: what `refuseWrites()` makes throw. It must list every write member of
 * `McpHostStoreService`, or `refuseWrites()` leaves one working.
 */
const STORE_WRITES: ReadonlySet<string> = new Set([
  "replaceSet",
  "setRevision",
  "setMeta",
  "putStatus",
  "putInventory",
  "expireInventory",
  "applyEngineState",
  "dropPrior",
  "dropSessions",
  "putLogs",
  "putApp",
  "touchApp",
  "putWatch",
  "dropWatches",
  "putWatchEnds",
  "takeWatchEnds",
  "destroy",
  "pruneOutsideSet",
]);

export class TestMcpHost extends DurableObject {
  /** The object's storage, as the host's store sees it: it refuses everything once `replace()` ran. */
  readonly #gate = refusingStorage(this.ctx.storage);

  /** Set by `refuse` and `refuseWrites`: the store's members that throw, `"writes"` for every one that writes. */
  #refused: ReadonlySet<string> = new Set();

  readonly #store: McpHostStoreService = guardMembers(
    openMcpHostStore(this.#gate.storage),
    (member) =>
      this.#refused.has(member) || (this.#refused.has("writes") && STORE_WRITES.has(member)),
  );

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

  readonly #listenScripts = new Map<string, Array<ListenScript>>();

  /** The listens the engine was given, and the controllers of their event streams. */
  readonly #listens: Array<{
    readonly url: string;
    readonly filter: typeof McpListenFilter.Encoded;
    readonly events: ReadableStreamDefaultController<Uint8Array>;
    stopped: boolean;
    ended: boolean;
  }> = [];

  /** How many times a scripted stream was pulled. */
  #pulls = 0;

  #offset = 0;
  readonly #sleepers = new Set<{ readonly wakeAt: number; readonly wake: () => void }>();

  readonly #answers: Array<string> = [];

  #aborts = 0;

  /** The real engine, once a test asks for it: the test Worker's `McpEngine` entrypoint, over RPC. */
  #real: McpEngineMethods | undefined;

  /** The real engine for requests only (`useRealRequests`): discoveries and listens stay scripted. */
  #realRequests: McpEngineMethods | undefined;

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
    listen: async (target, prior, filter, hooks, stop) => {
      if (this.#real !== undefined) return this.#real.listen(target, prior, filter, hooks, stop);

      const script = this.#listenScripts.get(keyOf(target))?.shift() ?? {};

      if (script.reject !== undefined) throw new Error(script.reject);

      if (script.failed !== undefined) return { kind: "failed", error: script.failed, state: {} };

      const started: Array<ReadableStreamDefaultController<Uint8Array>> = [];

      const events = new ReadableStream<Uint8Array>({
        start: (controller) => void started.push(controller),
      });

      const [controller] = started;

      if (controller === undefined) throw new Error("The listen's stream did not start");

      const entry = {
        url: keyOf(target),
        filter,
        events: controller,
        stopped: false,
        ended: false,
      };

      this.#listens.push(entry);

      // The host closing `stop` ends the listen at once, as the real engine's does.
      void stop
        ?.getReader()
        .read()
        .then(() => {
          entry.stopped = true;
          this.#endEvents(entry);
        });

      const listening: Mutable<
        Extract<typeof McpEngineListenResult.Encoded, { readonly kind: "listening" }>
      > = {
        kind: "listening",
        honored: {
          ...filter,
          resourceSubscriptions: script.honored ?? filter.resourceSubscriptions ?? [],
        },
        events,
        era: script.era ?? "modern",
        state: {},
      };

      if (script.spawn !== undefined) listening.spawn = script.spawn;

      return listening;
    },
    request: async (target, prior, request, hooks) => {
      if (this.#real !== undefined) return this.#real.request(target, prior, request, hooks);

      if (this.#realRequests !== undefined) {
        return this.#realRequests.request(target, prior, request, hooks);
      }

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

      for (const feature of script.deprecated ?? []) await hooks.onDeprecated?.(feature);

      for (const asked of script.asks ?? []) await hooks.onInput?.(asked);

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

      for (const feature of script.deprecated ?? []) await hooks.onDeprecated?.(feature);

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
      // The object's own alarm, refused as the rest of its storage is once `replace()` ran.
      alarm: this.#gate.storage,
      processEnded: (conn, workspace, spawn) =>
        Effect.sync(() => {
          this.#ended.push({ conn, workspace, spawn });
        }),
      references: Layer.mergeAll(
        Layer.succeed(
          Clock.Clock,
          shiftedClock(Clock.Clock.defaultValue(), () => this.#offset, this.#sleepers),
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

  /** The `op` whose requests fail (`failRequests`). */
  #failing: string | undefined;

  readonly #methods = mcpHostMethods(environmentOfMcpHost(this.ctx.id.name), this.#runtime);

  /**
   * Hand every discovery and request to the real `McpEngine`, the test Worker's own entrypoint (`ctx.exports`), whose
   * outbound `fetch`es the test routes to its fake servers.
   */
  useRealEngine(): void {
    // SAFETY: the test Worker exports `McpEngine` (`workerd.fixture.ts`), whose loopback stub answers its methods.
    this.#real = (this.ctx.exports as { readonly McpEngine: McpEngineMethods }).McpEngine;
  }

  /**
   * Hand every request to the real `McpEngine`, while discoveries and listens stay scripted: what a test needs to see an
   * engine's own bounds (the 16 MiB of a read) act on a watch's gap check, whose server the test routes `fetch` to.
   */
  useRealRequests(): void {
    // SAFETY: the test Worker exports `McpEngine` (`workerd.fixture.ts`), whose loopback stub answers its methods.
    this.#realRequests = (this.ctx.exports as { readonly McpEngine: McpEngineMethods }).McpEngine;
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

  /** Queue the engine's answers to the next listens on `url`, in order; none scripted: it honors every URI asked for. */
  scriptListen(url: string, scripts: ReadonlyArray<ListenScript>): void {
    this.#listenScripts.set(url, [...(this.#listenScripts.get(url) ?? []), ...scripts]);
  }

  /** The listens the engine was given, in order. */
  listens(): ReadonlyArray<ListenOpened> {
    return this.#listens.map(({ url, filter, stopped }) => ({ url, filter, stopped }));
  }

  /** The `index`th listen's server says `event` (an `McpListenEvent`). */
  sendListenEvent(index: number, event: Readonly<Record<string, string>>): void {
    const entry = this.#listens[index];

    if (entry === undefined || entry.ended) return;

    entry.events.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  }

  /** The `index`th listen's server ends it (`remote`: cut), as a stream that broke does. */
  endListen(index: number): void {
    const entry = this.#listens[index];

    if (entry !== undefined) {
      this.sendListenEvent(index, { kind: "closed", cause: "remote" });
      this.#endEvents(entry);
    }
  }

  /** End the event stream of `entry` once. */
  #endEvents(entry: {
    readonly events: ReadableStreamDefaultController<Uint8Array>;
    ended: boolean;
  }): void {
    if (entry.ended) return;

    entry.ended = true;
    entry.events.close();
  }

  /** The Resource watches the host holds, as a new instance's store reads them. */
  watchRows(): ReadonlyArray<WatchRow> {
    return this.#afterwards().watches();
  }

  /** The ends not yet told to their conversations. */
  watchEnds(): ReadonlyArray<{
    readonly session: string;
    readonly conversation: string;
    readonly server: string;
    readonly uri: string;
    readonly reason: string;
  }> {
    return this.ctx.storage.sql
      .exec<{
        session: string;
        conversation: string;
        server: string;
        uri: string;
        reason: string;
      }>(
        "SELECT session, conversation, server, uri, reason FROM mcp_watch_ends ORDER BY session, conversation, uri",
      )
      .toArray();
  }

  /** Move a watch's last request back to `at`, as if its conversation had not asked since (for the 7-day sweep). */
  setWatchRequestAt(uri: string, at: number): void {
    this.ctx.storage.sql.exec("UPDATE mcp_watches SET last_request_at = ? WHERE uri = ?", at, uri);
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

  /** How many discoveries and requests of `url` wait for `release(url)`. */
  heldCount(url: string): number {
    return this.#held.get(url)?.length ?? 0;
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

  /**
   * Move the host's clock `ms` forward and wake the long sleeps (a timer of a minute or more: a listen's hold) it passes,
   * as their time having come would: `advance` leaves them asleep, as the host's real clock does.
   */
  advanceAndWake(ms: number): void {
    this.#offset += ms;

    for (const sleeper of this.#sleepers) {
      if (sleeper.wakeAt <= this.#offset) sleeper.wake();
    }
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

  /** The object's alarm, as the McpHost DO answers it. */
  async alarm(): Promise<void> {
    await Effect.runPromise(this.#methods.alarm());
  }

  async requestStart(request: McpRequestStart): Promise<McpRequestStartAnswer> {
    return answered(await Effect.runPromise(this.#methods.requestStart(request)));
  }

  /** `requestStart` as the host answers it, whatever it answers (a failure is a value). */
  startResult(request: McpRequestStart): Promise<McpRequestStartResult> {
    return Effect.runPromise(this.#methods.requestStart(request));
  }

  /** `servers` as the host answers it, whatever it answers (a failure is a value). */
  serversResult(request: McpServersRequest): Promise<McpServersResult> {
    return Effect.runPromise(this.#methods.servers(request));
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
      sampled: span.sampled,
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
    if (this.#failing !== undefined && input.op === this.#failing) {
      return Promise.reject(new Error("This Durable Object's code was updated"));
    }

    // What the caller is told, and whether its `untilAborted` fired (resolved or rejected) before the answer was given,
    // are read back by a test: the caller going away after the answer cancels nothing.
    let answered = false;

    const watched: McpHostRequestHooks =
      hooks.untilAborted === undefined
        ? hooks
        : {
            ...hooks,
            untilAborted: () => {
              const fired = () => {
                if (!answered) this.#aborts++;
              };

              return hooks.untilAborted?.().then(fired, fired) ?? Promise.resolve();
            },
          };

    return Effect.runPromise(this.#methods.request(input, watched)).then((answer) => {
      answered = true;
      this.#answers.push(answer._tag);

      return answer;
    });
  }

  /**
   * Make `request` of `op` fail as a host that a code update replaced does, its RPC breaking (`HostLost` at the Session),
   * until `failRequests(undefined)`.
   */
  failRequests(op: string | undefined): void {
    this.#failing = op;
  }

  /** The tags of the answers `request` gave its callers, in order. */
  requestAnswers(): ReadonlyArray<string> {
    return this.#answers;
  }

  /** How many times a caller's `untilAborted` fired while its `request` was still unanswered. */
  abortsSeen(): number {
    return this.#aborts;
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

  /**
   * A code update reaches this instance (`docs/development/workers.md` → Deploys and Durable Object code updates): from now
   * on every storage operation its host runs fails, while the calls in flight, their hooks and their results carry on.
   * The test reads what is stored through a new instance (`readSet`, `prior`, the `SELECT`s below).
   */
  replace(): void {
    this.#gate.trip();
  }

  /**
   * Make the `members` of the host's store (reads or writes: `statuses`, `putInventory`) throw, as a storage that fails
   * one operation does.
   */
  refuse(members: ReadonlyArray<string>): void {
    this.#refused = new Set(members);
  }

  /** Every write of the store throws while its reads still answer (`STORE_WRITES`). */
  refuseWrites(): void {
    this.#refused = new Set(["writes"]);
  }

  /** The store works again. */
  accept(): void {
    this.#refused = new Set();
  }

  /** A new instance's store over the same storage: what the host that replaced this one finds. */
  #afterwards(): McpHostStoreService {
    return openMcpHostStore(this.ctx.storage);
  }

  /** The set as a new instance's store holds it. */
  readSet(): StoredSet | null {
    return this.#afterwards().readSet();
  }

  /** The era and Legacy session rows of `conn`, an HTTP server's or a stdio server's in `workspace`. */
  prior(conn: string, workspace?: string): McpEnginePriorEncoded {
    return this.#afterwards().prior(conn, workspace);
  }

  /** The statuses a new instance's store holds, by `conn`: their state and failure count. */
  statuses(): Readonly<Record<string, { readonly state: string; readonly failures: number }>> {
    return Record.map(
      Record.fromEntries([...this.#afterwards().statuses()]),
      ({ state, failures }) => ({ state, failures }),
    );
  }

  /** Write `conn`'s era row as text, as another build of the host did: the row the engine gets as `prior`. */
  seedEra(conn: string, json: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO mcp_eras (conn, json) VALUES (?, ?) ON CONFLICT (conn) DO UPDATE SET json = excluded.json",
      conn,
      json,
    );
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
        "mcp_watches",
        "mcp_watch_ends",
      ].map((table) => this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
    );
  }
}
