// The cores of `environment_list` and `environment_get` on the endpoint surface (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Reading a whole field, and the endpoint's limits): no Environment marked a Session's own,
// every variable in force listed with its value cut, the text and the structured value inside their limits, field pages,
// and the codes of what is refused. What the Session's surface answers is pinned by `harness-session.test.ts`.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalJsonInEffect:off missedPipeableOpportunity:off preferTypedSchemaDecoder:off schemaSync:off schemaSyncInEffect:off
import type { ContainerSettings } from "@cloudpid/config";
import {
  ENDPOINT_STRUCTURED_BYTES,
  ENDPOINT_TEXT_CHARS,
  EnvironmentGetEndpointOutput,
  EnvironmentListEndpointOutput,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { EnvironmentDetails } from "./environment.ts";
import {
  type EnvironmentReadServices,
  environmentGetRead,
  environmentListRead,
} from "./environment-reads.ts";
import { storedBytes } from "./stored-bytes.ts";

const CONTAINER: ContainerSettings = {
  instance: "cpu-1",
  maxInstance: "cpu-2",
  idleMinutes: 2,
  ignore: [],
  variables: {},
  setupScript: "",
  startScript: "",
  toolchains: "",
  spareWorkspace: false,
};

/** An Environment with `settings` over Global's, whose own variables are `own`. */
const environment = (
  id: string,
  settings: Partial<ContainerSettings> = {},
  more: Partial<EnvironmentDetails> = {},
): EnvironmentDetails => ({
  id,
  name: `Env ${id}`,
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  build: { status: "ready", at: 0 },
  overrides: {},
  settings: { ...CONTAINER, ...settings },
  global: CONTAINER,
  secrets: [],
  skills: [],
  globalSkills: [],
  ...more,
});

/** The services over `environments`, with `default` as the Session's own. */
const servicesOf = (
  environments: ReadonlyArray<EnvironmentDetails>,
  kept: ContainerSettings = CONTAINER,
): EnvironmentReadServices => ({
  current: Effect.succeed("default"),
  list: Effect.succeed(
    Arr.map(environments, ({ id, name, repos, build }) => ({ id, name, repos, build })),
  ),
  get: (id) =>
    Effect.succeed(Option.getOrNull(Arr.findFirst(environments, (each) => each.id === id))),
  global: Effect.succeed({ settings: kept, overriddenIn: {}, secrets: [], skills: [] }),
});

const getEndpoint = (
  services: EnvironmentReadServices,
  args: { id: string; field?: string; offset?: number },
) =>
  environmentGetRead(services)(
    // SAFETY: the tests pass `field` as the pattern's paths, or a path the core must refuse itself.
    args as never,
    "endpoint",
  );

/** The endpoint's value, decoded: a value of the wrong shape fails the test. */
const decoded = (structured: JsonValue) =>
  Schema.decodeUnknownSync(EnvironmentGetEndpointOutput)(structured);

describe("environment_list on the endpoint", () => {
  it("lists the Environments with none marked a Session's own", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* environmentListRead(
          servicesOf([environment("default"), environment("other")]),
        )({}, "endpoint");

        const value = Schema.decodeUnknownSync(EnvironmentListEndpointOutput)(answer.structured);

        expect(Arr.map(value.environments, ({ id }) => id)).toEqual(["default", "other"]);
        expect(JSON.stringify(answer.structured)).not.toContain("current");
        expect(answer.text).not.toContain("this Session's");
        expect(answer.text).toContain("default");
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
      }),
    ));

  it("cuts a list that is too long to its limits, flagged", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const many = Arr.makeBy(400, (index) =>
          environment(
            `env-${index}`,
            {},
            {
              repos: Arr.makeBy(20, (repo) => ({
                name: `repo-${repo}`,
                url: `https://github.com/o/repo-${repo}.git`,
              })),
            },
          ),
        );

        const answer = yield* environmentListRead(servicesOf(many))({}, "endpoint");
        const value = Schema.decodeUnknownSync(EnvironmentListEndpointOutput)(answer.structured);

        expect(value.environments_truncated).toBe(true);
        expect(value.environments.length).toBeLessThan(400);
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
      }),
    ));
});

describe("environment_get on the endpoint", () => {
  /** 50 variables whose values are as long as one may be. */
  const FIFTY = Object.fromEntries(
    Arr.makeBy(50, (index) => [
      `VAR_${String(index).padStart(2, "0")}`,
      `${index}`.padEnd(4_096, "v"),
    ]),
  );

  it("lists every variable in force, at most 50, each value cut near 160 bytes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf([
            environment("default", { variables: FIFTY }, { overrides: { variables: FIFTY } }),
          ]),
          { id: "default" },
        );

        const value = decoded(answer.structured);

        expect(value.variables).toHaveLength(50);
        expect(Arr.every(value.variables ?? [], (variable) => variable.value_truncated)).toBe(true);

        for (const variable of value.variables ?? []) {
          expect(storedBytes(variable.value)).toBeLessThanOrEqual(160);
          expect(storedBytes(variable.value)).toBeGreaterThan(100);
        }

        expect(value.variables_truncated).toBe(false);
        expect(answer.text).toContain('pass field "variables.VAR_00"');
        expect(answer.text).toContain("pass `field`");
      }),
    ));

  it("keeps a short variable whole, unflagged, and says whether it is the Environment's own or inherited", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf([
            environment(
              "default",
              { variables: { OWN: "1", SHARED: "2" } },
              {
                overrides: { variables: { OWN: "1" } },
                global: { ...CONTAINER, variables: { SHARED: "2" } },
              },
            ),
          ]),
          { id: "default" },
        );

        expect(decoded(answer.structured).variables).toEqual([
          {
            name: "OWN",
            value: "1",
            value_truncated: false,
            source: "own",
            overridden_in: [],
            overridden_in_truncated: false,
          },
          {
            name: "SHARED",
            value: "2",
            value_truncated: false,
            source: "inherited",
            overridden_in: [],
            overridden_in_truncated: false,
          },
        ]);

        expect(answer.text).toContain("OWN=1 (overridden here)");
        expect(answer.text).toContain("SHARED=2 (inherited from Global)");
        expect(answer.text).not.toContain("this Session");
      }),
    ));

  it("cuts a long script and says to pass field", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf([environment("default", { setupScript: "echo hello\n".repeat(5_000) })]),
          { id: "default" },
        );

        const value = decoded(answer.structured);

        expect(value.settings?.setup_script.value_truncated).toBe(true);
        expect(value.settings_truncated).toBe(true);
        expect(answer.text).toContain('pass field "setupScript"');
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
        expect(value.settings?.setup_script.value.length).toBeLessThan(5_000 * 11);
      }),
    ));

  it("stays inside both limits for an Environment as large as it can be, the worst case with control characters", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const control = '\u0001\n"\\'.repeat(30_000);

        const huge = environment(
          "default",
          {
            variables: FIFTY,
            setupScript: control,
            startScript: control,
            toolchains: control,
            ignore: Arr.makeBy(500, () => control.slice(0, 200)),
          },
          {
            overrides: { variables: FIFTY },
            problem: control,
            build: { status: "failed", at: 0, lastGoodAt: 0, reason: "\u0001".repeat(5_000) },
            repos: Arr.makeBy(200, (index) => ({
              name: `r${index}`,
              url: `https://github.com/o/${"x".repeat(100)}${index}.git`,
            })),
            secrets: Arr.makeBy(300, (index) => ({
              name: `SECRET_${index}`.padEnd(120, "S"),
              scope: "environment" as const,
              build: true,
            })),
            skills: Arr.makeBy(300, (index) => ({
              name: `skill-${index}`,
              description: control.slice(0, 500),
              savedAt: 0,
            })),
            globalSkills: Arr.makeBy(300, (index) => ({
              name: `global-${index}`,
              description: control.slice(0, 500),
              savedAt: 0,
            })),
          },
        );

        const answer = yield* getEndpoint(servicesOf([huge]), { id: "default" });

        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
        expect(decoded(answer.structured).skills_truncated).toBe(true);
        expect(answer.text).toContain("pass `field`");
      }),
    ));

  it("reads what is kept Global (id *) the same way", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf([], {
            ...CONTAINER,
            variables: { SHARED: "x".repeat(500) },
            startScript: "make",
          }),
          { id: "*" },
        );

        const value = decoded(answer.structured);

        expect(value.scope).toEqual({ id: "*", name: "Global" });
        expect(value.variables).toMatchObject([
          { name: "SHARED", value_truncated: true, source: "global" },
        ]);
        expect(value.build).toBeNull();
        expect(answer.text).toContain('Kept at Global (id "*")');
      }),
    ));
});

describe("a page of an Environment's field", () => {
  const SCRIPT = `${"a".repeat(99)}\n`.repeat(1_000);

  it("reads a long text in pages of at most 40,000 characters, each with next_offset until the last", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = servicesOf([environment("default", { setupScript: SCRIPT })]);
        const pages: Array<ReturnType<typeof decoded>> = [];
        let offset: number | undefined;

        do {
          const answer = yield* getEndpoint(
            services,
            offset === undefined
              ? { id: "default", field: "setupScript" }
              : { id: "default", field: "setupScript", offset },
          );

          const page = decoded(answer.structured);

          pages.push(page);
          offset = page.next_offset;

          expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        } while (offset !== undefined);

        expect(SCRIPT.length).toBe(100_000);
        expect(pages).toHaveLength(3);
        expect(Arr.map(pages, (page) => page.offset)).toEqual([0, 40_000, 80_000]);
        expect(Arr.map(pages, (page) => page.total_chars)).toEqual([100_000, 100_000, 100_000]);
        expect(pages[0]).toMatchObject({
          id: "default",
          field: "setupScript",
          next_offset: 40_000,
        });
        expect(pages[2]).not.toHaveProperty("next_offset");
        expect(
          Arr.join(
            Arr.map(pages, (page) => page.text ?? ""),
            "",
          ),
        ).toBe(SCRIPT);

        for (const page of pages) {
          expect(page.text?.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
          expect(storedBytes(page.text ?? "")).toBeLessThanOrEqual(MAX_PAGE_BYTES);
        }
      }),
    ));

  it("holds a page to 48 KiB stored when escapes make its 40,000 characters weigh more", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const quotes = '"'.repeat(100_000);

        const answer = yield* getEndpoint(
          servicesOf([environment("default", { toolchains: quotes })]),
          { id: "default", field: "toolchains" },
        );

        const page = decoded(answer.structured);

        expect(storedBytes(page.text ?? "")).toBeLessThanOrEqual(MAX_PAGE_BYTES);
        expect(page.text?.length).toBe(24_575);
        expect(page.next_offset).toBe(24_575);
      }),
    ));

  it("never splits a surrogate pair, at a page's end or at an offset", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // 🙂 is two UTF-16 units and 4 bytes stored: the 48 KiB limit ends a page before its 40,000 units, and an even
        // offset after the `a` is inside a pair.
        const emoji = `a${"🙂".repeat(30_000)}`;
        const services = servicesOf([environment("default", { startScript: emoji })]);

        const first = decoded(
          (yield* getEndpoint(services, { id: "default", field: "startScript" })).structured,
        );

        // The first page ends after a whole pair: 1 unit, then 12,286 pairs.
        expect(first.text?.length).toBe(24_573);
        expect(first.next_offset).toBe(24_573);

        const inside = decoded(
          (yield* getEndpoint(services, { id: "default", field: "startScript", offset: 4 }))
            .structured,
        );

        // Offset 4 is the second half of the pair that starts at 3.
        expect(inside.offset).toBe(3);
        expect(inside.text?.codePointAt(0)).toBe("🙂".codePointAt(0));

        for (const page of [first, inside]) {
          const text = page.text ?? "";

          expect(text.isWellFormed()).toBe(true);
        }
      }),
    ));

  it("reads a variable whole, the ignore patterns a line each, and a Global field", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const long = "v".repeat(900);

        const services = servicesOf(
          [environment("default", { variables: { LONG: long }, ignore: ["a", "b"] })],
          { ...CONTAINER, toolchains: "[tools]\nnode = 'lts'" },
        );

        const variable = decoded(
          (yield* getEndpoint(services, { id: "default", field: "variables.LONG" })).structured,
        );

        const ignore = decoded(
          (yield* getEndpoint(services, { id: "default", field: "ignore" })).structured,
        );

        const global = decoded(
          (yield* getEndpoint(services, { id: "*", field: "toolchains" })).structured,
        );

        expect(variable).toMatchObject({ text: long, total_chars: 900, offset: 0 });
        expect(variable).not.toHaveProperty("next_offset");
        expect(ignore.text).toBe("a\nb");
        expect(global).toMatchObject({ id: "*", text: "[tools]\nnode = 'lts'" });
      }),
    ));
});

describe("what environment_get refuses on the endpoint", () => {
  const services = servicesOf([environment("default", { setupScript: "x".repeat(100) })]);

  it("answers not_found for an id that names no Environment, and for a variable that is not set", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unknown = yield* Effect.flip(getEndpoint(services, { id: "nope" }));

        const field = yield* Effect.flip(
          getEndpoint(services, { id: "nope", field: "setupScript" }),
        );

        const variable = yield* Effect.flip(
          getEndpoint(services, { id: "default", field: "variables.MISSING" }),
        );

        expect(unknown.code).toBe("not_found");
        expect(unknown.message).toContain('No Environment has the id "nope"');
        expect(field.code).toBe("not_found");
        expect(variable.code).toBe("not_found");
        expect(variable.message).toContain("MISSING is not a variable in force");
      }),
    ));

  it("answers invalid_argument for an offset past the end, an offset without field, and a path that is no field", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const past = yield* Effect.flip(
          getEndpoint(services, { id: "default", field: "setupScript", offset: 101 }),
        );

        const alone = yield* Effect.flip(getEndpoint(services, { id: "default", offset: 0 }));

        const bad = yield* Effect.flip(
          getEndpoint(services, { id: "default", field: "instructions" }),
        );

        expect(past.code).toBe("invalid_argument");
        expect(past.message).toContain("past the end of setupScript, which is 100 characters");
        expect(alone.code).toBe("invalid_argument");
        expect(bad.code).toBe("invalid_argument");
      }),
    ));

  it("reads the last page at an offset equal to the length, empty", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(services, {
          id: "default",
          field: "setupScript",
          offset: 100,
        });

        expect(decoded(answer.structured)).toMatchObject({
          text: "",
          offset: 100,
          total_chars: 100,
        });
      }),
    ));
});
