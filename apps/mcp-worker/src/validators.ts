/**
 * The validator cache, one per isolate: tools' `outputSchema`s compiled with TypeBox, by schema hash, so a
 * `tools/call` result's `structuredContent` is checked in the engine (`docs/architecture/mcp-connections.md` → The
 * engine, Validation and compiling; The MCP core #394 D17, refined by #382 D8, D9.3).
 *
 * TypeBox runs through its interpreted fallback: acceleration (`new Function`) is switched off, since a Worker may
 * not evaluate code once it has started, whatever `allow_eval_during_startup` allows at startup, and nothing compiles
 * at module scope. Schemas compile wherever the engine lists tools (discovery, a `-32020` refresh, a `tools/list`
 * request), yielding between schemas; a call whose schema is not cached (after a restart, or a deploy) compiles it
 * then. The cache keeps 2,000 schemas, dropping the least recently used.
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { McpConnection } from "@cloudpid/mcp";
import type { McpStructuredOutput, McpToolDefinition, McpToolProblem } from "@cloudpid/mcp/types";
import { Compile, type Validator, type XSchema } from "typebox/schema";
import { Settings } from "typebox/system";

/** How many compiled schemas an isolate keeps. */
export const VALIDATOR_CACHE_SIZE = 2000;

/** How many of a result's validation errors are reported. */
const MAX_ERRORS = 5;

type JsonObject = { readonly [key: string]: Schema.Json };

/** A `tools/call` result's `structuredContent`, as the SDK decoded it. */
type StructuredContent = Extract<
  Effect.Success<ReturnType<McpConnection["callTool"]>>,
  { readonly kind: "complete" }
>["value"]["structuredContent"];

/** A compiled schema, or why it could not be compiled. */
type Compiled =
  | { readonly kind: "compiled"; readonly validator: Validator }
  | { readonly kind: "rejected"; readonly reason: string };

export interface ValidatorsApi {
  /** Compiles each tool's `outputSchema` into the cache, yielding between them; the tools TypeBox rejected. */
  readonly compileAll: (
    tools: ReadonlyArray<McpToolDefinition>,
  ) => Effect.Effect<ReadonlyArray<McpToolProblem>>;
  /** How `structuredContent` fits `outputSchema` (D17). */
  readonly check: (
    outputSchema: JsonObject,
    structuredContent: StructuredContent,
  ) => Effect.Effect<McpStructuredOutput>;
}

export class Validators extends Context.Service<Validators, ValidatorsApi>()(
  "@cloudpid/mcp-worker/validators",
) {
  static readonly layer = Layer.sync(Validators, () => makeValidators());
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** SHA-256 of the schema as the server sent it: one server's schemas hash alike from one listing to the next. */
const hashOf = (schema: JsonObject) =>
  encodeJson(schema).pipe(
    Effect.orDie,
    Effect.flatMap((json) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))),
    ),
    Effect.map((digest) =>
      Arr.join(
        Arr.map(Arr.fromIterable(new Uint8Array(digest)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ),
        "",
      ),
    ),
  );

const compile = (schema: JsonObject): Compiled => {
  try {
    // SAFETY: a JSON object is a JSON Schema object as far as TypeBox's types go; TypeBox checks the rest itself.
    return { kind: "compiled", validator: Compile(schema as XSchema) };
  } catch (error) {
    return { kind: "rejected", reason: error instanceof Error ? error.message : String(error) };
  }
};

const makeValidators = (): ValidatorsApi => {
  Settings.Set({ useAcceleration: false });

  const cache = new Map<string, Compiled>();

  const compiled = (schema: JsonObject) =>
    Effect.gen(function* () {
      const hash = yield* hashOf(schema);
      const cached = cache.get(hash);

      if (cached !== undefined) {
        // Most recently used last.
        cache.delete(hash);
        cache.set(hash, cached);

        return cached;
      }

      const fresh = compile(schema);

      cache.set(hash, fresh);

      for (const oldest of cache.keys()) {
        if (cache.size <= VALIDATOR_CACHE_SIZE) {
          break;
        }

        cache.delete(oldest);
      }

      return fresh;
    });

  return {
    compileAll: (tools) =>
      Effect.gen(function* () {
        const problems: Array<McpToolProblem> = [];

        for (const tool of tools) {
          if (tool.outputSchema === undefined) {
            continue;
          }

          const result = yield* compiled(tool.outputSchema);

          if (result.kind === "rejected") {
            problems.push({ tool: tool.name, problem: `invalid outputSchema: ${result.reason}` });
          }

          // Workers' clocks stand still while code runs, so the engine yields after every schema, not every 20 ms.
          yield* Effect.yieldNow;
        }

        return problems;
      }),
    check: (outputSchema, structuredContent) =>
      Effect.gen(function* () {
        if (structuredContent === undefined) {
          return {
            valid: false,
            errors: ["the tool declares an outputSchema but returned no structuredContent"],
          } as const;
        }

        const result = yield* compiled(outputSchema);

        if (result.kind === "rejected") {
          return { valid: false, errors: [`invalid outputSchema: ${result.reason}`] } as const;
        }

        if (result.validator.Check(structuredContent)) {
          return { valid: true } as const;
        }

        const [, errors] = result.validator.Errors(structuredContent);

        return {
          valid: false,
          errors: Arr.map(
            Arr.take(errors, MAX_ERRORS),
            (error) => `${error.instancePath === "" ? "/" : error.instancePath}: ${error.message}`,
          ),
        } as const;
      }),
  };
};
