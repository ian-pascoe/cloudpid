// Effect-defined pi-durable tools (ADR-0003): Effect `Schema` parameters, Chord cancellation as fiber interruption, and
// typed failures as error results.
import type { JsonValue } from "@earendil-works/chord";
import type * as Chord from "@earendil-works/chord/context";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { invoker } from "./chord.ts";

/** What an Effect tool may fail with: its message becomes the error result the model sees. */
export type ToolFailure = { readonly message: string };

/**
 * A tool whose parameters are an Effect `Schema.Struct` and whose execution is an Effect. A typed failure becomes an
 * error result with its message; a defect is thrown, as from any pi-durable tool.
 *
 * A typed failure ends the call `completed`, as any returned result does, so pi-durable does not cancel the tasks and
 * conversations the call owns, as it does after a throw. A tool that starts owned work cleans it up itself, for
 * example in a finalizer.
 */
export type EffectToolDefinition<
  Fields extends Schema.Struct.Fields,
  TDetails extends JsonValue,
  E extends ToolFailure,
  R,
> = Omit<ToolRegistration<TSchema, TDetails>, "parameters" | "execute" | "prepareArguments"> & {
  readonly parameters: Schema.Struct<Fields>;
  readonly execute: (
    args: Schema.Struct<Fields>["Type"],
    api: ToolExecutionApi<TDetails>,
  ) => Effect.Effect<ToolExecutionResult<TDetails>, E, R>;
};

/** Every model-facing tool name is snake_case (`docs/spec.md` → Tool naming). */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Arguments the parameters do not model are rejected, by the JSON Schema and by the decoder alike. */
const STRICT = { onExcessProperty: "error" } as const;

/**
 * `parameters` as the JSON Schema pi-durable validates calls against and offers the model: one object schema, with
 * identified schemas inlined (providers reject a root `$ref`, and pi-ai's argument repair does not follow `$ref`s).
 * Only recursive schemas keep a reference, under `$defs`. Building a tool whose parameters compile otherwise dies.
 */
const jsonSchema = <Fields extends Schema.Struct.Fields>(
  name: string,
  parameters: Schema.Struct<Fields>,
): Effect.Effect<TSchema> => {
  // Effect describes an empty Struct as any non-null value.
  if (Record.isEmptyRecord(parameters.fields)) {
    return Effect.succeed({ type: "object", properties: {}, additionalProperties: false });
  }

  const document = Schema.toJsonSchemaDocument(parameters, {
    ...STRICT,
    referencePolicy: () => undefined,
  });

  if (document.schema.type !== "object") {
    return Effect.die(new Error(`Tool ${name}'s parameters are not one object schema`));
  }

  return Effect.succeed(
    Record.isEmptyRecord(document.definitions)
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
};

/**
 * A settled call as pi-durable expects it: a typed failure as an error result. A defect, even beside a failure, and
 * any failure of a call pi-durable cancelled are thrown, so pi-durable records them itself: as a `tool_error` result,
 * or as an aborted call.
 */
const toResult =
  (context: Chord.Context) =>
  <TDetails extends JsonValue>(
    exit: Exit.Exit<ToolExecutionResult<TDetails>, ToolFailure>,
  ): ToolExecutionResult<TDetails> => {
    if (Exit.isSuccess(exit)) return exit.value;

    // Defects win over failures, as in Effect's own error reporting.
    const defect = Cause.findDefect(exit.cause);

    if (Result.isSuccess(defect)) throw defect.success;

    const failure = Cause.findErrorOption(exit.cause);

    if (Option.isNone(failure) || context.abortSignal?.aborted === true) {
      throw Cause.squash(exit.cause);
    }

    return { isError: true, output: [{ type: "text", text: failure.value.message }] };
  };

/**
 * A pi-durable tool from an Effect definition, run with the services of the Effect that builds it. The model is offered
 * `parameters` as JSON Schema, and a call's arguments are decoded with its JSON codec before `execute` runs. The call's
 * fiber is interrupted when pi-durable cancels the call, for example when its conversation is aborted.
 */
export const defineEffectTool = <
  Fields extends Schema.Struct.Fields,
  E extends ToolFailure,
  R,
  TDetails extends JsonValue = JsonValue,
>(
  tool: EffectToolDefinition<Fields, TDetails, E, R>,
): Effect.Effect<
  ToolRegistration<TSchema, TDetails>,
  never,
  R | Schema.Struct<Fields>["DecodingServices"]
> =>
  Effect.gen(function* () {
    if (!SNAKE_CASE.test(tool.name)) {
      return yield* Effect.die(new Error(`Tool name ${tool.name} is not snake_case`));
    }

    const invoke = invoker(yield* Effect.context<R | Schema.Struct<Fields>["DecodingServices"]>());
    const { parameters, execute, ...rest } = tool;
    const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(parameters), STRICT);

    return {
      ...rest,
      parameters: yield* jsonSchema(tool.name, parameters),
      execute: (args, api, context) =>
        invoke(
          Effect.flatMap(decode(args), (decoded) => execute(decoded, api)),
          context,
        ).then(toResult(context)),
    } satisfies ToolRegistration<TSchema, TDetails>;
  });
