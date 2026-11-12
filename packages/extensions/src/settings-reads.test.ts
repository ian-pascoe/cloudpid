// The core of `settings_get` on the endpoint surface (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools
// → Reading a whole field, and the endpoint's limits): no Environment marked a Session's own, the value and the text inside
// their limits, `field: "instructions"` pages (a Scope's own text only), and the codes of what is refused. What the
// Session's surface answers is pinned by `harness-session.test.ts`.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalJsonInEffect:off missedPipeableOpportunity:off preferTypedSchemaDecoder:off schemaSync:off schemaSyncInEffect:off
import { DEFAULT_SETTINGS, type Settings } from "@cloudpid/config";
import {
  ENDPOINT_STRUCTURED_BYTES,
  ENDPOINT_CORE_TEXT_CHARS,
  GLOBAL_SETTINGS_SCOPE,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
  SettingsGetEndpointOutput,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SettingsAccessError, type SettingsView } from "./settings.ts";
import { settingsGetRead, type SettingsReadServices } from "./settings-reads.ts";
import { storedBytes } from "./stored-bytes.ts";

/** 64 KiB of ASCII, the most Instructions may be (`MAX_INSTRUCTIONS_BYTES`). */
const SIXTY_FOUR_KIB = `${"Prefer small commits.\n".repeat(2_900)}${"x".repeat(65_536 - 22 * 2_900)}`;

const GLOBAL_INSTRUCTIONS = "Prefer small commits.";

/** The services over Global and Environments `api` (whose own Instructions are `own`) and `big`. */
const servicesOf = (
  own: { readonly api: string; readonly big: string },
  global: string = GLOBAL_INSTRUCTIONS,
  settings: Partial<Settings> = {},
): SettingsReadServices => {
  const kept: Settings = { ...DEFAULT_SETTINGS, instructions: global, ...settings };

  return {
    own: Effect.succeed("api"),
    get: (scope) =>
      Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
        if (scope === GLOBAL_SETTINGS_SCOPE) {
          return Effect.succeed({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings: kept,
            overrides: {},
            overriddenIn: { model: [{ id: "api", name: "Api" }] },
            mcpServers: 1,
          });
        }

        if (scope !== "api" && scope !== "big") {
          return Effect.fail(
            SettingsAccessError.make({
              message: `No Environment has the id ${JSON.stringify(scope)}.`,
              code: "not_found",
            }),
          );
        }

        return Effect.succeed({
          scope,
          name: scope === "api" ? "Api" : "Big",
          settings: kept,
          overrides: {},
          global: kept,
          instructions: own[scope],
          mcpServers: 2,
        });
      }),
  };
};

const getEndpoint = (
  services: SettingsReadServices,
  args: { scope: string; field?: string; offset?: number },
) =>
  settingsGetRead(services)(
    // SAFETY: the tests pass `field` as the tool takes it, or a value the core must refuse itself.
    args as never,
    "endpoint",
  );

const decoded = (structured: JsonValue) =>
  Schema.decodeUnknownSync(SettingsGetEndpointOutput)(structured);

describe("settings_get on the endpoint", () => {
  it("answers the Settings at Global and at an Environment with no mark of a Session's own", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = servicesOf({ api: "Run the tests with bun.", big: "" });

        const global = yield* getEndpoint(services, { scope: "*" });
        const environment = yield* getEndpoint(services, { scope: "api" });

        for (const answer of [global, environment]) {
          expect(JSON.stringify(answer.structured)).not.toContain("own_environment");
          expect(JSON.stringify(answer.structured)).not.toContain("is_own");
          expect(answer.text).not.toContain("This Session");
          expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
          expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_CORE_TEXT_CHARS);
        }

        expect(decoded(global.structured)).toMatchObject({
          scope: { id: "*", name: "Global" },
          mcp_servers: 1,
          problem: null,
        });

        expect(decoded(global.structured).settings?.[0]).toMatchObject({
          field: "model",
          overridden_in: [{ id: "api" }],
        });
        expect(decoded(environment.structured)).toMatchObject({
          scope: { id: "api", name: "Api" },
        });
        expect(decoded(environment.structured).instructions?.environment).toMatchObject({
          text: "Run the tests with bun.",
          bytes: 23,
        });
        expect(environment.text).toContain('Pass field "instructions"');
      }),
    ));

  it("cuts Instructions that are too long, flagged, and says to pass field", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf({ api: SIXTY_FOUR_KIB, big: "" }, SIXTY_FOUR_KIB),
          { scope: "api" },
        );

        const value = decoded(answer.structured);

        expect(value.instructions?.global.text_truncated).toBe(true);
        expect(value.instructions?.global.bytes).toBe(65_536);
        expect(value.instructions?.environment?.text_truncated).toBe(true);
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_CORE_TEXT_CHARS);
        expect(answer.text).toContain('Pass field "instructions"');
      }),
    ));

  it("is held to both limits by a setting too long to show", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const long = "b".repeat(20_000);

        const answer = yield* getEndpoint(
          servicesOf({ api: "", big: "" }, "", {
            extensions: { big: { blob: long, other: long } },
          }),
          { scope: "api" },
        );

        const value = decoded(answer.structured);

        const blob = Option.getOrNull(
          Arr.findFirst(value.settings ?? [], (setting) => setting.field === "extensions.big.blob"),
        );

        expect(blob).toMatchObject({ value: null, value_truncated: true });
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text).toContain("too long to show");
      }),
    ));
});

describe("a page of the Instructions", () => {
  it("brings 64 KiB of ASCII Instructions in two pages, the second without next_offset", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = servicesOf({ api: SIXTY_FOUR_KIB, big: "" });

        const first = yield* getEndpoint(services, { scope: "api", field: "instructions" });
        const one = decoded(first.structured);

        expect(one).toMatchObject({
          id: "api",
          field: "instructions",
          offset: 0,
          total_chars: 65_536,
          next_offset: 40_000,
        });
        expect(one.text?.length).toBe(MAX_PAGE_CHARS);

        const second = yield* getEndpoint(services, {
          scope: "api",
          field: "instructions",
          offset: 40_000,
        });

        const two = decoded(second.structured);

        expect(two).toMatchObject({ offset: 40_000, total_chars: 65_536 });
        expect(two.text?.length).toBe(25_536);
        expect(two).not.toHaveProperty("next_offset");
        expect(`${one.text}${two.text}`).toBe(SIXTY_FOUR_KIB);

        for (const answer of [first, second]) {
          expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
          expect(storedBytes(decoded(answer.structured).text ?? "")).toBeLessThanOrEqual(
            MAX_PAGE_BYTES,
          );
          // The page's text is whole in the content text, which `Tool.maxText` keeps from the 12,000 cut.
          expect(answer.text).toContain(decoded(answer.structured).text ?? "");
        }
      }),
    ));

  it("reads an Environment's own Instructions only, and Global's through scope *", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = servicesOf(
          { api: "Run the tests with bun.", big: "" },
          "Prefer small commits.",
        );

        const own = decoded(
          (yield* getEndpoint(services, { scope: "api", field: "instructions" })).structured,
        );

        const global = decoded(
          (yield* getEndpoint(services, { scope: "*", field: "instructions" })).structured,
        );

        expect(own).toMatchObject({ id: "api", text: "Run the tests with bun." });
        expect(global).toMatchObject({ id: "*", text: "Prefer small commits." });
      }),
    ));

  it("holds a page to 48 KiB stored and never splits a surrogate pair", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const text = `a${"🙂".repeat(30_000)}`;
        const services = servicesOf({ api: text, big: "" });

        const page = decoded(
          (yield* getEndpoint(services, { scope: "api", field: "instructions" })).structured,
        );

        expect(storedBytes(page.text ?? "")).toBeLessThanOrEqual(MAX_PAGE_BYTES);
        expect((page.text ?? "").isWellFormed()).toBe(true);
        expect(page.next_offset).toBe((page.text ?? "").length);
        expect(text.slice(0, page.next_offset).isWellFormed()).toBe(true);
      }),
    ));
});

describe("what settings_get refuses on the endpoint", () => {
  const services = servicesOf({ api: "Run the tests with bun.", big: "" });

  it("answers not_found, from the service, for a Scope that names no Environment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(getEndpoint(services, { scope: "nope" }));

        expect(error.code).toBe("not_found");
        expect(error.message).toContain('No Environment has the id "nope"');
      }),
    ));

  it("answers invalid_argument for an offset past the end, and an offset without field", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const past = yield* Effect.flip(
          getEndpoint(services, { scope: "api", field: "instructions", offset: 24 }),
        );

        const alone = yield* Effect.flip(getEndpoint(services, { scope: "api", offset: 0 }));

        expect(past.code).toBe("invalid_argument");
        expect(past.message).toContain("past the end of the Instructions, which are 23 characters");
        expect(alone.code).toBe("invalid_argument");
      }),
    ));
});
