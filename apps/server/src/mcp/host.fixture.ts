// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off
// The workerd test Durable Object that hosts `McpHost`'s methods over its SQLite storage, as the McpHost DO does, in one
// long-lived runtime, with a Registry and an engine the test scripts (`docs/architecture/mcp-connections.md` →
// Testing): what the pull asks and the Registry answers (or that it cannot), the `${NAME}` values it resolves, what
// each discovery of a server's URL answers (or holds until released or aborted), and a clock the test moves forward.
import {
  HostFailed,
  type McpApply,
  type McpApplyResult,
  type McpEngineDiscoverResult,
  type McpEngineMethods,
  type McpEnginePriorEncoded,
  type McpEngineTargetEncoded,
  type McpRequestStart,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
  type McpServersAnswer,
  type McpServersRequest,
  type McpServerValuesAnswer,
} from "@cloudpid/mcp/types";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
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

/** A discovery the engine was asked for: the target as it crossed, the rows passed as `prior`, and the hooks' names. */
export type EngineCall = {
  readonly target: McpEngineTargetEncoded;
  readonly prior: McpEnginePriorEncoded;
  readonly hooks: ReadonlyArray<string>;
};

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
    },
    engine: mcpEngineClient({ discover: async (target) => unscripted(target.url) }),
  });

export class TestMcpHost extends DurableObject {
  readonly #store = openMcpHostStore(this.ctx.storage);

  readonly #asked: Array<PullAsked> = [];

  /** What the Registry answers the pull: the answer, or null for a Registry that cannot be reached. */
  #answer: McpServerSetAnswer | null = { hash: "", signInsRevision: 0 };

  /** What the Registry answers for a server's values, by name; none resolves every name to `value`. */
  readonly #values = new Map<string, McpServerValuesAnswer>();

  readonly #scripts = new Map<string, Array<EngineScript>>();

  readonly #held = new Map<string, Array<() => void>>();

  readonly #calls: Array<EngineCall> = [];

  #offset = 0;

  readonly #engine: Pick<McpEngineMethods, "discover"> = {
    discover: async (target, prior, hooks) => {
      // @effect-diagnostics-next-line preferEffectRecord:off -- the hooks' names as they crossed, whatever they are.
      this.#calls.push({ target, prior, hooks: Object.keys(hooks) });

      const queue = this.#scripts.get(target.url) ?? [];
      const script = queue.shift();

      if (script === undefined) return unscripted(target.url);

      if (script.hold === true) {
        await new Promise<void>((resolve) => {
          this.#held.set(target.url, [...(this.#held.get(target.url) ?? []), resolve]);
        });
      }

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
          Effect.sync(
            () =>
              this.#values.get(input.server) ?? {
                status: "values",
                env: {},
                headers: {},
                missing: [],
              },
          ),
      },
      engine: mcpEngineClient(this.#engine),
      references: Layer.succeed(
        Clock.Clock,
        shiftedClock(Clock.Clock.defaultValue(), () => this.#offset),
      ),
    }),
  );

  readonly #methods = mcpHostMethods(environmentOfMcpHost(this.ctx.id.name), this.#runtime);

  /** Script the Registry's answer to the pull. */
  script(answer: McpServerSetAnswer | null): void {
    this.#answer = answer;
  }

  /** Script the Registry's answer for `server`'s `${NAME}` values. */
  scriptValues(server: string, answer: McpServerValuesAnswer): void {
    this.#values.set(server, answer);
  }

  /** Queue the engine's answers to the next discoveries of `url`, in order. */
  scriptEngine(url: string, scripts: ReadonlyArray<EngineScript>): void {
    this.#scripts.set(url, [...(this.#scripts.get(url) ?? []), ...scripts]);
  }

  /** Let the held discoveries of `url` answer. */
  release(url: string): void {
    for (const resolve of this.#held.get(url) ?? []) resolve();

    this.#held.delete(url);
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

  async servers(request: McpServersRequest): Promise<McpServersAnswer> {
    return answered(await Effect.runPromise(this.#methods.servers(request)));
  }

  /** The set as the store holds it. */
  readSet(): StoredSet | null {
    return this.#store.readSet();
  }

  /** The era and Legacy session rows of `conn`. */
  prior(conn: string): McpEnginePriorEncoded {
    return this.#store.prior(conn);
  }

  /** Every table's rows as text, to look for what must not be there. */
  dump(): string {
    return JSON.stringify(
      ["mcp_meta", "mcp_servers", "mcp_inventories", "mcp_status", "mcp_eras", "mcp_sessions"].map(
        (table) => this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
      ),
    );
  }
}
