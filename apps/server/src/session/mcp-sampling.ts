// The Session's MCP Sampling (`docs/architecture/mcp-server-requests.md` → Sampling requests): the sampler that runs a
// Legacy server's request, with `sampling: "allow"`, on the Session's own models. Its records are kept in this object's
// storage and never read into any model's context. The tools that call are built outside the Session's runtime
// (`./mcp-host.ts`), so the service is made synchronously: the Secrets it redacts with are bound when the runtime builds
// its layer, and the models, the Roles, the limit and where Usage goes when the host opens (`SessionHostMcp.bindSampling`).
import {
  createMcpSampling,
  McpSampling,
  type McpQuestionStorage,
  type McpSamplingOptions,
  type McpSamplingService,
} from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type SessionMcpSamplingOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: McpQuestionStorage;
  /** The Session's questions, which ask the owner of a server whose definition says `ask`. */
  readonly questions?: McpSamplingOptions["questions"];
};

/** The service the Session's MCP tools sample through, and the layer that provides it once the Secrets are built. */
export type SessionMcpSampling = {
  readonly service: McpSamplingService;
  readonly layer: Layer.Layer<McpSampling, never, Secrets>;
};

export const sessionMcpSampling = (options: SessionMcpSamplingOptions): SessionMcpSampling => {
  let bound: SecretsService | undefined;

  /** The Secrets, asked for again if they are due; a request is never made before the runtime is built. */
  const secrets = Effect.suspend(() =>
    bound === undefined
      ? Effect.die("The Session's Secrets are not built yet")
      : Effect.as(bound.refresh, bound),
  );

  const service = createMcpSampling({
    storage: options.storage,
    questions: options.questions,
    // What a record keeps, and what a model is shown of a server's tools, never holds a Secret's value.
    redact: (value) => Effect.map(secrets, (held) => held.redact(value)),
  });

  return {
    service,
    layer: Layer.effect(
      McpSampling,
      Effect.gen(function* () {
        bound = yield* Secrets;

        return service;
      }),
    ),
  };
};
