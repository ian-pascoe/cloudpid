// The cores of the tools that wait for the owner's Approval (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Approvals with no Session; #685 L2): `prepare` only reads and gives the card and what the target is now;
// `apply` runs from `(args, expected, author)` with `known` optional, writing against what the owner saw; and `render`
// takes an Applied built from the Agent changes the Registry recorded, as a resume after a committed write has. What the
// Session's wrappers answer is pinned by `harness-session.test.ts` and `approval-tools.test.ts`; what the cores built for
// the endpoint say is held to the endpoint's words (`expectEndpointWords`).
// @effect-diagnostics preferEffectArray:off strictEffectProvide:off globalJsonInEffect:off
import {
  DEFAULT_CONTAINER_SETTINGS,
  type ContainerSettingsOverrides,
  type Settings,
} from "@cloudpid/config";
import { ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  type Applied,
  instructionsCore,
  limitOfField,
  resetLimitCore as resetSettingsLimitCore,
  spendLimitCore,
  subagentDepthCore,
  subagentWorkspacesCore,
  type SettingsCoreServices,
} from "./approval-cores.ts";
import { recordedChange } from "./agent-change.fixture.ts";
import { type ApprovalAsk, type ApprovalsService, approvedChange } from "./approvals.ts";
import { expectEndpointWords } from "./endpoint-words.fixture.ts";
import type {
  AppliedChange,
  ChangeAuthor,
  ContainerSettingResult,
  EnvironmentDetails,
  EnvironmentsService,
} from "./environment.ts";
import { EnvironmentsError } from "./environment-describe.ts";
import { resetLimitCore } from "./environment-reset.ts";
import { sizeLimitCore } from "./environment-size-limit.ts";
import {
  type AppliedSettingsChange,
  SettingsAccessError,
  type SettingsFieldChange,
  type SettingsView,
} from "./settings.ts";
import { resolvedGlobal } from "./settings.fixture.ts";

const AUTHOR: ChangeAuthor = { conversation: 0, tool: "tool", reason: "A reason." };

// --- The Settings ----------------------------------------------------------------------------------------------

const GLOBAL: Settings = resolvedGlobal({
  spendLimit: { perSession: 5 },
  instructions: "Prefer small commits.",
});

const globalView: SettingsView = {
  scope: "*",
  settings: GLOBAL,
  overrides: { spendLimit: { perSession: 5 }, instructions: "Prefer small commits." },
  overriddenIn: {},
};

const environmentView = (overrides: Schema.Json = {}): SettingsView => ({
  scope: "e1",
  name: "Env",
  settings: { ...GLOBAL, spendLimit: { perSession: 2 } },
  overrides,
  global: GLOBAL,
  instructions: "Use bun.",
});

/** What the stand-ins were asked, in order. */
type Seen = {
  reads: string[];
  writes: Array<{
    scope: string;
    changes: ReadonlyArray<SettingsFieldChange>;
    author: ChangeAuthor;
  }>;
};

/** Settings services over `views`, which answer every write with `answer`; a plain-text check that refuses `refused`. */
const settingsServices = (
  seen: Seen,
  views: Readonly<Record<string, SettingsView>>,
  answer: AppliedSettingsChange = { status: "unchanged" },
): SettingsCoreServices => ({
  access: {
    get: (scope) =>
      Effect.suspend(() => {
        seen.reads.push(scope);

        const view = views[scope];

        return view === undefined
          ? Effect.fail(SettingsAccessError.make({ message: `No Environment ${scope}` }))
          : Effect.succeed(view);
      }),
    change: ({ scope, changes, author }) =>
      Effect.sync(() => {
        seen.writes.push({ scope, changes, author });

        return answer;
      }),
  },
  plainText: (text, what) =>
    text.includes("SECRET")
      ? Effect.fail(EnvironmentsError.make({ message: `${what} holds a Secret` }))
      : Effect.void,
});

const VIEWS = { "*": globalView, e1: environmentView() };

const newSeen = (): Seen => ({ reads: [], writes: [] });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (!Exit.isFailure(exit)) throw new Error("expected a refusal");

    return exit.cause.toString();
  });

describe("the Settings Limit cores", () => {
  it("prepare reads the Scope, shows the card and what the Limit is now, and writes nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen = newSeen();
        const core = spendLimitCore(settingsServices(seen, VIEWS));

        const atGlobal = yield* core.prepare({ scope: "*", per_session: 8, reason: "More." });

        expect(atGlobal.card).toEqual({
          tool: "settings_spend_limit_set",
          target: "the Global Settings",
          change: "Spend limit",
          before: "$5 per Session",
          after: "$8 per Session",
          reason: "More.",
        });
        expect(atGlobal.expected).toBe(5);
        expect(atGlobal.unchanged).toBeUndefined();
        expect(atGlobal.known).toBe(globalView);

        // At an Environment the value in force, and whether it is inherited, is what the owner saw.
        const atEnvironment = yield* core.prepare({ scope: "e1", per_session: 8, reason: "More." });

        expect(atEnvironment.expected).toEqual({ value: 2, inherited: true });
        expect(atEnvironment.card.before).toBe("$2 per Session (inherited from Global)");

        expect(seen.reads).toEqual(["*", "e1"]);
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("prepare answers unchanged for a Limit that has the value, and still gives the card", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = spendLimitCore(settingsServices(newSeen(), VIEWS));

        const same = yield* core.prepare({ scope: "*", per_session: 5, reason: "Same." });

        expect(same.unchanged?.text).toBe(
          "The spend limit at Global is $5 per Session already: nothing was asked, changed or recorded.",
        );
        expect(same.card.after).toBe("$5 per Session");

        // An inherited value is not pinned: setting it at an Environment is a change.
        const inherited = yield* subagentDepthCore(settingsServices(newSeen(), VIEWS)).prepare({
          scope: "e1",
          depth: 2,
          reason: "Same.",
        });

        expect(inherited.unchanged).toBeUndefined();
      }),
    ));

  it("prepare refuses what the tool would refuse, before reading the Scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen = newSeen();
        const core = subagentWorkspacesCore(settingsServices(seen, VIEWS));

        expect(
          yield* failureOf(core.prepare({ scope: "*", limit: 2, reason: "A SECRET." })),
        ).toContain("the reason holds a Secret");
        expect(
          yield* failureOf(core.prepare({ scope: "nope", limit: 2, reason: "Fine." })),
        ).toContain("No Environment nope");
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("apply runs from (args, expected, author), reading the Scope when `known` is absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen = newSeen();
        const core = spendLimitCore(settingsServices(seen, VIEWS, { status: "unchanged" }));

        const applied = yield* core.apply(
          { scope: "e1", per_session: 8, reason: "More." },
          { value: 2, inherited: true },
          AUTHOR,
        );

        expect(seen.reads).toEqual(["e1"]);
        expect(applied.known).toBe(VIEWS.e1);
        expect(seen.writes).toEqual([
          {
            scope: "e1",
            changes: [
              {
                field: "spendLimit.perSession",
                value: 8,
                expected: { value: 2, inherited: true },
              },
            ],
            author: { ...AUTHOR, approved: true },
          },
        ]);

        // With `known` it reads nothing.
        yield* core.apply({ scope: "*", per_session: 8, reason: "More." }, 5, AUTHOR, globalView);

        expect(seen.reads).toEqual(["e1"]);
        expect(seen.writes[1]?.changes[0]?.expected).toEqual({ value: 5 });
      }),
    ));

  it("apply refuses an `expected` that is not what prepare gives, rather than guessing what the owner saw", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen = newSeen();
        const core = spendLimitCore(settingsServices(seen, VIEWS));

        // At an Environment `prepare` gives the value and whether it was inherited.
        expect(
          yield* failureOf(core.apply({ scope: "e1", per_session: 8, reason: "More." }, 2, AUTHOR)),
        ).toContain(
          "what the owner was shown of the Limit was not kept in a form this change reads",
        );
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("render takes an Applied built from the recorded Agent changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = spendLimitCore(settingsServices(newSeen(), VIEWS));

        const changes = [
          // As an endpoint's record is: no Session, no conversation.
          recordedChange("tool", {
            field: "spendLimit.perSession",
            before: 5,
            after: 8,
            tool: "settings_spend_limit_set",
            session: null,
            conversation: null,
          }),
        ];

        const applied: Applied<SettingsView, AppliedSettingsChange> = {
          known: globalView,
          result: { status: "changed", changes },
        };

        const answer = yield* core.render(
          { scope: "*", per_session: 8, reason: "More." },
          5,
          applied,
          { reach: "Other Sessions get it when they next admit input." },
        );

        expect(answer.text).toBe(
          "The user approved: the spend limit at Global was $5 per Session, and is $8 per Session now. Other Sessions get it when they next admit input. The change is recorded as approved, with your reason; the user can revert it on the Settings page.",
        );
        expect(answer.structured).toMatchObject({
          scope: { id: "*" },
          changes: [{ id: 7, field: "spendLimit.perSession" }],
          approval: { approved: true, reason: null },
        });
        expect(answer.details).toMatchObject({
          scope: "*",
          approval: { approved: true },
          agentChanges: [{ id: 7, field: "spendLimit.perSession", before: 5, after: 8 }],
        });
      }),
    ));

  it("render says a write that was not made as a refusal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = spendLimitCore(settingsServices(newSeen(), VIEWS));
        const args = { scope: "*", per_session: 8, reason: "More." };

        const refused = (result: AppliedSettingsChange) =>
          failureOf(core.render(args, 5, { known: globalView, result }, { reach: "" }));

        expect(yield* refused({ status: "rejected", message: "not a limit" })).toContain(
          "The user approved, but nothing was saved: not a limit",
        );
        expect(
          yield* refused({ status: "changed-since", field: "spendLimit.perSession", current: 6 }),
        ).toContain(
          "the spend limit at Global changed since they were asked: it is $6 per Session now",
        );
      }),
    ));

  it("declined says what was asked and changes nothing", () => {
    const core = spendLimitCore(settingsServices(newSeen(), VIEWS));

    const answer = core.declined({ scope: "*", per_session: 8, reason: "More." }, globalView, {
      approved: false,
      reason: "No.",
      expected: 5,
    });

    expect(answer.text).toBe(
      "The user declined: Spend limit at Global, from $5 per Session to $8 per Session. Nothing changed. Their reason: No. Do not ask again for the same change unless the user wants it.",
    );
    expect(answer.structured).toMatchObject({ approval: { approved: false, reason: "No." } });
  });

  it("the reset of a Limit puts it back to its default at Global and inherits Global at an Environment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const limit = Option.getOrThrow(limitOfField("spendLimit.perSession"));
        const core = resetSettingsLimitCore(settingsServices(newSeen(), VIEWS), limit);

        const atGlobal = yield* core.prepare({ scope: "*", reason: "Back." });

        expect(atGlobal.card.change).toBe("Spend limit, reset");
        expect(atGlobal.card.after).toBe("no limit (the default)");
        expect(atGlobal.unchanged).toBeUndefined();

        // The Environment holds no Override: it inherits Global already.
        const inherited = yield* core.prepare({ scope: "e1", reason: "Back." });

        expect(inherited.unchanged?.text).toContain("does not override the spend limit");
        expect(inherited.card.after).toBe("$5 per Session (inherited from Global)");
      }),
    ));

  it("the Instructions' core refuses too long a text and a text with a Secret, and answers unchanged for the same text", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen = newSeen();
        const core = instructionsCore(settingsServices(seen, VIEWS));

        expect(
          yield* failureOf(core.prepare({ scope: "*", text: "x".repeat(70_000), reason: "Long." })),
        ).toContain("the Instructions are 70,000 bytes");
        expect(
          yield* failureOf(core.prepare({ scope: "*", text: "A SECRET", reason: "Fine." })),
        ).toContain("the text holds a Secret");
        expect(seen.reads).toEqual([]);

        const same = yield* core.prepare({
          scope: "*",
          text: "Prefer small commits.",
          reason: "Same.",
        });

        expect(same.unchanged?.text).toBe(
          "The Instructions at Global have that text already: nothing was asked, changed or recorded.",
        );

        const changed = yield* core.prepare({ scope: "e1", text: "", reason: "Remove." });

        expect(changed.card).toMatchObject({
          change: "Instructions",
          before: "Use bun.",
          after: "None",
        });
        expect(changed.expected).toBe("Use bun.");
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("the Instructions' render says when a removal applies, from the recorded change", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = instructionsCore(settingsServices(newSeen(), VIEWS));
        const view = environmentView();

        const answer = yield* core.render(
          { scope: "e1", text: "", reason: "Remove." },
          "Use bun.",
          {
            known: view,
            result: {
              status: "changed",
              changes: [
                recordedChange("tool", {
                  scope: "e1",
                  field: "instructions",
                  before: "Use bun.",
                  after: "",
                }),
              ],
            },
          },
          { reach: "" },
        );

        expect(answer.text).toContain(
          'the Instructions for Environment "Env" (e1) are removed. Its Sessions\' conversations stop being shown them from the start of their next Context Window',
        );
      }),
    ));
});

// --- The size limit --------------------------------------------------------------------------------------------

const environmentOf = (id: string, over: Partial<EnvironmentDetails> = {}): EnvironmentDetails => ({
  id,
  name: `Env ${id}`,
  repos: [],
  build: { status: "none" },
  overrides: {},
  settings: DEFAULT_CONTAINER_SETTINGS,
  global: DEFAULT_CONTAINER_SETTINGS,
  secrets: [],
  skills: [],
  globalSkills: [],
  ...over,
});

type EnvironmentSeen = { reads: string[]; writes: unknown[] };

const environmentServices = (
  seen: EnvironmentSeen,
  held: ReadonlyArray<EnvironmentDetails>,
  answer: AppliedChange = { status: "missing" },
  current: string | null = null,
): Pick<EnvironmentsService, "current" | "list" | "get" | "global" | "change"> => ({
  current: Effect.succeed(current),
  list: Effect.succeed(held.map(({ id, name, repos, build }) => ({ id, name, repos, build }))),
  get: (id) =>
    Effect.sync(() => {
      seen.reads.push(id);

      return held.find((each) => each.id === id) ?? null;
    }),
  global: Effect.succeed({
    settings: DEFAULT_CONTAINER_SETTINGS,
    overriddenIn: {},
    secrets: [],
    skills: [],
  }),
  change: (input) =>
    Effect.sync(() => {
      seen.writes.push(input);

      return answer;
    }),
});

const plainText: SettingsCoreServices["plainText"] = (text, what) =>
  text.includes("SECRET")
    ? Effect.fail(EnvironmentsError.make({ message: `${what} holds a Secret` }))
    : Effect.void;

describe("the size limit's core", () => {
  const big = environmentOf("big", {
    settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "cpu-3", maxInstance: "cpu-3" },
    overrides: { instance: "cpu-3" },
  });

  it("prepare reads, refuses what the limit cannot be, and shows the card", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen: EnvironmentSeen = { reads: [], writes: [] };

        const core = sizeLimitCore({
          environments: environmentServices(seen, [environmentOf("e1"), big]),
          plainText,
        });

        const ready = yield* core.prepare({ id: "e1", size: "cpu-3", reason: "Bigger." });

        expect(ready.card).toEqual({
          tool: "environment_container_size_limit_set",
          target: 'Environment "Env e1"',
          change: "Size limit",
          before: "cpu-2 (2 vCPU, 6 GiB memory, 12 GB disk)",
          after: "cpu-3 (3 vCPU, 9 GiB memory, 12 GB disk)",
          reason: "Bigger.",
        });
        expect(ready.expected).toBe("cpu-2");
        expect(ready.known).toEqual({ environment: { id: "e1", name: "Env e1" }, own: false });

        expect(
          yield* failureOf(core.prepare({ id: "big", size: "cpu-2", reason: "Smaller." })),
        ).toContain('is below the size of Environment "Env big" (big), cpu-3');
        expect(
          yield* failureOf(core.prepare({ id: "*", size: "cpu-1", reason: "Smaller." })),
        ).toContain("which inherits the size limit at Global");
        expect(
          yield* failureOf(core.prepare({ id: "e1", size: "cpu-3", reason: "A SECRET." })),
        ).toContain("the reason holds a Secret");
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("prepare answers unchanged for the size the limit has as its own", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const own = environmentOf("e1", {
          overrides: { maxInstance: "cpu-3" },
          settings: { ...DEFAULT_CONTAINER_SETTINGS, maxInstance: "cpu-3" },
        });

        const core = sizeLimitCore({
          environments: environmentServices({ reads: [], writes: [] }, [own]),
          plainText,
        });

        const same = yield* core.prepare({ id: "e1", size: "cpu-3", reason: "Same." });

        expect(same.unchanged?.text).toBe(
          'The size limit of Environment "Env e1" (e1) is cpu-3 already: nothing was asked, changed or recorded.',
        );
      }),
    ));

  it("apply writes against what the owner saw, and is the Session's own only when the Registry says so", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen: EnvironmentSeen = { reads: [], writes: [] };

        const core = sizeLimitCore({
          environments: environmentServices(seen, [environmentOf("e1")], {
            status: "unchanged",
            environment: { id: "e1", name: "Env e1" },
            value: "cpu-3",
          }),
          plainText,
        });

        const applied = yield* core.apply(
          { id: "e1", size: "cpu-3", reason: "Bigger." },
          "cpu-2",
          AUTHOR,
        );

        expect(applied.known).toEqual({ environment: { id: "e1", name: "Env e1" }, own: false });
        expect(seen.writes).toEqual([
          {
            environment: "e1",
            change: { field: "maxInstance", value: "cpu-3" },
            expected: { value: "cpu-2" },
            author: { ...AUTHOR, approved: true },
          },
        ]);

        const withKnown = yield* core.apply(
          { id: "e1", size: "cpu-3", reason: "Bigger." },
          "cpu-2",
          AUTHOR,
          applied.known,
        );

        expect(withKnown.known).toBe(applied.known);
        expect(seen.reads).toEqual(["e1"]);
      }),
    ));

  it("render from the recorded change leaves the Builds to environment_get", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = sizeLimitCore({
          environments: environmentServices({ reads: [], writes: [] }, []),
          plainText,
        });

        const args = { id: "e1", size: "cpu-3" as const, reason: "Bigger." };

        const change = recordedChange("tool", {
          scope: "e1",
          field: "maxInstance",
          before: "cpu-2",
          after: "cpu-3",
        });

        const known = { environment: { id: "e1", name: "Env e1" }, own: false };

        const fromRecord = yield* core.render(
          args,
          "cpu-2",
          {
            known,
            result: { status: "changed", environment: known.environment, change },
          },
          undefined,
        );

        expect(fromRecord.text).toContain("environment_get shows the Build.");
        expect(fromRecord.structured).toMatchObject({ new_build: false, global: null });

        // The write's own answer says whether the upkeep asked for a Build.
        const fromWrite = yield* core.render(
          args,
          "cpu-2",
          {
            known,
            result: { status: "changed", environment: known.environment, change, newBuild: true },
          },
          undefined,
        );

        expect(fromWrite.text).toContain("a new Build was asked for");

        // At Global, whom the change reached is the write's to say.
        const atGlobal = yield* core.render(
          { ...args, id: "*" },
          "cpu-2",
          {
            known: { environment: { id: "*", name: "Global" }, own: false },
            result: {
              status: "changed",
              environment: { id: "*", name: "Global" },
              change: { ...change, scope: "*" },
            },
          },
          undefined,
        );

        expect(atGlobal.text).toContain("environment_get shows the Builds.");
        expect(atGlobal.text).not.toContain("Container settings are not");
      }),
    ));

  it("render says a write that was not made as a refusal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core = sizeLimitCore({
          environments: environmentServices({ reads: [], writes: [] }, []),
          plainText,
        });

        const known = { environment: { id: "e1", name: "Env e1" }, own: false };
        const args = { id: "e1", size: "cpu-3" as const, reason: "Bigger." };

        expect(
          yield* failureOf(
            core.render(
              args,
              "cpu-2",
              {
                known,
                result: { status: "changed-since", current: "cpu-1" },
              },
              undefined,
            ),
          ),
        ).toContain(
          'the size limit of Environment "Env e1" (e1) changed since they were asked: it is cpu-1',
        );
        expect(
          yield* failureOf(
            core.render(args, "cpu-2", { known, result: { status: "missing" } }, undefined),
          ),
        ).toContain('No Environment has the id "e1"');
      }),
    ));
});

describe("the reset of the size limit's core", () => {
  const own = environmentOf("e1", {
    overrides: { maxInstance: "cpu-3" } satisfies ContainerSettingsOverrides,
    settings: { ...DEFAULT_CONTAINER_SETTINGS, maxInstance: "cpu-3" },
  });

  const core = (
    seen: EnvironmentSeen,
    held: ReadonlyArray<EnvironmentDetails>,
    answer?: AppliedChange,
  ) => {
    const environments = environmentServices(seen, held, answer);

    return resetLimitCore({
      environments,
      refuseSecrets: (texts) =>
        texts.some(({ text }) => text.includes("SECRET"))
          ? Effect.fail(EnvironmentsError.make({ message: "the reason holds a Secret" }))
          : Effect.void,
      target: (id) =>
        id === "*"
          ? Effect.fail(EnvironmentsError.make({ message: "Not Global" }))
          : Effect.map(environments.current, (current) => ({
              environment: id,
              own: id === current,
            })),
    });
  };

  it("prepare shows the card, answers unchanged for an inherited limit, and writes nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen: EnvironmentSeen = { reads: [], writes: [] };

        const ready = yield* core(seen, [own]).prepare({ id: "e1", reason: "Back." });

        expect(ready.card).toEqual({
          tool: "environment_setting_reset",
          target: 'Environment "Env e1"',
          change: "Size limit (reset to Global's)",
          before: "cpu-3 (3 vCPU, 9 GiB memory, 12 GB disk), its own",
          after: "cpu-2 (2 vCPU, 6 GiB memory, 12 GB disk), inherited from Global",
          reason: "Back.",
        });
        expect(ready.expected).toBe("cpu-3");
        expect(ready.unchanged).toBeUndefined();

        const inherited = yield* core(seen, [environmentOf("e2")]).prepare({
          id: "e2",
          reason: "Back.",
        });

        expect(inherited.unchanged?.text).toContain("is inherited from Global already");
        expect(yield* failureOf(core(seen, [own]).prepare({ id: "*", reason: "Back." }))).toContain(
          "Not Global",
        );
        expect(seen.writes).toEqual([]);
      }),
    ));

  it("apply resets against what the owner saw, and render takes the recorded change", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const seen: EnvironmentSeen = { reads: [], writes: [] };

        const change = recordedChange("tool", {
          scope: "e1",
          field: "maxInstance",
          before: "cpu-3",
          after: "cpu-2",
          afterInherited: true,
        });

        const applied = yield* core(seen, [own], {
          status: "changed",
          environment: { id: "e1", name: "Env e1" },
          change,
          newBuild: false,
        }).apply({ id: "e1", reason: "Back." }, "cpu-3", AUTHOR);

        expect(seen.writes).toEqual([
          {
            environment: "e1",
            change: { field: "maxInstance", value: null },
            expected: { value: "cpu-3" },
            author: { ...AUTHOR, approved: true },
          },
        ]);

        const answer = yield* core(seen, []).render(
          { id: "e1", reason: "Back." },
          "cpu-3",
          {
            known: applied.known,
            result: { status: "changed", environment: { id: "e1", name: "Env e1" }, change },
          },
          undefined,
        );

        expect(answer.text).toContain(
          'The user approved: reset the size limit of Environment "Env e1" (e1): it was cpu-3 (its own), and inherits Global\'s cpu-2 now',
        );
        expect(answer.text).toContain("environment_get shows the Build.");
      }),
    ));
});

// --- The endpoint's words ------------------------------------------------------------------------------------------

describe("the cores built for the endpoint", () => {
  const known = { environment: { id: "e1", name: "Env e1" }, own: false };

  const sizeChange = recordedChange("tool", {
    scope: "e1",
    field: "maxInstance",
    before: "cpu-2",
    after: "cpu-3",
  });

  const settingsChange = recordedChange("tool", {
    field: "spendLimit.perSession",
    before: 5,
    after: 8,
  });

  it("answer an approved change, and refuse one not made, in the endpoint's words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = { ...settingsServices(newSeen(), VIEWS), surface: "endpoint" as const };
        const spend = spendLimitCore(services);
        const instructions = instructionsCore(services);
        const spendArgs = { scope: "*", per_session: 8, reason: "More." };
        const instructionsArgs = { scope: "e1", text: "Use pnpm.", reason: "Change." };
        const how = { reach: "" };

        const spendRender = (result: AppliedSettingsChange) =>
          spend.render(spendArgs, 5, { known: globalView, result }, how);

        const instructionsRender = (result: AppliedSettingsChange) =>
          instructions.render(
            instructionsArgs,
            "Use bun.",
            { known: environmentView(), result },
            how,
          );

        const size = sizeLimitCore({
          environments: environmentServices({ reads: [], writes: [] }, []),
          plainText,
          surface: "endpoint",
        });

        const sizeArgs = { id: "e1", size: "cpu-3" as const, reason: "Bigger." };

        const sizeRender = (result: ContainerSettingResult) =>
          size.render(sizeArgs, "cpu-2", { known, result }, undefined);

        const said = [
          (yield* spendRender({ status: "changed", changes: [settingsChange] })).text,
          (yield* spendRender({ status: "unchanged" })).text,
          (yield* Effect.flip(spendRender({ status: "rejected", message: "no" }))).message,
          (yield* Effect.flip(
            spendRender({ status: "changed-since", field: "spendLimit.perSession", current: 6 }),
          )).message,
          (yield* instructionsRender({
            status: "changed",
            changes: [recordedChange("tool", { scope: "e1", field: "instructions" })],
          })).text,
          (yield* instructionsRender({ status: "unchanged" })).text,
          (yield* sizeRender({
            status: "changed",
            environment: known.environment,
            change: sizeChange,
          })).text,
          (yield* sizeRender({
            status: "unchanged",
            environment: known.environment,
            value: "cpu-3",
          })).text,
          (yield* Effect.flip(sizeRender({ status: "rejected", message: "no" }))).message,
          (yield* Effect.flip(sizeRender({ status: "changed-since", current: "cpu-1" }))).message,
        ];

        for (const text of said) expectEndpointWords(text);
      }),
    ));

  it("answer the size limit's reset, asked, applied or found done, in the endpoint's words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const own = environmentOf("e1", {
          overrides: { maxInstance: "cpu-3" } satisfies ContainerSettingsOverrides,
          settings: { ...DEFAULT_CONTAINER_SETTINGS, maxInstance: "cpu-3" },
        });

        const reset = resetLimitCore({
          environments: environmentServices({ reads: [], writes: [] }, [own, environmentOf("e2")]),
          refuseSecrets: () => Effect.void,
          target: (id) => Effect.succeed({ environment: id, own: false }),
          surface: "endpoint",
        });

        const render = (result: ContainerSettingResult) =>
          reset.render(
            { id: "e1", reason: "Back." },
            "cpu-3",
            { known: { details: own, own: false }, result },
            undefined,
          );

        const inherited = yield* reset.prepare({ id: "e2", reason: "Back." });

        // The answer of a reset with nothing to do is the endpoint's own value, as the plain reset's is there.
        expect(inherited.unchanged?.structured).toMatchObject({
          scope: { id: "e2" },
          unchanged: ["maxInstance"],
        });

        const said = [
          inherited.unchanged?.text ?? "",
          (yield* render({ status: "changed", environment: known.environment, change: sizeChange }))
            .text,
          (yield* render({ status: "unchanged", environment: known.environment, value: "cpu-2" }))
            .text,
          (yield* Effect.flip(render({ status: "rejected", message: "no" }))).message,
          (yield* Effect.flip(render({ status: "changed-since", current: "cpu-1" }))).message,
        ];

        for (const text of said) expectEndpointWords(text);
      }),
    ));
});

// --- The Session's run of a core ---------------------------------------------------------------------------------

describe("a rerun that asked before", () => {
  /** Approvals that answer every request with `approve`, which `holds` says were asked before. */
  const approvals = (asked: ApprovalAsk[], holds: boolean): ApprovalsService => ({
    ask: (request) =>
      Effect.sync(() => {
        asked.push(request);

        return { approved: true as const, expected: request.expected };
      }),
    settle: () => Effect.void,
    holds: () => Effect.succeed(holds),
    pending: Effect.succeed([]),
    answer: () => Effect.die("not used"),
    dropAbandoned: Effect.void,
  });

  // SAFETY: the run reads only the call's task and conversation from the invocation's API.
  const api = {
    taskId: 4 as TaskId,
    conversationId: ROOT_CONVERSATION_ID,
    progressed: () => undefined,
  };

  const run = (asked: ApprovalAsk[], holds: boolean) =>
    approvedChange(
      approvals(asked, holds),
      // SAFETY: as above.
      api as never,
      spendLimitCore(settingsServices(newSeen(), VIEWS, { status: "unchanged" })),
      { scope: "*", per_session: 5, reason: "Same." },
      () => Effect.succeed({ reach: "" }),
    );

  it("asks nothing for the value the target has", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const asked: ApprovalAsk[] = [];
        const result = yield* run(asked, false);

        expect(asked).toEqual([]);
        expect(result.output[0]?.text).toContain("already: nothing was asked");
      }),
    ));

  it("still asks, and reports what the owner answered", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const asked: ApprovalAsk[] = [];
        const result = yield* run(asked, true);

        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ id: "4", expected: 5, tool: "settings_spend_limit_set" });
        expect(result.output[0]?.text).toBe(
          "The user approved, and the spend limit at Global is $5 per Session already, as approved: nothing more needed changing.",
        );
      }),
    ));
});
