// The declarations of the harness tools (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared
// definitions, Names and surfaces): on both surfaces, every tool is read-only and holds no definitions, and its output
// schema has the shape the endpoint needs on both MCP lanes (L12); the names are snake_case and none is the endpoint's own;
// and the `field` paths a page can read.
// @effect-diagnostics preferEffectRecord:off preferEffectArray:off preferTypedSchemaDecoder:off schemaSync:off missedPipeableOpportunity:off
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "./mcp-api.ts";
import {
  EnvironmentField,
  HARNESS_TOOL_NAMES,
  HARNESS_TOOLS,
  SettingsField,
} from "./harness-tools/index.ts";

/** Every declaration's schemas, by tool and surface: its input and its output. */
const SCHEMAS = Arr.flatMap(HARNESS_TOOL_NAMES, (name) =>
  Arr.flatMap(["session", "endpoint"] as const, (surface) => [
    { name, surface, kind: "input", schema: HARNESS_TOOLS[name][surface].input },
    { name, surface, kind: "output", schema: HARNESS_TOOLS[name][surface].output },
  ]),
);

/** `schema`'s JSON Schema, as MCP shows it to a client. */
const jsonSchemaOf = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema;

describe("the harness tools' declarations", () => {
  it("are all read-only", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      expect(HARNESS_TOOLS[name].annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
  });

  it("name their tools in snake_case, none of them one of the endpoint's own", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(Arr.some(MCP_TOOL_NAMES, (each: string) => each === name)).toBe(false);
    }
  });

  it("have an output schema whose root is an object, with no root anyOf or oneOf, on both surfaces (L12)", () => {
    const outputs = Arr.filter(SCHEMAS, ({ kind }) => kind === "output");

    expect(outputs).toHaveLength(HARNESS_TOOL_NAMES.length * 2);

    for (const { name, surface, schema } of outputs) {
      const root = jsonSchemaOf(schema);

      expect(root, `${name} (${surface})`).toMatchObject({ type: "object" });
      expect(root, `${name} (${surface})`).not.toHaveProperty("anyOf");
      expect(root, `${name} (${surface})`).not.toHaveProperty("oneOf");
    }
  });

  it("hold no definitions, so a tool can declare one schema for them", () => {
    for (const { name, surface, schema } of SCHEMAS) {
      expect(
        Object.keys(Schema.toJsonSchemaDocument(schema).definitions),
        `${name} (${surface})`,
      ).toEqual([]);
    }
  });
});

describe("the `field` of environment_get", () => {
  const decode = Schema.decodeUnknownOption(EnvironmentField);

  it.each(["setupScript", "ignore", "variables.API_URL"])("accepts %s", (field) => {
    expect(decode(field)._tag).toBe("Some");
  });

  it.each([
    "instructions",
    "variables.",
    "variables.1ABC",
    "variables.A.B",
    "setupScript\n",
    "../setupScript",
  ])("rejects %j", (field) => {
    expect(decode(field)._tag).toBe("None");
  });
});

describe("the `field` of settings_get", () => {
  const decode = Schema.decodeUnknownOption(SettingsField);

  it("accepts instructions only", () => {
    expect(decode("instructions")._tag).toBe("Some");

    for (const field of ["", "Instructions", "model", "setupScript", "instructions "]) {
      expect(decode(field)._tag).toBe("None");
    }
  });
});
