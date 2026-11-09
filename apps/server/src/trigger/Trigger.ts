// The Trigger object (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): one Durable
// Object per Trigger, `trigger:<trigger id>`, which holds its Schedule's cursor, its pending Fires and its fire log, and
// whose alarm fires it (`object.ts`). Its ports are RPC to the Registry (`triggerDefinition`, `admitFire`,
// `notifyTriggerFailed`) and to the Fire's Session (`fire`), and the spare and Build upkeep after a Fire took a spare,
// as after the owner's start (`upkeepAfterStart`). A webhook Trigger's secrets are sealed with `SecretsConfig`'s key under
// the purpose `trigger:<id>`, and the App's own bot account (for the bot-loop guard) is asked of GitHub as the App
// (`GitHubAppConfig`). Every span is a custom span of the Worker's trace.
// @effect-diagnostics globalFetch:off globalDate:off -- GitHub is asked with `fetch`, as `GitHubApp` is everywhere.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { openKeptVault } from "@cloudpid/extensions/secrets/core";
import { ApiResult, SubmitResult, TriggerDefinition } from "@cloudpid/protocol";
import { workersTelemetry } from "@cloudpid/telemetry";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { GitHubApp } from "../github/app.ts";
import { GitHubAppConfig } from "../github/config.ts";
import { buildUpkeep } from "../registry/builds.ts";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { spareUpkeep, upkeepAfterStart } from "../registry/rpc.ts";
import { SecretsConfig } from "../session/secrets.ts";
import { Session } from "../session/Session.ts";
import { workersTracing } from "../tracing.ts";
import { WORKSPACE_BINDING } from "../workspace/binding.ts";
import { workspaceObjectsRemote } from "../workspace/lifecycle.ts";
import { TRIGGER_CLASS, triggerOfObject } from "./name.ts";
import {
  type TriggerHandlers,
  triggerHandlers,
  type TriggerPorts,
  TriggerUnreachable,
} from "./object.ts";

/**
 * One Trigger's object. The class name is the Durable Object class name in every stage's migrations. Its methods'
 * failure, `TriggerUnreachable`, crosses RPC as itself.
 */
export class Trigger extends Cloudflare.DurableObject<Trigger, TriggerHandlers>()(TRIGGER_CLASS, {
  errors: [TriggerUnreachable],
}) {}

const decodeDefinition = Schema.decodeUnknownEffect(Schema.NullOr(TriggerDefinition));

const decodeFired = Schema.decodeUnknownEffect(ApiResult(SubmitResult));

/** A failed call for `what`, as the object reads it: unreachable for now, tried again later. */
const unreachable = (what: string) => (cause: Cause.Cause<unknown>) =>
  Effect.fail(
    TriggerUnreachable.make({ message: `${what} did not answer: ${Cause.pretty(cause)}` }),
  );

export const TriggerLive = Trigger.make(
  Effect.all({
    registries: Registry,
    sessions: Session,
    state: Cloudflare.DurableObjectState,
    worker: Cloudflare.WorkerEnvironment,
    secrets: SecretsConfig,
    github: GitHubAppConfig,
  }).pipe(
    Effect.map(({ registries, sessions, state, worker, secrets, github }) =>
      Effect.gen(function* () {
        const telemetry = workersTelemetry(yield* Effect.promise(workersTracing));
        const registry = () => registries.getByName(REGISTRY_NAME);

        // SAFETY: the Server Worker binds the Workspace DO namespace as `WORKSPACES` (`worker.ts`); the Workspace DO
        // answers `LifecycleHost`'s calls and the Build object's.
        const workspaces = workspaceObjectsRemote(
          worker[WORKSPACE_BINDING] as Parameters<typeof workspaceObjectsRemote>[0],
        );

        const spares = spareUpkeep(registries, { workspaces });
        const builds = buildUpkeep(registries, { workspaces, spares });

        // The object's id, so a token or secret sealed by one Trigger opens in no other.
        const id = triggerOfObject(state.raw.id.name) ?? "";

        // The vault is made once, at the first delivery or secret: a malformed master key fails those, not the object.
        const vault = yield* Effect.cached(
          openKeptVault(Redacted.value(secrets.encryptionKey), `trigger:${id}`).pipe(
            Effect.mapError((error) =>
              TriggerUnreachable.make({
                message: `The vault could not be opened: ${error.message}`,
              }),
            ),
          ),
        );

        // The App's own bot account, asked of GitHub once (`GET /app`); the guard falls back to any bot while it can't.
        const app = new GitHubApp({
          appId: Redacted.value(github.appId),
          privateKey: Redacted.value(github.privateKey),
          fetch: (url, init) => fetch(url, init),
          now: () => Date.now(),
        });

        const ports: TriggerPorts = {
          definition: (id) =>
            registry()
              .triggerDefinition({ id })
              .pipe(
                Effect.flatMap(decodeDefinition),
                Effect.catchCause(unreachable("The Registry's triggerDefinition")),
              ),
          admit: (fire) =>
            registry()
              .admitFire(fire)
              .pipe(Effect.catchCause(unreachable("The Registry's admitFire"))),
          failed: (trigger, reason) =>
            registry()
              .notifyTriggerFailed({ trigger, reason })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("A Trigger could not tell its owner a Fire failed", cause),
                ),
              ),
          fire: (session, request) =>
            sessions
              .getByName(session)
              .fire(request)
              .pipe(
                Effect.flatMap(decodeFired),
                Effect.catchCause(unreachable("The Session's fire")),
              ),
          afterStart: (environment) => upkeepAfterStart({ spares, builds }, environment),
          vault,
          botLogin: Effect.tryPromise(() => app.botLogin()).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "The GitHub App's bot account could not be read",
                error.message,
              ).pipe(Effect.as(undefined)),
            ),
          ),
        };

        const handlers = triggerHandlers({
          // A name that is no `trigger:<id>` has no Trigger: its definition never reads, so its object wipes itself.
          id,
          storage: state.raw.storage,
          ports,
        });

        /** `effect` under the tracer every Trigger span is made by. */
        const traced = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.provideService(effect, Tracer.Tracer, telemetry.tracer);

        return {
          sync: () => traced(handlers.sync()),
          remove: () => traced(handlers.remove()),
          fireNow: (input) => traced(handlers.fireNow(input)),
          fireAgain: (input) => traced(handlers.fireAgain(input)),
          deliver: (delivery) => traced(handlers.deliver(delivery)),
          deliveries: () => traced(handlers.deliveries()),
          reveal: () => traced(handlers.reveal()),
          rotate: (what) => traced(handlers.rotate(what)),
          fireLog: (input) => traced(handlers.fireLog(input)),
          state: () => traced(handlers.state()),
          alarm: (info) => traced(handlers.alarm(info)),
        } satisfies TriggerHandlers;
      }),
    ),
  ),
);
