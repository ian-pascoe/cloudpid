// The MCP host object (`docs/architecture/mcp-connections.md` → The host object): one Durable Object per Environment,
// `mcp:<environment id>`, which holds that Environment's MCP state and policy. It imports only `@cloudpid/mcp/types`,
// never the SDK (`docs/architecture/mcp.md` → Packages and objects), and is never woken for an Environment without
// MCP servers (the main Worker pushes nothing to one, and a Session skips `requestStart`).
//
// Here: the set's storage, `apply({ kind: "set" })` and the pull at `windowOpened`. `servers`, `request`, discovery and
// the rest of `apply` come with their slices; an `apply` kind this build does not know fails as `HostUnsupported`.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { McpServerSetAnswer } from "@cloudpid/mcp/types";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import {
  type McpHostMethods,
  mcpHostMethods,
  type McpRegistryPortService,
  McpRegistryUnavailable,
} from "./host.ts";
import { environmentOfMcpHost } from "./name.ts";
import { openMcpHostStore } from "./store.ts";

/** One Environment's MCP host. The class name is the Durable Object class name in every stage's migrations. */
export class McpHost extends Cloudflare.DurableObject<McpHost, McpHostMethods>()("McpHost") {}

const decodeAnswer = Schema.decodeUnknownEffect(McpServerSetAnswer);

export const McpHostLive = McpHost.make(
  Effect.all({
    registries: Registry,
    state: Cloudflare.DurableObjectState,
  }).pipe(
    Effect.map(({ registries, state }) =>
      Effect.sync(() => {
        const environment = environmentOfMcpHost(state.raw.id.name);

        const store = openMcpHostStore(state.raw.storage);

        // The Registry, in this script: a failed call is a defect of the call, which the pull logs and goes on from.
        const registry: McpRegistryPortService = {
          serverSet: (input) =>
            registries
              .getByName(REGISTRY_NAME)
              .mcpServerSet(input)
              .pipe(
                Effect.flatMap(decodeAnswer),
                Effect.catchCause((cause) =>
                  Effect.fail(
                    McpRegistryUnavailable.make({
                      message: `The Registry did not answer for the MCP server set: ${Cause.pretty(cause)}`,
                    }),
                  ),
                ),
              ),
        };

        return mcpHostMethods(environment, store, registry) satisfies McpHostMethods;
      }),
    ),
  ),
);
