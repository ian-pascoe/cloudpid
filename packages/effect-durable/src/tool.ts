// Effect-defined pi-durable tools (ADR-0003): Effect `Schema` parameters, Chord cancellation as fiber interruption, and
// typed failures as error results.
import type { JsonValue } from "@earendil-works/chord";
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
import * as Schema from "effect/Schema";
import { invoker } from "./chord.ts";

/** What an Effect tool may fail with: its message becomes the error result the model sees. */
export type ToolFailure = { readonly message: string };

/**
 * A tool whose parameters are an Effect `Schema.Struct` and whose execution is an Effect. A typed failure becomes an
 * error result with its message; a defect is thrown, as from any pi-durable tool.
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

/** `parameters` as the JSON Schema pi-durable validates calls against and offers the model. */
const jsonSchema = (parameters: Schema.Top): TSchema => {
  const document = Schema.toJsonSchemaDocument(parameters, STRICT);

  return Record.isEmptyRecord(document.definitions)
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

/** A settled call as pi-durable expects it: a typed failure as an error result; interruption and defects thrown. */
const toResult = <TDetails extends JsonValue>(
  exit: Exit.Exit<ToolExecutionResult<TDetails>, ToolFailure>,
): ToolExecutionResult<TDetails> => {
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.findErrorOption(exit.cause);

  // pi-durable records an aborted call itself, and a thrown error as an error result.
  if (Option.isNone(failure)) throw Cause.squash(exit.cause);

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
      parameters: jsonSchema(parameters),
      execute: (args, api, context) =>
        invoke(
          Effect.flatMap(decode(args), (decoded) => execute(decoded, api)),
          context,
        ).then(toResult),
    } satisfies ToolRegistration<TSchema, TDetails>;
  });
