// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The workerd test Durable Object that hosts a Trigger's handlers (`object.ts`) over its SQLite storage and alarm, as
// the Trigger DO does (`docs/architecture/triggers.md` → Testing): its definitions and `admitFire` are a real
// `TestRegistry`'s (`use`), the Sessions' `fire` is scripted and recorded, and so are the owner's Notifications and the
// upkeep after a start. The clock is the test's (`setNow`), and `replace()` makes its storage refuse, as a replaced
// instance's does.
import type { ApiResult, FireRequest, SubmitResult, TriggerDefinition } from "@cloudpid/protocol";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import { DurableObject } from "cloudflare:workers";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { FireAdmitted } from "../registry/triggers.ts";
import { triggerOfObject } from "./name.ts";
import {
  type FireNowAnswer,
  type TriggerHandlers,
  triggerHandlers,
  type TriggerState,
  TriggerUnreachable,
} from "./object.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

/** What a scripted Session's `fire` answers: its answer, or `"unreachable"` for an RPC that fails. */
export type FireScript = ApiResult<SubmitResult> | "unreachable";

/** A `fire` the object sent: to which Session, with what. */
export type FireSent = { readonly session: string; readonly request: FireRequest };

const OK: FireScript = { ok: true, value: { delivery: "started", cursor: "c-1" } };

const reach = <A>(what: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => TriggerUnreachable.make({ message: `${what}: ${String(cause)}` }),
  });

export class TestTrigger extends DurableObject {
  /** The object's storage: it refuses everything once `replace()` ran. */
  readonly #gate = refusingStorage(this.ctx.storage);

  /** The `TestRegistry` the definitions and `admitFire` are read from, by its hex id. */
  #registry: string | undefined;

  #now = 0;

  #registryDown = false;

  /** Set by `freezeReads`: what every read of the definition answers, however the Registry's changed since. */
  #frozen: TriggerDefinition | null | undefined;

  /** Set by `replaceOnFire`: the next Session's `fire` replaces the instance, after the Session took the Fire. */
  #replaceOnFire = false;

  /** How many Sessions `admitFire` was handed ids for. */
  #admitted = 0;

  readonly #scripts: Array<FireScript> = [];

  readonly #sent: Array<FireSent> = [];

  readonly #failed: Array<{ readonly trigger: string; readonly reason: string }> = [];

  readonly #upkeep: Array<string> = [];

  readonly #handlers: TriggerHandlers = triggerHandlers({
    id: triggerOfObject(this.ctx.id.name) ?? "",
    storage: this.#gate.storage,
    now: Effect.sync(() => this.#now),
    ports: {
      definition: (id) =>
        Effect.suspend(() => {
          if (this.#registryDown) {
            return Effect.fail(TriggerUnreachable.make({ message: "The Registry is down" }));
          }

          if (this.#frozen !== undefined) return Effect.succeed(this.#frozen);

          return reach("triggerDefinition", () => this.#registryStub().triggerDefinition(id));
        }),
      admit: (fire) =>
        Effect.suspend(() => {
          if (this.#registryDown) {
            return Effect.fail(TriggerUnreachable.make({ message: "The Registry is down" }));
          }

          const n = this.#admitted + 1;

          this.#admitted = n;

          return reach(
            "admitFire",
            async (): Promise<FireAdmitted> =>
              await this.#registryStub().admitFire(
                fire,
                { session: `s-${String(n)}`, workspace: String(n).padStart(8, "0") },
                this.#now,
              ),
          );
        }),
      failed: (trigger, reason) =>
        Effect.sync(() => {
          this.#failed.push({ trigger, reason });
        }),
      fire: (session, request) =>
        Effect.suspend(() => {
          this.#sent.push({ session, request });

          const script = this.#scripts.shift() ?? OK;

          if (this.#replaceOnFire) {
            this.#replaceOnFire = false;
            this.#gate.trip();
          }

          return script === "unreachable"
            ? Effect.fail(TriggerUnreachable.make({ message: "The Session did not answer" }))
            : Effect.succeed(script);
        }),
      afterStart: (environment) =>
        Effect.sync(() => {
          this.#upkeep.push(environment);
        }),
    },
  });

  /** What the object logged at warning level or above, in order: its level and message. */
  readonly #logged: Array<{ readonly level: string; readonly message: string }> = [];

  readonly #logger = Logger.make((options) => {
    if (
      options.logLevel === "Warn" ||
      options.logLevel === "Error" ||
      options.logLevel === "Fatal"
    ) {
      this.#logged.push({
        level: options.logLevel,
        message: String(Arr.ensure(options.message)[0]),
      });
    }
  });

  /** `effect` run as the object runs its calls, its logs kept for `logged()`. */
  #run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([this.#logger]))),
    );
  }

  logged(): ReadonlyArray<{ readonly level: string; readonly message: string }> {
    return this.#logged;
  }

  #registryStub() {
    if (this.#registry === undefined) throw new Error("No TestRegistry: call use() first");

    return this.env.REGISTRIES.get(this.env.REGISTRIES.idFromString(this.#registry));
  }

  /** Read definitions from, and admit Fires through, the `TestRegistry` of hex id `registry`. */
  use(registry: string): void {
    this.#registry = registry;
  }

  setNow(now: number): void {
    this.#now = now;
  }

  /** Make every Registry call fail (`down`), or answer again. */
  setRegistryDown(down: boolean): void {
    this.#registryDown = down;
  }

  /**
   * Every read of the definition answers the one the Registry holds now, as a read that raced a change does: only
   * `admitFire` sees what changed after.
   */
  async freezeReads(): Promise<void> {
    const id = triggerOfObject(this.ctx.id.name) ?? "";

    this.#frozen = await this.#registryStub().triggerDefinition(id);
  }

  /** What the next Sessions' `fire` answer, in order; then every one answers `ok`. */
  scriptFires(scripts: ReadonlyArray<FireScript>): void {
    this.#scripts.push(...scripts);
  }

  sent(): ReadonlyArray<FireSent> {
    return this.#sent;
  }

  failedNotices(): ReadonlyArray<{ readonly trigger: string; readonly reason: string }> {
    return this.#failed;
  }

  upkeep(): ReadonlyArray<string> {
    return this.#upkeep;
  }

  /** The time the object's alarm is set for, read past the gate. */
  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** The code update reached this instance: its storage refuses from now on. */
  replace(): void {
    this.#gate.trip();
  }

  /** The next Session's `fire` is answered, then the code update reaches this instance (`replace`). */
  replaceOnFire(): void {
    this.#replaceOnFire = true;
  }

  /** The alarm, run whether one is set or not. */
  runAlarm(): Promise<void> {
    return this.alarm();
  }

  sync(): Promise<TriggerState> {
    return this.#run(this.#handlers.sync());
  }

  remove(): Promise<void> {
    return this.#run(this.#handlers.remove());
  }

  fireNow(): Promise<FireNowAnswer> {
    return this.#run(this.#handlers.fireNow());
  }

  fireLog(limit?: number) {
    return this.#run(this.#handlers.fireLog(limit === undefined ? undefined : { limit }));
  }

  state(): Promise<TriggerState> {
    return this.#run(this.#handlers.state());
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#run(this.#handlers.alarm(info));
  }
}
