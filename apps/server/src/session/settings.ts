// What a Session reads from the settings (`docs/spec.md` → Settings). The overrides live in the Registry DO; the Session
// keeps the last it read, in its own storage, and hands the Harness live getters over that copy. The Harness reads its
// settings synchronously, so the Registry is read before a request is admitted (`refresh`), never inside a getter.
import { DEFAULT_SETTINGS, parseModelId, resolveSettings, type Settings } from "@cloudpid/config";
import type {
  AgentChange,
  CompactionPolicy,
  HarnessSettings,
  ModelRef,
} from "@earendil-works/pi-durable";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** How long reading the Registry may take before the Session carries on with what it last read. */
export const SETTINGS_TIMEOUT: Duration.Input = "2 seconds";

/** What the Session and its Harness use of the settings. */
export type SessionSettingsValues = {
  /** The agent a root conversation follows unless its Session picked its own. */
  readonly agent: {
    readonly model: ModelRef;
    readonly thinkingLevel: NonNullable<AgentChange["thinkingLevel"]>;
  };
  readonly compaction: CompactionPolicy;
};

/** The parts of `settings` a Session uses. */
export const valuesFrom = (settings: Settings): SessionSettingsValues => ({
  agent: { model: parseModelId(settings.model), thinkingLevel: settings.thinkingLevel },
  compaction: settings.compaction,
});

export type SessionSettingsService = {
  /** The settings as last read, or the defaults: synchronous, for the Harness's getters. */
  readonly current: () => SessionSettingsValues;
  /**
   * Read the Registry now. A Registry that fails or is slow keeps the settings last read, and is logged: the Session
   * must not stop for it.
   */
  readonly refresh: Effect.Effect<void>;
};

/** The Session's settings. */
export class SessionSettings extends Context.Service<SessionSettings, SessionSettingsService>()(
  "@cloudpid/server/session/settings/SessionSettings",
) {}

/** The parts of a Durable Object's `storage.kv` the settings use. */
export type SettingsKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** Where the overrides last read are kept. */
const OVERRIDES_KEY = "settings-overrides";

export type SessionSettingsOptions = {
  /** The Registry's saved overrides. */
  readonly read: Effect.Effect<Schema.Json>;
  /** The object's `storage.kv`, which keeps the overrides last read for an instance that starts with the Registry down. */
  readonly kv: SettingsKv;
  /** Defaults to `SETTINGS_TIMEOUT`. */
  readonly timeout?: Duration.Input;
};

/** The settings the overrides give, or the defaults, with the reason logged, when they no longer resolve. */
const resolveOrDefaults = (overrides: Schema.Json) => {
  const resolved = resolveSettings(overrides);

  return Result.isSuccess(resolved)
    ? Effect.succeed(resolved.success)
    : Effect.logWarning(
        `Saved settings overrides do not resolve:\n${resolved.failure.message}`,
      ).pipe(Effect.as(DEFAULT_SETTINGS));
};

/** The Session's settings, starting from the overrides last kept in `kv`. */
export const sessionSettingsLayer = (
  options: SessionSettingsOptions,
): Layer.Layer<SessionSettings> =>
  Layer.effect(
    SessionSettings,
    Effect.gen(function* () {
      const { kv } = options;
      const kept = kv.get<Schema.Json>(OVERRIDES_KEY);

      let current = valuesFrom(
        kept === undefined ? DEFAULT_SETTINGS : yield* resolveOrDefaults(kept),
      );

      const refresh = options.read.pipe(
        Effect.timeout(options.timeout ?? SETTINGS_TIMEOUT),
        Effect.flatMap((overrides) =>
          resolveOrDefaults(overrides).pipe(
            Effect.tap((settings) =>
              Effect.sync(() => {
                kv.put(OVERRIDES_KEY, overrides);
                current = valuesFrom(settings);
              }),
            ),
          ),
        ),
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Reading the settings from the Registry failed", Cause.pretty(cause)),
        ),
      );

      return { current: () => current, refresh } satisfies SessionSettingsService;
    }),
  );

/**
 * The Harness's settings over a Session's: `compaction` is read at every resolution, so what `refresh` last read
 * applies to the next request. Idle conversations keep no context or documents in memory: pi-durable 1.3.0 holds them
 * on `setTimeout` timers, and in Workers a pending timer, even an unreferenced one, keeps the object from being evicted
 * or hibernating. SQLite is local to the object, so reloading them is cheap. pi-durable main declines these timers in
 * Workers itself.
 */
export const harnessSettings = (settings: SessionSettingsService): HarnessSettings => ({
  contextRetentionMs: 0,
  documentRetentionMs: 0,
  get compaction() {
    return settings.current().compaction;
  },
});
