/**
 * `McpServer`, the `WorkerEntrypoint` that serves cloudpid's own MCP endpoint, `/mcp` (ADR-0038;
 * `docs/architecture/mcp-endpoint.md` → The handler, Telemetry and testing). The main Worker verifies the Access
 * assertion and calls `serve(request, api)` over RPC; the SDK, the schemas and the tools are `@cloudpid/mcp/server`'s, and
 * this entrypoint is what is Workers': the `api` stub's lifetime, Workers tracing and the isolate's `describe()` cache. It
 * binds neither the Registry nor the Sessions, only reaches them through `api`.
 *
 * `serve` returns while its SSE body is still open, and the tools call `api` as it streams, after the invocation that
 * received the stub has ended: so it `dup()`s the stub and disposes of it once the body is done or cancelled.
 */
// @effect-diagnostics asyncFunction:off newPromise:off globalConsole:off preferEffectRecord:off -- Workers' RPC and streams are Promise-based.
import * as workers from "cloudflare:workers";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type McpObserver,
  type McpServerApi,
  serveMcp,
  toolGate,
  unobserved,
} from "@cloudpid/mcp/server";
import type { McpWorkerEnv } from "./engine.ts";

/** The parts of Workers tracing (`tracing` from `cloudflare:workers`) the spans use. */
interface Tracing {
  startActiveSpan<T>(
    name: string,
    callback: (span: {
      readonly isTraced: boolean;
      setAttribute(key: string, value: string | number | boolean): void;
      end(): void;
    }) => T,
  ): T;
}

/** The API where the runtime has it: an old local workerd has none, and the endpoint then goes unobserved. */
// SAFETY: `tracing` is typed by the runtime's own types only where the installed `@cloudflare/workers-types` has it; this reads it as the part `Tracing` says, or absent.
const tracing = (workers as { readonly tracing?: Tracing }).tracing;

type Attributes = Readonly<Record<string, string | number | boolean>>;

/** The attributes the spans carry are all short names, numbers and ids (`McpObserver`): never text of a call. */
const observed: McpObserver =
  tracing === undefined
    ? unobserved
    : {
        request: (attributes) => {
          tracing.startActiveSpan("mcp.server.request", (span) => {
            for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);

            span.end();
          });
        },
        call: (attributes, run) =>
          tracing.startActiveSpan("mcp.server.call", async (span) => {
            const record = (more: Attributes) => {
              for (const [key, value] of Object.entries(more)) span.setAttribute(key, value);
            };

            record(attributes);

            try {
              return await run(record);
            } finally {
              span.end();
            }
          }),
      };

/** What the entrypoint holds of the `api` stub: it is a stub of `McpApi`, which can be `dup()`ed and disposed. */
type ApiStub = McpServerApi & { dup(): ApiStub; [Symbol.dispose](): void };

/** `describe()`, asked once a minute per isolate: a tool is served once the deployed `Server` supports it. */
const gate = toolGate();

/** `response`, whose body releases `release` once it has been read to its end or cancelled. */
const releasing = (response: Response, release: () => void): Response => {
  if (response.body === null) {
    release();

    return response;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  response.body.pipeTo(writable).then(release, release);

  return new Response(readable, response);
};

export class McpServer extends WorkerEntrypoint<McpWorkerEnv> {
  /** Answers one `/mcp` request. `api` is the main Worker's `McpApi` target for it: the caller's identity is closed over it. */
  async serve(request: Request, api: ApiStub): Promise<Response> {
    const held = api.dup();

    try {
      const response = await serveMcp(request, {
        api: held,
        version: this.env.CF_VERSION_METADATA?.id ?? "dev",
        gate,
        observe: observed,
        onError: (error) => console.error("mcp.server.error", error.name),
      });

      return releasing(response, () => held[Symbol.dispose]());
    } catch (error) {
      held[Symbol.dispose]();

      throw error;
    }
  }
}
