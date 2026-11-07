// The declarations of the harness tools (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared
// definitions, Names and surfaces): the five reads for both surfaces, the shape the endpoint's output schemas must have on
// both MCP lanes (L12), the names, and the `field` paths a page can read.
// @effect-diagnostics preferEffectRecord:off preferEffectArray:off preferTypedSchemaDecoder:off schemaSync:off missedPipeableOpportunity:off
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "./mcp-api.ts";
import {
  ENVIRONMENT_FIELD_PATTERN,
  EnvironmentField,
  GLOBAL_ID,
  GLOBAL_NAME,
  GLOBAL_SETTINGS_SCOPE,
  HARNESS_TOOL_NAMES,
  HARNESS_TOOLS,
  idOrGlobal,
  PageOffset,
  READ_ONLY,
  ScopeRef,
  SettingsField,
  SettingsScope,
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

/** The names of the properties of an object schema's JSON Schema. */
const propertyNames = (schema: Schema.Top): ReadonlyArray<string> =>
  Object.keys(
    Schema.decodeUnknownSync(
      Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }),
    )(jsonSchemaOf(schema)).properties,
  );

describe("the harness tools' declarations", () => {
  it("are the five reads, for both surfaces, each read-only", () => {
    expect(HARNESS_TOOL_NAMES).toEqual([
      "environment_list",
      "environment_get",
      "settings_get",
      "settings_mcp_list",
      "settings_mcp_get",
    ]);

    for (const name of HARNESS_TOOL_NAMES) {
      const tool = HARNESS_TOOLS[name];

      expect(tool.name).toBe(name);
      expect(tool.annotations).toEqual(READ_ONLY);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.session.description.length).toBeGreaterThan(0);
      expect(tool.endpoint.description.length).toBeGreaterThan(0);
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

  it("give the endpoint no mark of a Session's own Environment, and the Session's no page", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      const endpoint = propertyNames(HARNESS_TOOLS[name].endpoint.output);
      const session = propertyNames(HARNESS_TOOLS[name].session.output);

      for (const own of ["current", "own_environment", "is_own"]) {
        expect(endpoint).not.toContain(own);
      }

      expect(session).not.toContain("next_offset");
    }

    expect(propertyNames(HARNESS_TOOLS.environment_get.endpoint.output)).toEqual(
      expect.arrayContaining(["id", "field", "text", "offset", "total_chars", "next_offset"]),
    );
  });

  it("take field and offset on the endpoint only, for environment_get and settings_get", () => {
    expect(propertyNames(HARNESS_TOOLS.environment_get.endpoint.input)).toEqual([
      "id",
      "field",
      "offset",
    ]);

    expect(propertyNames(HARNESS_TOOLS.environment_get.session.input)).toEqual(["id"]);

    expect(propertyNames(HARNESS_TOOLS.settings_get.endpoint.input)).toEqual([
      "scope",
      "field",
      "offset",
    ]);

    expect(propertyNames(HARNESS_TOOLS.settings_get.session.input)).toEqual(["scope"]);
  });
});

describe("the `field` of environment_get", () => {
  const decode = Schema.decodeUnknownOption(EnvironmentField);

  it.each([
    "setupScript",
    "startScript",
    "toolchains",
    "ignore",
    "variables.API_URL",
    "variables._PRIVATE",
    "variables.a1",
  ])("accepts %s", (field) => {
    expect(ENVIRONMENT_FIELD_PATTERN.test(field)).toBe(true);
    expect(decode(field)._tag).toBe("Some");
  });

  it.each([
    "",
    "instructions",
    "model",
    "variables",
    "variables.",
    "variables.1ABC",
    "variables.A-B",
    "variables.A.B",
    "variables.A B",
    "setupScript ",
    "SetupScript",
    "setupScript\n",
    "ignore.0",
    "../setupScript",
  ])("rejects %j", (field) => {
    expect(ENVIRONMENT_FIELD_PATTERN.test(field)).toBe(false);
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

describe("the offset of a page", () => {
  const decode = Schema.decodeUnknownOption(PageOffset);

  it("is a whole number from 0", () => {
    expect(decode(0)._tag).toBe("Some");
    expect(decode(40_000)._tag).toBe("Some");
    expect(decode(-1)._tag).toBe("None");
    expect(decode(1.5)._tag).toBe("None");
  });
});

describe("the Scope a harness tool names", () => {
  it("is Global by `*`, in the Settings and in the Environments", () => {
    expect(GLOBAL_ID).toBe("*");
    expect(GLOBAL_NAME).toBe("Global");
    expect(GLOBAL_SETTINGS_SCOPE).toBe("*");
  });

  it("says where an Environment's id is found, and marks a Session's own only in the Session's words", () => {
    const description = (surface: "session" | "endpoint") =>
      jsonSchemaOf(idOrGlobal("what is kept Global", surface));

    expect(description("session")).toMatchObject({
      description: expect.stringContaining("environment_list marks this Session's own"),
    });

    expect(description("endpoint")).toMatchObject({
      description: expect.stringContaining('or "*" for what is kept Global'),
    });

    expect(JSON.stringify(description("endpoint"))).not.toContain("Session's own");
  });

  it("names an Environment, or Global, by id and name", () => {
    expect(Schema.decodeUnknownOption(ScopeRef)({ id: "*", name: "Global" })._tag).toBe("Some");
    expect(Schema.decodeUnknownOption(ScopeRef)({ id: "*" })._tag).toBe("None");
    expect(Schema.decodeUnknownOption(SettingsScope)("")._tag).toBe("None");
    expect(Schema.decodeUnknownOption(SettingsScope)("*")._tag).toBe("Some");
  });
});
