// The Trigger object (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): one Durable
// Object per Trigger, `trigger:<trigger id>`, which holds its Schedule's cursor, its pending Fires and its fire log, and
// whose alarm fires it (`object.ts`). Its ports are RPC to the Registry (`triggerDefinition`, `admitFire`,
// `notifyTriggerFailed`) and to the Fire's Session (`fire`), and the spare and Build upkeep after a Fire took a spare,
// as after the owner's start (`upkeepAfterStart`). Every span is a custom span of the Worker's trace.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { ApiResult, SubmitResult, TriggerDefinition } from "@cloudpid/protocol";
import { workersTelemetry } from "@cloudpid/telemetry";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { buildUpkeep } from "../registry/builds.ts";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { spareUpkeep, upkeepAfterStart } from "../registry/rpc.ts";
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
  }).pipe(
    Effect.map(({ registries, sessions, state, worker }) =>
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
        };

        const handlers = triggerHandlers({
          // A name that is no `trigger:<id>` has no Trigger: its definition never reads, so its object wipes itself.
          id: triggerOfObject(state.raw.id.name) ?? "",
          storage: state.raw.storage,
          ports,
        });

        /** `effect` under the tracer every Trigger span is made by. */
        const traced = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.provideService(effect, Tracer.Tracer, telemetry.tracer);

        return {
          sync: () => traced(handlers.sync()),
          remove: () => traced(handlers.remove()),
          fireNow: () => traced(handlers.fireNow()),
          fireLog: (input) => traced(handlers.fireLog(input)),
          state: () => traced(handlers.state()),
          alarm: (info) => traced(handlers.alarm(info)),
        } satisfies TriggerHandlers;
      }),
    ),
  ),
);
