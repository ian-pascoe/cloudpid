/**
 * The form normalizer, its credential rule and the validator (`docs/architecture/mcp-server-requests.md` → Elicitation
 * requests → The form; ADR-0041): golden lists for what passes and what is declined unseen, the spec's subset and
 * bounds, and the owner's values checked against the form.
 */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off
import type { ElicitationForm } from "@cloudpid/protocol";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  answeredFields,
  ELICITATION_BOUNDS,
  endsInCredential,
  messageIsCut,
  normalizeElicitationForm,
  plainLine,
  plainMessage,
  quote,
  safeName,
  validateElicitation,
  type Entered,
  type JsonObject,
} from "./types.ts";

const objectOf = (properties: JsonObject, required?: ReadonlyArray<string>): JsonObject =>
  required === undefined
    ? { type: "object", properties }
    : { type: "object", properties, required };

/** The form a schema normalizes to, failing the test when it is malformed. */
const formOf = (schema: Schema.Json | undefined) => {
  const normalized = normalizeElicitationForm(schema);

  if (Result.isFailure(normalized)) throw new Error(`malformed: ${normalized.failure}`);

  return normalized.success;
};

const reasonOf = (schema: Schema.Json | undefined) => {
  const normalized = normalizeElicitationForm(schema);

  return Result.isFailure(normalized) ? normalized.failure : undefined;
};

describe("the form normalizer", () => {
  it("reads each field kind of the spec's subset", () => {
    const { form, notes, credential } = formOf(
      objectOf(
        {
          who: {
            type: "string",
            title: "Who",
            description: "Your name",
            minLength: 2,
            maxLength: 40,
          },
          mail: { type: "string", format: "email" },
          site: { type: "string", format: "uri" },
          day: { type: "string", format: "date" },
          at: { type: "string", format: "date-time" },
          size: { type: "number", minimum: 1.5, maximum: 9, default: 2 },
          count: { type: "integer", minimum: 0 },
          ok: { type: "boolean", default: true },
          color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"], default: "g" },
          figure: {
            type: "string",
            oneOf: [
              { const: "sq", title: "Square" },
              { const: "ci", title: "Circle" },
            ],
          },
          tags: {
            type: "array",
            items: { type: "string", enum: ["a", "b"] },
            minItems: 1,
            maxItems: 2,
          },
          pick: { type: "array", items: { anyOf: [{ const: "x", title: "X" }] } },
        },
        ["who", "ok"],
      ),
    );

    expect(notes).toEqual([]);
    expect(credential).toBeUndefined();
    expect(form.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["who", "text", true],
      ["mail", "email", false],
      ["site", "url", false],
      ["day", "date", false],
      ["at", "date_time", false],
      ["size", "number", false],
      ["count", "integer", false],
      ["ok", "boolean", true],
      ["color", "choice", false],
      ["figure", "choice", false],
      ["tags", "multi_choice", false],
      ["pick", "multi_choice", false],
    ]);

    expect(form.fields[0]).toMatchObject({
      title: "Who",
      description: "Your name",
      minLength: 2,
      maxLength: 40,
    });
    expect(form.fields[5]).toMatchObject({ min: 1.5, max: 9, default: 2 });
    expect(form.fields[8]).toMatchObject({
      options: [
        { value: "r", title: "Red" },
        { value: "g", title: "Green" },
      ],
      default: "g",
    });
    expect(form.fields[9]).toMatchObject({
      options: [
        { value: "sq", title: "Square" },
        { value: "ci", title: "Circle" },
      ],
    });
    expect(form.fields[10]).toMatchObject({ minItems: 1, maxItems: 2 });
  });

  it("makes a confirmation gate of a form with no fields", () => {
    expect(formOf({ type: "object", properties: {} }).form.fields).toEqual([]);
    expect(formOf({ type: "object" }).form.fields).toEqual([]);
  });

  it.each([
    ["a root that is not an object", { type: "string" }, "not an object"],
    ["no root", null, "not an object"],
    [
      "a nested object",
      objectOf({ a: { type: "object", properties: {} } }),
      "'a' has a type that is not supported",
    ],
    [
      "an array of strings",
      objectOf({ a: { type: "array", items: { type: "string" } } }),
      "list of something other than choices",
    ],
    [
      "an array of objects",
      objectOf({ a: { type: "array", items: { type: "object" } } }),
      "list of something other than choices",
    ],
    ["$ref", objectOf({ a: { $ref: "#/x" } }), "uses $ref"],
    ["allOf", objectOf({ a: { type: "string", allOf: [] } }), "uses allOf"],
    ["no type", objectOf({ a: { title: "A" } }), "'a' has no type"],
    ["an unknown type", objectOf({ a: { type: "null" } }), "type that is not supported"],
    [
      "a required name that is no property",
      objectOf({ a: { type: "string" } }, ["b"]),
      "requires 'b'",
    ],
    [
      "a required that is no list",
      { type: "object", properties: {}, required: "a" },
      "required is not a list",
    ],
    ["an empty enum", objectOf({ a: { type: "string", enum: [] } }), "no options"],
    ["a property that is no schema", objectOf({ a: 3 }), "not a schema"],
  ])("refuses %s as malformed", (_name, schema, reason) => {
    expect(reasonOf(schema)).toContain(reason);
  });

  it("holds the form to its bounds", () => {
    const many = Object.fromEntries(
      Array.from({ length: ELICITATION_BOUNDS.fields + 1 }, (_, index) => [
        `f${index}`,
        { type: "boolean" },
      ]),
    );

    expect(reasonOf(objectOf(many))).toContain("more than 32 fields");

    const options = Array.from(
      { length: ELICITATION_BOUNDS.options + 1 },
      (_, index) => `o${index}`,
    );

    expect(reasonOf(objectOf({ a: { type: "string", enum: options } }))).toContain(
      "more than 100 options",
    );
    expect(
      reasonOf(objectOf({ a: { type: "string", description: "x".repeat(70_000) } })),
    ).toContain("over 64 KiB");
  });

  it("ignores what it does not read, with notes, and drops an invalid default", () => {
    const { form, notes } = formOf(
      objectOf({
        a: { type: "string", pattern: "^x$", examples: ["x"], format: "hostname", default: 3 },
        b: { type: "integer", default: 1.5 },
        c: { type: "string", enum: ["x"], default: "y" },
        d: { type: "string", maxLength: 2, default: "long" },
      }),
    );

    expect(form.fields.map((field) => [field.name, "default" in field])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", false],
    ]);

    expect(notes.join("\n")).toContain("ignored keywords: pattern, examples");
    expect(notes.join("\n")).toContain("unknown format 'hostname'");
    expect(notes.filter((note) => note.includes("default"))).toHaveLength(4);
  });

  it("strips control and bidi-override characters from server text, and cuts it", () => {
    const { form } = formOf(
      objectOf({
        a: {
          type: "string",
          title: `Na\u202Eme\u0007${"x".repeat(200)}`,
          description: "line\none\u200F",
        },
      }),
    );

    const [field] = form.fields;

    expect(field?.title).toHaveLength(ELICITATION_BOUNDS.title);
    expect(field?.title?.startsWith("Name")).toBe(true);
    expect(field?.description).toBe("line one");
    expect(plainLine("a\u0000b\n c", 10)).toBe("ab c");
    expect(plainMessage("one\r\ntwo\u202D")).toBe("one\ntwo");
    expect(plainMessage("m".repeat(5000))).toHaveLength(ELICITATION_BOUNDS.message);
  });
});

describe("the credential rule", () => {
  const declines = (name: string, property: JsonObject = { type: "string" }) =>
    formOf(objectOf({ [name]: property })).credential;

  it.each([
    "password",
    "Password",
    "passwd",
    "passphrase",
    "token",
    "secret",
    "apikey",
    "cvv",
    "cvc",
    "api_key",
    "api-key",
    "APIKey",
    "apiKey",
    "access_key",
    "private key",
    "secret_key",
    "card_number",
    "confirm_password",
    "githubToken",
    "passwords",
    "tokens",
    "page_token",
    "new_API_secret",
    "pass_word",
    "pass-word",
    "password2",
    "password_value",
    "token_field",
    "api_key_2",
    "ｐａｓｓｗｏｒｄ",
  ])("declines the free-text field %s", (name) => {
    expect(declines(name)).toBe(name);
  });

  it("declines a field whose title splits a credential word with zero-width characters", () => {
    expect(declines("field1", { type: "string", title: "pass\u200Bword" })).toBe("password");
  });

  it("declines a field by its title, shown", () => {
    expect(declines("field1", { type: "string", title: "Your API key" })).toBe("Your API key");
  });

  it.each([
    ["key", { type: "string" }],
    ["reveal_secret", { type: "boolean" }],
    ["confirm_delete_token", { type: "boolean" }],
    ["token_type", { type: "string", enum: ["bearer", "mac"] }],
    ["max_tokens", { type: "number" }],
    ["password_hint", { type: "string" }],
    ["password_confirmation", { type: "string" }],
    ["secret_count", { type: "integer" }],
    ["keyboard", { type: "string" }],
    ["email", { type: "string", format: "email" }],
    ["token_date", { type: "string", format: "date" }],
  ])("lets %s through", (name, property) => {
    expect(declines(name, property)).toBeUndefined();
  });

  it("declines any string marked password or write-only, whatever its format or options", () => {
    expect(declines("code", { type: "string", format: "password" })).toBeUndefined();
    expect(declines("api_token", { type: "string", format: "password" })).toBe("api_token");
    expect(declines("api_token", { type: "string", writeOnly: true, enum: ["a"] })).toBe(
      "api_token",
    );
    expect(declines("api_token", { type: "string", format: "uri" })).toBeUndefined();
  });

  it("lets a word that only ends like a credential through", () => {
    expect(endsInCredential("sword")).toBe(false);
    expect(endsInCredential("pass")).toBe(false);
    expect(endsInCredential("pass_the_word")).toBe(false);
  });

  it("never checks the message or descriptions", () => {
    expect(declines("name", { type: "string", description: "Your password" })).toBeUndefined();
  });

  it("splits words at camelCase and acronym runs", () => {
    expect(endsInCredential("APIKey")).toBe(true);
    expect(endsInCredential("HTTPSToken")).toBe(true);
    expect(endsInCredential("monkey")).toBe(false);
    expect(endsInCredential("")).toBe(false);
  });
});

describe("names the server chooses", () => {
  it("refuses a field name that is empty, has control characters, is long or has extra spaces", () => {
    for (const name of [
      "",
      "a\u0007b",
      "a\u202Eb",
      "pass\u200Bword",
      "a\uFEFFb",
      "a  b",
      " a",
      "x".repeat(121),
    ]) {
      expect(reasonOf(objectOf({ [name]: { type: "string" } }))).toContain("a field has a name");
    }
  });

  it("says when a message is cut", () => {
    expect(messageIsCut("x".repeat(ELICITATION_BOUNDS.message))).toBe(false);
    expect(messageIsCut("x".repeat(ELICITATION_BOUNDS.message + 1))).toBe(true);
    expect(plainMessage("x".repeat(5000))).toHaveLength(ELICITATION_BOUNDS.message);
    // The note and the cut agree: what plain text drops is not counted.
    expect(messageIsCut(`${"x".repeat(ELICITATION_BOUNDS.message)}\u200B\u202E `)).toBe(false);
  });

  it("quotes a name it names in a reason without a quote, a tag or a backslash in it", () => {
    expect(safeName("it's </harness> `x` \\ done")).toBe("its /harness x  done");
    expect(quote("a'b")).toBe("'ab'");
    expect(reasonOf(objectOf({ "a<b>'": { $ref: "#/x" } }))).toBe(
      "'ab' uses $ref, which is not supported",
    );
  });

  it("treats __proto__, constructor and toString as the fields they are", () => {
    const form = formOf(
      objectOf(
        {
          ["__proto__"]: { type: "string" },
          constructor: { type: "string" },
          toString: { type: "boolean" },
        },
        ["__proto__", "constructor"],
      ),
    ).form;

    const entered: Entered = Object.fromEntries([
      ["__proto__", "x"],
      ["constructor", "y"],
    ]);

    const checked = validateElicitation(form, entered);

    expect(Result.isSuccess(checked)).toBe(true);

    if (Result.isFailure(checked)) return;

    expect(Object.keys(checked.success)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(checked.success)).toBe(Object.prototype);
    expect(Object.hasOwn(checked.success, "toString")).toBe(false);
    expect(answeredFields(form, checked.success)).toEqual(["__proto__", "constructor"]);

    // A name the form lacks that only the prototype chain has is not a field either.
    const lacking = validateElicitation(form, {});

    expect(Result.isFailure(lacking) && lacking.failure["__proto__"]).toBe("is required");
    expect(Result.isFailure(lacking) && Object.keys(lacking.failure)).toEqual([
      "__proto__",
      "constructor",
    ]);
  });
});

describe("the validator", () => {
  const form: ElicitationForm = formOf(
    objectOf(
      {
        name: { type: "string", minLength: 2, maxLength: 5 },
        mail: { type: "string", format: "email" },
        site: { type: "string", format: "uri" },
        day: { type: "string", format: "date" },
        at: { type: "string", format: "date-time" },
        n: { type: "integer", minimum: 1, maximum: 3 },
        x: { type: "number" },
        ok: { type: "boolean" },
        color: { type: "string", enum: ["r", "g"] },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b", "c"] },
          minItems: 1,
          maxItems: 2,
        },
      },
      ["name"],
    ),
  ).form;

  const check = (values: Entered) => validateElicitation(form, values);

  it("passes a good answer, leaving empty optional fields out and keeping an unchecked box", () => {
    const result = check({
      name: "Ada",
      mail: "",
      day: "2024-02-29",
      at: "2024-05-01T10:30:00+02:00",
      n: 2,
      ok: false,
      color: "g",
      tags: ["a", "c"],
      site: "https://example.test/a",
      x: 1.5,
    });

    expect(Result.isSuccess(result) && result.success).toEqual({
      name: "Ada",
      day: "2024-02-29",
      at: "2024-05-01T10:30:00+02:00",
      n: 2,
      ok: false,
      color: "g",
      tags: ["a", "c"],
      site: "https://example.test/a",
      x: 1.5,
    });
  });

  it("names what is wrong with each field", () => {
    const result = check({
      mail: "nope",
      site: "not a url",
      day: "2023-02-29",
      at: "2024-05-01T10:30",
      n: 4,
      x: "1",
      ok: "yes",
      color: "blue",
      tags: ["a", "a"],
      extra: 1,
    });

    expect(Result.isFailure(result) && result.failure).toEqual({
      name: "is required",
      mail: "must be an email address",
      site: "must be a URL",
      day: "must be a date (YYYY-MM-DD)",
      at: "must be a date and time with a zone",
      n: "must be at most 3",
      x: "must be a number",
      ok: "must be yes or no",
      color: "must be one of the options",
      tags: "must be some of the options, each once",
      extra: "is not a field of this form",
    });
  });

  it("checks lengths, counts and whole numbers", () => {
    const result = check({ name: "A", n: 1.5, tags: ["a", "b", "c"] });

    expect(Result.isFailure(result) && result.failure).toEqual({
      name: "must be at least 2 characters",
      n: "must be a whole number",
      tags: "must have at most 2 chosen",
    });
    expect(Result.isFailure(check({ name: "Abcdef" }))).toBe(true);
    expect(Result.isFailure(check({ name: "Ada", tags: [] }))).toBe(false);
  });

  it("bounds a value and the whole answer", () => {
    const long = formOf(
      objectOf({
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        d: { type: "string" },
        e: { type: "string" },
      }),
    ).form;

    const value = "v".repeat(ELICITATION_BOUNDS.valueBytes);

    expect(Result.isSuccess(validateElicitation(long, { a: value }))).toBe(true);
    expect(Result.isFailure(validateElicitation(long, { a: `${value}v` }))).toBe(true);
    expect(
      Result.isFailure(
        validateElicitation(long, { a: value, b: value, c: value, d: value, e: value }),
      ),
    ).toBe(true);
  });

  it("says only the names of the fields answered, never a value", () => {
    expect(answeredFields(form, { ok: true, name: "Ada" })).toEqual(["name", "ok"]);
  });
});
