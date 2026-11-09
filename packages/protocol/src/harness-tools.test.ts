// The declarations of the harness tools (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared
// definitions, Names and surfaces): on both surfaces, every tool holds no definitions and its output schema has the shape
// the endpoint needs on both MCP lanes (L12); a read is read-only and a write takes `request_id` on the endpoint only; the
// names are snake_case and none is the endpoint's own; and the `field` paths a page can read. The endpoint-only
// declarations (the tools that ask for the owner's Approval, and `approval_wait`/`approval_withdraw`) have no session part.
// @effect-diagnostics preferEffectRecord:off preferEffectArray:off preferTypedSchemaDecoder:off schemaSync:off missedPipeableOpportunity:off
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "./mcp-api.ts";
import {
  EnvironmentField,
  HARNESS_TOOL_NAMES,
  HARNESS_TOOLS,
  isApprovalFollowTool,
  SettingsField,
} from "./harness-tools/index.ts";

/** One surface of a declaration: which, and its input and output schemas. */
type DeclaredSurface = {
  readonly surface: "session" | "endpoint";
  readonly input: Schema.Top;
  readonly output: Schema.Top;
};

/** A declaration's surfaces: the endpoint's, and the Session's where it has one. */
const surfacesOf = (name: (typeof HARNESS_TOOL_NAMES)[number]): ReadonlyArray<DeclaredSurface> => {
  const tool: (typeof HARNESS_TOOLS)[typeof name] = HARNESS_TOOLS[name];
  const endpoint = { surface: "endpoint" as const, ...tool.endpoint };

  return "session" in tool
    ? [{ surface: "session" as const, ...tool.session }, endpoint]
    : [endpoint];
};

/** Every declaration's schemas, by tool and surface: its input and its output. */
const SCHEMAS = Arr.flatMap(HARNESS_TOOL_NAMES, (name) =>
  Arr.flatMap(surfacesOf(name), ({ surface, input, output }) => [
    { name, surface, kind: "input", schema: input },
    { name, surface, kind: "output", schema: output },
  ]),
);

/** The writes that are no Agent change, so they take no `request_id` and have no replayed answer. */
const NO_REQUEST_ID: ReadonlyArray<string> = ["settings_mcp_reload"];

/**
 * The tools the endpoint does not serve yet: no endpoint text names them (the stages that serve them take them out, as
 * S3a-2 did the Limit tools and `settings_instructions_set`, and S3b-2 the MCP servers' definition tools).
 */
const UNSERVED_TOOLS = ["tool_search", "container_restart", "secret_ask"];

/** `schema`'s JSON Schema, as MCP shows it to a client. */
const jsonSchemaOf = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema;

/** The property names of an object schema's JSON Schema; none for an empty struct. */
const propertyNames = (schema: Schema.Top): ReadonlyArray<string> =>
  Object.keys(
    Schema.decodeUnknownSync(
      Schema.Struct({
        properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      }),
    )(jsonSchemaOf(schema)).properties ?? {},
  );

describe("the harness tools' declarations", () => {
  it("give a read no request_id, and a write one on the endpoint only, beside the Session's own keys", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      const tool = HARNESS_TOOLS[name];
      const endpoint = propertyNames(tool.endpoint.input);

      // `approval_withdraw` changes no Agent change: it takes no `request_id` (a repeat is safe as it is).
      if (isApprovalFollowTool(name)) {
        expect(endpoint, name).not.toContain("request_id");
        continue;
      }

      if (!("session" in tool)) {
        // An asking tool: a write, with `request_id`, whose answer is a request, never a replayed change.
        expect(endpoint, name).toContain("request_id");
        continue;
      }

      const session = propertyNames(tool.session.input);

      expect(session, name).not.toContain("request_id");

      if (tool.annotations.readOnlyHint || NO_REQUEST_ID.includes(name)) {
        expect(endpoint, name).not.toContain("request_id");

        if (NO_REQUEST_ID.includes(name)) {
          // Its endpoint input is the Session's.
          expect(endpoint, name).toEqual(session);
          expect(propertyNames(tool.endpoint.output), name).not.toContain("replayed");
        }
      } else {
        expect(endpoint, name).toContain("request_id");
        expect(jsonSchemaOf(tool.endpoint.input), name).not.toMatchObject({
          required: expect.arrayContaining(["request_id"]),
        });
        expect(
          Arr.filter(endpoint, (key) => key !== "request_id"),
          name,
        ).toEqual(session);
        // A replayed answer is the endpoint's only; a Session's answer never is one.
        expect(propertyNames(tool.endpoint.output), name).toContain("replayed");
        expect(propertyNames(tool.session.output), name).not.toContain("replayed");
      }
    }
  });

  // The endpoint has an owner and no user (`mcp-endpoint.md` → Names and surfaces): its words are the contract here.
  it("name the owner, never the user, in a change tool's endpoint description and input", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      const tool = HARNESS_TOOLS[name];

      if (tool.annotations.readOnlyHint) continue;

      const shown = `${tool.endpoint.description}\n${JSON.stringify(jsonSchemaOf(tool.endpoint.input))}`;

      expect(shown, name).not.toMatch(/\buser\b/);
    }
  });

  it("name no tool the endpoint does not serve in a change tool's endpoint description and input", () => {
    for (const name of HARNESS_TOOL_NAMES) {
      const tool = HARNESS_TOOLS[name];

      if (tool.annotations.readOnlyHint) continue;

      const shown = `${tool.endpoint.description}\n${JSON.stringify(jsonSchemaOf(tool.endpoint.input))}`;

      for (const unserved of UNSERVED_TOOLS) {
        expect(shown, `${name} names ${unserved}`).not.toContain(unserved);
      }
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

    expect(outputs).toHaveLength(
      Arr.reduce(HARNESS_TOOL_NAMES, 0, (n, name) => n + surfacesOf(name).length),
    );

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

describe("the tools that ask only when they widen", () => {
  // What the dispatcher answers when it asked the owner: a change's keys with none made, and the request's.
  const PENDING = {
    status: "pending",
    approval_id: "a-1",
    url: "https://cloudpid.test/settings/all/mcp?request=a-1",
    expires_at: "2026-11-16T00:00:00.000Z",
    scope: { id: "*", name: "Global" },
    changes: [],
    changes_truncated: false,
    unchanged: [],
  };

  it.each([
    "settings_mcp_exposure_set",
    "settings_mcp_tool_exposure_set",
    "settings_mcp_remove",
  ] as const)("%s has a pending answer in its endpoint output", (name) => {
    expect(() =>
      Schema.decodeUnknownSync(HARNESS_TOOLS[name].endpoint.output)(PENDING),
    ).not.toThrow();
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
