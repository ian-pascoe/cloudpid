// The MCP host object (`docs/architecture/mcp-connections.md` → The host object): one Durable Object per Environment,
// `mcp:<environment id>`, which holds that Environment's MCP state and policy. It imports only `@cloudpid/mcp/types`,
// never the SDK (`docs/architecture/mcp.md` → Packages and objects), and is never woken for an Environment without
// MCP servers (the main Worker pushes nothing to one, and a Session skips `requestStart`).
//
// Here: the set's storage with its revision, `apply` (`set`, `reload`, `sign_ins`, `destroy`), the pull at
// `windowOpened`, the MCP inventory (`requestStart`, `servers`) with its discoveries through `McpEngine`, a Session's
// `tools/call` (`request`), and the host's access tokens (`ask` of the Registry, kept in memory, and the reports of what
// a server answered: `McpRegistryPort`'s `accessToken` and `reportAuth` below), over one `ManagedRuntime` kept for the
// object's life. The other `request` ops and the rest of `apply` come with their slices; an `apply` kind or `op` this
// build does not know fails as `HostUnsupported`.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { MCP_ENGINE_BINDING } from "@cloudpid/mcp-worker/binding";
import {
  McpAccessTokenAnswer,
  McpAuthReportAnswer,
  type McpEngineMethods,
  McpServerSetAnswer,
  McpServerValuesAnswer,
} from "@cloudpid/mcp/types";
import { workersTelemetry } from "@cloudpid/telemetry";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { workersTracing } from "../tracing.ts";
import { mcpEngineClient } from "./engine.ts";
import {
  type McpHostMethods,
  mcpHostLayer,
  mcpHostMethods,
  type McpRegistryPortService,
  McpRegistryUnavailable,
} from "./host.ts";
import { environmentOfMcpHost } from "./name.ts";
import { openMcpHostStore } from "./store.ts";

/** One Environment's MCP host. The class name is the Durable Object class name in every stage's migrations. */
export class McpHost extends Cloudflare.DurableObject<McpHost, McpHostMethods>()("McpHost") {}

const decodeAnswer = Schema.decodeUnknownEffect(McpServerSetAnswer);

const decodeValues = Schema.decodeUnknownEffect(McpServerValuesAnswer);

const decodeToken = Schema.decodeUnknownEffect(McpAccessTokenAnswer);

const decodeReport = Schema.decodeUnknownEffect(McpAuthReportAnswer);

/**
 * A failed Registry call for `what`, as the host reads it: the Registry unavailable, never with a value in it. `cause`
 * is `false` for a call whose answer holds a secret (a token): a decode failure's text can quote the value, so the
 * message says only which call failed.
 */
const registryUnavailable =
  (what: string, { cause: detailed = true }: { readonly cause?: boolean } = {}) =>
  (cause: Cause.Cause<unknown>) =>
    Effect.fail(
      McpRegistryUnavailable.make({
        message: detailed
          ? `The Registry did not answer for ${what}: ${Cause.pretty(cause)}`
          : `The Registry did not answer for ${what}`,
      }),
    );

export const McpHostLive = McpHost.make(
  Effect.all({
    registries: Registry,
    state: Cloudflare.DurableObjectState,
    worker: Cloudflare.WorkerEnvironment,
  }).pipe(
    Effect.map(({ registries, state, worker }) =>
      Effect.gen(function* () {
        const environment = environmentOfMcpHost(state.raw.id.name);
        const store = openMcpHostStore(state.raw.storage);
        const telemetry = workersTelemetry(yield* Effect.promise(workersTracing));

        // The Registry, in this script: a failed call is a failure of the call, which the host reads as the Registry
        // being unavailable for now.
        const registry: McpRegistryPortService = {
          serverSet: (input) =>
            registries
              .getByName(REGISTRY_NAME)
              .mcpServerSet(input)
              .pipe(
                Effect.flatMap(decodeAnswer),
                Effect.catchCause(registryUnavailable("the MCP server set")),
              ),
          serverValues: (input) =>
            registries
              .getByName(REGISTRY_NAME)
              .mcpServerValues(input)
              .pipe(
                Effect.flatMap(decodeValues),
                Effect.catchCause(registryUnavailable("an MCP server's values")),
              ),
          // A token is in the answer: the failure a call leaves says which call, never what it held.
          accessToken: (input) =>
            registries
              .getByName(REGISTRY_NAME)
              .mcpAccessToken(input)
              .pipe(
                Effect.flatMap(decodeToken),
                Effect.catchCause(
                  registryUnavailable("an MCP server's access token", { cause: false }),
                ),
              ),
          reportAuth: (report) =>
            registries
              .getByName(REGISTRY_NAME)
              .reportMcpAuth(report)
              .pipe(
                Effect.flatMap(decodeReport),
                Effect.catchCause(registryUnavailable("an MCP sign-in report")),
              ),
        };

        const runtime = ManagedRuntime.make(
          mcpHostLayer({
            store,
            registry,
            // SAFETY: the Server Worker binds `McpWorker`'s `McpEngine` entrypoint as `MCP_ENGINE` (`worker.ts`), whose
            // stub answers `McpEngineMethods`.
            engine: mcpEngineClient(worker[MCP_ENGINE_BINDING] as McpEngineMethods),
            references: Layer.succeed(Tracer.Tracer, telemetry.tracer),
          }),
        );

        return mcpHostMethods(environment, runtime) satisfies McpHostMethods;
      }),
    ),
  ),
);
