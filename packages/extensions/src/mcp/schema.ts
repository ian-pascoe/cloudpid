// What a script gets for a call of an MCP tool (`docs/architecture/mcp-in-a-session.md` → Calls and results, The script
// value): the tool's `structuredOutputSchema`, `{ content, structuredContent?, isError?, truncated? }`, with the tool's
// own `outputSchema` typing `structuredContent`. The schema is built from the declaration alone, so a rebuild over
// unchanged tools gives byte-identical declarations (AGENTS.md → Prompt cache).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain walks over JSON.
import { isJsonObject, type JsonObject } from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);

/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/** Keywords that name a place other than a pointer into the document: moving the schema would break them. */
const UNMOVABLE: ReadonlySet<string> = new Set(["$id", "$anchor", "$dynamicRef", "$dynamicAnchor"]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of another: its local
 * references (`#`, `#/$defs/Item`) are rewritten to point below `pointer`, so they resolve to what they did. It is
 * `undefined` for a schema that cannot move: a reference that is not a pointer into the schema (a remote one, or an
 * anchor), or a keyword that renames the document.
 */
const relocate = (schema: Schema.Json, pointer: string, root: boolean): Schema.Json | undefined => {
  if (Array.isArray(schema)) {
    const items = schema.map((item) => relocate(item, pointer, false));

    return items.every((item) => item !== undefined) ? items : undefined;
  }

  if (!isJsonObject(schema)) return schema;

  const moved: Record<string, Schema.Json> = {};

  for (const [key, value] of Object.entries(schema)) {
    // The draft and name of the schema we embed are the document's, not the tool's.
    if (root && (key === "$schema" || key === "$id")) continue;

    if (key === "$ref") {
      if (!Predicate.isString(value) || (value !== "#" && !value.startsWith("#/")))
        return undefined;

      moved[key] = `${pointer}${value.slice(1)}`;
    } else if (UNMOVABLE.has(key)) {
      return undefined;
    } else if (DATA_KEYWORDS.has(key)) {
      moved[key] = value;
    } else if (MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      const named: Record<string, Schema.Json> = {};

      for (const [name, sub] of Object.entries(value)) {
        const inner = relocate(sub, pointer, false);

        if (inner === undefined) return undefined;

        named[name] = inner;
      }

      moved[key] = named;
    } else {
      const inner = relocate(value, pointer, false);

      if (inner === undefined) return undefined;

      moved[key] = inner;
    }
  }

  return moved;
};

/** Where `structuredContent` sits in the script value's schema. */
const STRUCTURED_POINTER = "#/properties/structuredContent";

/**
 * A content block as a script reads it: its `type` and the fields of text and image blocks, which scripts read most
 * (`image(block)` takes an image block as it is). The type is any string, so a block a newer protocol adds is not
 * refused, and further keys pass.
 */
const CONTENT_BLOCK = {
  type: "object",
  properties: {
    type: { type: "string" },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
} as const;

/**
 * `outputSchema` as the type of `structuredContent`, with its local `$ref`s relocated: any JSON when the tool declares
 * none, or declares one that cannot move (a remote `$ref`, an `$anchor`).
 */
const structuredOf = (outputSchema: JsonObject | undefined): Schema.Json =>
  outputSchema === undefined ? {} : (relocate(outputSchema, STRUCTURED_POINTER, true) ?? {});

/**
 * Every MCP tool's `structuredOutputSchema`: the `tools/call` result a script gets, without `_meta`, with the tool's
 * `outputSchema` typing `structuredContent`. MCP's camelCase keys are kept, a documented exception to the snake_case
 * shapes. `truncated` says text was cut to fit a nested call's value.
 */
export const scriptSchemaOf = (outputSchema: JsonObject | undefined): JsonObject => ({
  type: "object",
  properties: {
    content: { type: "array", items: CONTENT_BLOCK },
    structuredContent: structuredOf(outputSchema),
    isError: {
      type: "boolean",
      description: "The tool reported a failure; the call still resolves",
    },
    truncated: { type: "boolean", description: "Text in content was cut to fit" },
  },
  required: ["content"],
  additionalProperties: true,
});
