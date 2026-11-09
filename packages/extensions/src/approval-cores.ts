// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
// The cores of the tools that change a Limit of the Settings, and of `settings_instructions_set`
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Approvals with no Session; #685 L2). A tool
// that waits for the owner's Approval is three steps over plain services, none of which touches `ToolExecutionApi`, the
// Session's `Approvals` or its after-steps:
//
// - `prepare(args)` only reads: it refuses what the tool would refuse anyway, and answers the card the owner is shown
//   and what the target is now (`expected`), or, when the target has the value already, the answer to give instead
//   (`unchanged`), which a rerun that asked before overrides.
// - `apply(args, expected, author, known?)` makes the write against `expected`, the value the owner saw, and answers
//   how it went. It re-reads the Scope's view when `known` (what `prepare` read) is absent.
// - `render(args, expected, applied, how)` is the text, the value for programs and the details of an applied change,
//   from `applied`'s `result`: the write's own answer, or one built from the Agent changes it recorded. `how` is what
//   only the caller knows (here, what the change reaches). A write that was not made is the core's refusal.
//
// The Session's wrappers (`./approval-tools.ts`) run them between `withApproval` and their after-steps; Registry-held
// Approvals run `apply` from the main Worker, and `render` for an Applied they build from recorded Agent changes.
import {
  DEFAULT_SETTINGS,
  extensionField,
  instructionsProblem,
  MAX_INSTRUCTIONS_BYTES,
  overrideValue,
  settingsFieldValue,
  textSize,
  utf8Bytes,
} from "@cloudpid/config";
import type { ApprovalCardContent } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type ApprovalAnswer, approvedAlready, changedSince, declinedAnswer } from "./approvals.ts";
import { type ChangeAuthor, storedText } from "./environment.ts";
import type { EnvironmentsError } from "./environment-describe.ts";
import type { HarnessAnswer } from "./harness.ts";
import { APPROVED } from "./outputs.ts";
import {
  agentChangeDetails,
  type AppliedSettingsChange,
  fieldLabel,
  inheritedWords,
  isGlobalView,
  scopeName,
  scopeWhere,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsFieldChange,
  settingsTarget,
  type SettingsView,
} from "./settings.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "./subagents/options.ts";
import { DEFAULT_MAX_SUBAGENT_WORKSPACES } from "./subagents/workspaces.ts";

/** What a core's `prepare` found. */
export type Prepared<Known> = {
  /** What the owner is shown. */
  readonly card: ApprovalCardContent;
  /** What the target is now: the write is made only while the target still has it. */
  readonly expected: Schema.Json | null;
  /** What `prepare` read of the target, which `apply` takes back as `known` so that it reads nothing again. */
  readonly known: Known;
  /**
   * The answer to give when the target has the value asked for already: nothing is asked. A call that asked before
   * (a rerun after an eviction, which may have made the change itself) goes on to ask anyway, so it reports what the
   * owner answered.
   */
  readonly unchanged?: HarnessAnswer | undefined;
};

/** What `apply` did: what it knew of the target, and how the write went (`Result` is the target's own kind of answer). */
export type Applied<Known, Result> = { readonly known: Known; readonly result: Result };

/** The owner's refusal, as an answer: nothing was changed. */
export type DeclinedAnswer = Extract<ApprovalAnswer, { readonly approved: false }>;

/**
 * A tool's core: `prepare`, `apply` and `render` (#685 L2), and what a decline says. `Args` is the tool's decoded arguments,
 * and `Known` what `prepare` read. `How` is what `render` needs of the caller: nothing, unless a core says.
 */
export type ApprovalCore<Args, Known, Result, Failure, How = undefined> = {
  /** The tool the core is of: its cards and the changes it makes carry the name. */
  readonly tool: string;
  readonly prepare: (args: Args) => Effect.Effect<Prepared<Known>, Failure>;
  readonly apply: (
    args: Args,
    expected: Schema.Json | null,
    author: ChangeAuthor,
    known?: Known,
  ) => Effect.Effect<Applied<Known, Result>, Failure>;
  readonly render: (
    args: Args,
    expected: Schema.Json | null,
    applied: Applied<Known, Result>,
    how: How,
  ) => Effect.Effect<HarnessAnswer, Failure>;
  /** What the owner's decline answers, from what `prepare` read. */
  readonly declined: (args: Args, known: Known, answer: DeclinedAnswer) => HarnessAnswer;
};

/**
 * The check of a text the tool keeps or shows on the card (`plainTextCheck`): it fails, asking nothing, when `text` holds
 * a Secret, a credential or a Secret Reference's placeholder; `fix` says what to do instead. The Session's holds its own
 * Secrets too; a caller with none passes the check of the shapes alone.
 */
export type PlainText = (
  text: string,
  what: string,
  fix: string,
) => Effect.Effect<void, EnvironmentsError>;

/** What the Settings cores read and write: the Registry's Settings, and the check of the texts. */
export type SettingsCoreServices = {
  readonly access: Pick<SettingsAccessService, "get" | "change">;
  readonly plainText: PlainText;
};

/** The refusals a Settings core gives. */
export type SettingsCoreFailure = EnvironmentsError | SettingsAccessError;

/** What a Settings core's `render` is given of what only its caller knows. */
export type SettingsHow = {
  /** What the change reaches, as a sentence: which Sessions get it and when. */
  readonly reach: string;
};

/** A Settings core for the arguments `Args`; a Limit's has the Limit it changes. */
export type SettingsCore<Args> = ApprovalCore<
  Args,
  SettingsView,
  AppliedSettingsChange,
  SettingsCoreFailure,
  SettingsHow
> & {
  /** The Limit a Limit core changes; absent for a core of no Limit (the Instructions), whose field no change reaches. */
  readonly limit?: SettingsLimit | undefined;
};

// ─── Words ───────────────────────────────────────────────────────────────────

/** US dollars as the owner reads them. */
const dollars = (amount: number): string =>
  `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

/** A spend limit as the owner reads it. */
const spendWords = (limit: Schema.Json | null): string =>
  Predicate.isNumber(limit) ? `${dollars(limit)} per Session` : "no limit";

/** A subagent depth as the owner reads it. */
const depthWords = (depth: number): string =>
  `${depth} level${depth === 1 ? "" : "s"} of subagents below the root`;

/** The subagent depth a stored value gives: the default where it is unset or not a depth. */
const depthOf = (stored: Schema.Json | null): number =>
  Predicate.isNumber(stored) && Number.isInteger(stored) && stored > 0
    ? stored
    : DEFAULT_MAX_SUBAGENT_DEPTH;

/** A stored subagent depth as the owner reads it. */
const storedDepthWords = (stored: Schema.Json | null): string =>
  `${depthWords(depthOf(stored))}${stored === null ? " (the default)" : ""}`;

/** A Subagent Workspace limit as the owner reads it. */
const workspacesWords = (limit: number): string =>
  `${limit} Subagent Workspace${limit === 1 ? "" : "s"} per Session`;

/** The Subagent Workspace limit a stored value gives: the default where it is unset or not a limit. */
const workspacesOf = (stored: Schema.Json | null): number =>
  Predicate.isNumber(stored) && Number.isInteger(stored) && stored >= 0
    ? stored
    : DEFAULT_MAX_SUBAGENT_WORKSPACES;

/** A stored Subagent Workspace limit as the owner reads it. */
const storedWorkspacesWords = (stored: Schema.Json | null): string =>
  `${workspacesWords(workspacesOf(stored))}${stored === null ? " (the default)" : ""}`;

/** A Limit of the Settings: its field, what the card calls it, and how the owner reads a value of it. */
export type SettingsLimit = {
  readonly field: string;
  /** The Limit as a card names it. */
  readonly change: string;
  /** The Limit as a sentence names it. */
  readonly name: string;
  /** A stored value as the owner reads it (null: not set, the default). */
  readonly words: (stored: Schema.Json | null) => string;
  /** Its default as the owner reads it. */
  readonly byDefault: string;
};

export const SPEND_LIMIT: SettingsLimit = {
  field: "spendLimit.perSession",
  change: "Spend limit",
  name: "the spend limit",
  words: spendWords,
  byDefault: "no limit (the default)",
};

export const DEPTH_LIMIT: SettingsLimit = {
  field: extensionField("subagents", "maxSubagentDepth"),
  change: "Subagent depth",
  name: "the subagent depth",
  words: storedDepthWords,
  byDefault: storedDepthWords(null),
};

export const WORKSPACES_LIMIT: SettingsLimit = {
  field: extensionField("subagents", "maxSubagentWorkspaces"),
  change: "Subagent Workspace limit",
  name: "the Subagent Workspace limit",
  words: storedWorkspacesWords,
  byDefault: storedWorkspacesWords(null),
};

export const SETTINGS_LIMITS: ReadonlyArray<SettingsLimit> = [
  SPEND_LIMIT,
  DEPTH_LIMIT,
  WORKSPACES_LIMIT,
];

/** The field of the Instructions in the Settings. */
export const INSTRUCTIONS_FIELD = "instructions";

/** The Instructions as a card shows them: as written, or none. */
const instructionsWords = (text: string): string => (text === "" ? "None" : text);

/** A whole number with its thousands grouped, as the owner reads it. */
const grouped = (n: number): string => n.toLocaleString("en-US");

/**
 * What a result says of when an approved change of the Instructions applies, to conversations named by `whose` ("its"
 * or "their"): never inside a context.
 */
const instructionsApply = (whose: "its" | "their"): string =>
  `from the start of ${whose} next Context Window (a new Session, a Handoff or a Rollover); this one, like every context that has begun, keeps showing the Instructions it started with.`;

/** What a Limit at an Environment was when the owner was asked: its value in force, and whether it was inherited. */
const LimitAtEnvironment = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  inherited: Schema.Boolean,
});

/**
 * What the owner saw of a Limit, from `expected`: at Global the value, at an Environment the value and whether it was
 * inherited, as `prepare` gives it. None when `expected` is not that.
 */
const seenOf = (
  view: SettingsView,
  expected: Schema.Json | null,
): Option.Option<{ readonly value: Schema.Json | null; readonly inherited?: boolean }> =>
  isGlobalView(view)
    ? Option.some({ value: expected })
    : Schema.decodeUnknownOption(LimitAtEnvironment)(expected);

/** `seenOf`, failing for an `expected` that is not what `prepare` gives: the write must not guess what the owner saw. */
const limitSeen = (view: SettingsView, expected: Schema.Json | null) =>
  Effect.fromOption(seenOf(view, expected)).pipe(
    Effect.mapError(() =>
      SettingsAccessError.make({
        message:
          "Nothing was saved: what the owner was shown of the Limit was not kept in a form this change reads.",
      }),
    ),
  );

/** A Limit's value in force at `view`'s Scope, and at an Environment whether it is inherited (it has no Override). */
const limitNow = (view: SettingsView, limit: SettingsLimit) => ({
  stored: settingsFieldValue(view.settings, limit.field),
  inherited: isGlobalView(view)
    ? undefined
    : Option.isNone(overrideValue(view.overrides, limit.field)),
});

/**
 * A Limit's value before, as the card and the results say it, from what the owner saw. An `expected` that is not what
 * `prepare` gives (`apply` refuses it) is said as it is, so that words made after a write never fail.
 */
const beforeWords = (limit: SettingsLimit, view: SettingsView, expected: Schema.Json | null) =>
  Option.match(seenOf(view, expected), {
    onNone: () => storedText(expected),
    onSome: (seen) => `${limit.words(seen.value)}${inheritedWords(seen.inherited)}`,
  });

// ─── The Limits ──────────────────────────────────────────────────────────────

/** The arguments every Settings core has: the Scope, and why. */
type ScopedArgs = { readonly scope: string; readonly reason: string };

/** How a Limit change is made and said, for the arguments `Args`. */
type LimitSpec<Args> = {
  readonly tool: string;
  readonly limit: SettingsLimit;
  /** The change as the card names it. */
  readonly change: string;
  /** The field's change that makes it. */
  readonly fieldChange: (args: Args) => SettingsFieldChange;
  /** The value the Limit has after the change, as the owner reads it, at `view`'s Scope. */
  readonly after: (args: Args, view: SettingsView) => string;
  /** The answer's words when the Limit has the value already at `view`'s Scope; undefined when it does not. */
  readonly unchanged: (args: Args, view: SettingsView) => string | undefined;
};

/**
 * The core of a tool that changes `spec.limit` at one Scope: the card shows the Limit as it is now and after the change,
 * and the change is made only while the Limit is still as the owner saw it (at an Environment, inherited or not as it was).
 */
const limitCore = <Args extends ScopedArgs>(
  { access, plainText }: SettingsCoreServices,
  spec: LimitSpec<Args>,
): SettingsCore<Args> => {
  const { tool, limit } = spec;

  return {
    tool,
    limit,
    prepare: (args) =>
      Effect.gen(function* () {
        yield* plainText(args.reason, "the reason", "Say why without it.");

        const view = yield* access.get(args.scope);
        const { stored, inherited } = limitNow(view, limit);
        const said = spec.unchanged(args, view);

        return {
          card: {
            tool,
            target: settingsTarget(view),
            change: spec.change,
            before: `${limit.words(stored)}${inheritedWords(inherited)}`,
            after: spec.after(args, view),
            reason: args.reason,
          },
          expected: inherited === undefined ? stored : { value: stored, inherited },
          known: view,
          unchanged:
            said === undefined
              ? undefined
              : {
                  text: said,
                  structured: settingsChangeOutput({
                    view,
                    changes: [],
                    unchanged: [limit.field],
                    approval: null,
                  }),
                  details: { scope: view.scope, unchanged: [limit.field], agentChanges: [] },
                },
        };
      }),

    apply: (args, expected, author, known) =>
      Effect.gen(function* () {
        const view = known ?? (yield* access.get(args.scope));
        const seen = yield* limitSeen(view, expected);

        const result = yield* access.change({
          scope: view.scope,
          changes: [{ ...spec.fieldChange(args), expected: seen }],
          author: { ...author, approved: true },
        });

        return { known: view, result };
      }),

    render: (args, expected, { known: view, result }, how) => {
      const where = scopeWhere(view);
      const after = spec.after(args, view);

      switch (result.status) {
        case "rejected":
          return Effect.fail(
            SettingsAccessError.make({
              message: `The user approved, but nothing was saved: ${result.message}`,
            }),
          );
        case "changed-since":
          return Effect.fail(
            SettingsAccessError.make({
              message: changedSince(
                `${limit.name} ${where}`,
                `${limit.words(result.current)}${inheritedWords(result.inherited)}`,
              ),
            }),
          );
        case "unchanged":
          return Effect.succeed({
            text: approvedAlready(`${limit.name} ${where} is ${after}`),
            structured: settingsChangeOutput({
              view,
              changes: [],
              unchanged: [limit.field],
              approval: APPROVED,
            }),
            details: { scope: view.scope, approval: { approved: true }, agentChanges: [] },
          });
        case "changed":
          return Effect.succeed({
            text: `The user approved: ${limit.name} ${where} was ${beforeWords(limit, view, expected)}, and is ${after} now. ${how.reach} The change is recorded as approved, with your reason; the user can revert it on the Settings page.`,
            structured: settingsChangeOutput({
              view,
              changes: result.changes,
              unchanged: [],
              approval: APPROVED,
            }),
            details: {
              scope: view.scope,
              approval: { approved: true },
              agentChanges: agentChangeDetails(view, result.changes),
            },
          });
      }
    },

    declined: (args, view, answer) =>
      declinedAnswer(
        answer,
        `${spec.change} ${scopeWhere(view)}, from ${beforeWords(limit, view, answer.expected)} to ${spec.after(args, view)}`,
        (approval) => settingsChangeOutput({ view, changes: [], unchanged: [], approval }),
      ),
  };
};

/**
 * The core of a tool that sets `limit` to a value at one Scope: unchanged when the Limit has it already (`same` of the value
 * in force; at an Environment only as its Override, since an inherited value is not pinned).
 */
const setCore = <Args extends ScopedArgs>(
  services: SettingsCoreServices,
  {
    tool,
    limit,
    value,
    same,
    after,
  }: {
    readonly tool: string;
    readonly limit: SettingsLimit;
    readonly value: (args: Args) => Schema.Json | null;
    readonly same: (args: Args, stored: Schema.Json | null) => boolean;
    /** The value the Limit is set to, as the owner reads it. */
    readonly after: (args: Args) => string;
  },
): SettingsCore<Args> =>
  limitCore(services, {
    tool,
    limit,
    change: limit.change,
    fieldChange: (args) => ({ field: limit.field, value: value(args) }),
    after,
    unchanged: (args, view) => {
      const { stored, inherited } = limitNow(view, limit);

      return same(args, stored) && inherited !== true
        ? `${limit.name.replace(/^t/, "T")} ${scopeWhere(view)} is ${after(args)}${inherited === false ? " as its Override" : ""} already: nothing was asked, changed or recorded.`
        : undefined;
    },
  });

/** `settings_spend_limit_set`'s core. */
export const spendLimitCore = (services: SettingsCoreServices) =>
  setCore<{ readonly scope: string; readonly per_session: number | null; readonly reason: string }>(
    services,
    {
      tool: "settings_spend_limit_set",
      limit: SPEND_LIMIT,
      value: (args) => args.per_session,
      same: (args, stored) => stored === args.per_session,
      after: (args) => spendWords(args.per_session),
    },
  );

/** `settings_subagent_depth_set`'s core. */
export const subagentDepthCore = (services: SettingsCoreServices) =>
  setCore<{ readonly scope: string; readonly depth: number; readonly reason: string }>(services, {
    tool: "settings_subagent_depth_set",
    limit: DEPTH_LIMIT,
    value: (args) => args.depth,
    same: (args, stored) => depthOf(stored) === args.depth,
    after: (args) => depthWords(args.depth),
  });

/** `settings_subagent_workspaces_set`'s core. */
export const subagentWorkspacesCore = (services: SettingsCoreServices) =>
  setCore<{ readonly scope: string; readonly limit: number; readonly reason: string }>(services, {
    tool: "settings_subagent_workspaces_set",
    limit: WORKSPACES_LIMIT,
    value: (args) => args.limit,
    same: (args, stored) => workspacesOf(stored) === args.limit,
    after: (args) => workspacesWords(args.limit),
  });

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/**
 * The Limit that `settings_reset` takes back at `field`, or none when the field is not a Limit: a reset of any other
 * field is made at once, without asking.
 */
export const limitOfField = (field: string): Option.Option<SettingsLimit> =>
  Arr.findFirst(SETTINGS_LIMITS, (each) => each.field === field);

/** What a reset says when `field` is at its default at Global, or inherited at an Environment, already. */
export const resetAlready = (view: SettingsView, field: string): string => {
  const label = fieldLabel(field);

  return isGlobalView(view)
    ? `The ${label} is at its default at Global already: nothing was asked, changed or recorded.`
    : `${scopeName(view)} does not override the ${label}: it inherits Global already, so nothing was asked, changed or recorded.`;
};

/** Whether a reset of `field` has nothing to do at `view`'s Scope: at its default at Global, or not overridden at an Environment. */
export const resetIsDone = (view: SettingsView, field: string): boolean =>
  isGlobalView(view)
    ? sameJson(
        settingsFieldValue(view.settings, field),
        settingsFieldValue(DEFAULT_SETTINGS, field),
      )
    : Option.isNone(overrideValue(view.overrides, field));

/**
 * `settings_reset`'s core for a Limit (`limitOfField`): at Global it puts the field back to its default, at an Environment
 * it removes its Override, so it inherits Global again.
 */
export const resetLimitCore = (services: SettingsCoreServices, limit: SettingsLimit) =>
  limitCore<ScopedArgs>(services, {
    tool: "settings_reset",
    limit,
    change: `${limit.change}, reset`,
    fieldChange: () => ({ field: limit.field, value: null, reset: true }),
    after: (_args, view) =>
      isGlobalView(view)
        ? limit.byDefault
        : `${limit.words(settingsFieldValue(view.global, limit.field))}${inheritedWords(true)}`,
    unchanged: (_args, view) =>
      resetIsDone(view, limit.field) ? resetAlready(view, limit.field) : undefined,
  });

// ─── The Instructions ────────────────────────────────────────────────────────

/** The arguments of `settings_instructions_set`. */
export type InstructionsArgs = ScopedArgs & { readonly text: string };

/** The Instructions at `view`'s Scope: an Environment's own, which its settings carry Global's to add to. */
const instructionsAt = (view: SettingsView): string =>
  isGlobalView(view) ? view.settings.instructions : view.instructions;

/** `settings_instructions_set`'s core. */
export const instructionsCore = ({
  access,
  plainText,
}: SettingsCoreServices): SettingsCore<InstructionsArgs> => {
  const tool = "settings_instructions_set";

  return {
    tool,
    prepare: ({ scope, text, reason }) =>
      Effect.gen(function* () {
        yield* plainText(reason, "the reason", "Say why without it.");

        if (instructionsProblem(text) !== undefined) {
          return yield* SettingsAccessError.make({
            message: `Nothing was asked or saved: the Instructions are ${grouped(utf8Bytes(text))} bytes of UTF-8, and may be at most ${grouped(MAX_INSTRUCTIONS_BYTES)} (${MAX_INSTRUCTIONS_BYTES / 1024} KiB). Make them shorter.`,
          });
        }

        yield* plainText(
          text,
          "the text",
          "The Instructions are plain and every conversation is shown them: say it without the value.",
        );

        const view = yield* access.get(scope);
        const before = instructionsAt(view);

        return {
          card: {
            tool,
            target: settingsTarget(view),
            change: "Instructions",
            before: instructionsWords(before),
            after: instructionsWords(text),
            reason,
          },
          expected: before,
          known: view,
          unchanged:
            before === text
              ? {
                  text: `The Instructions ${scopeWhere(view)} have that text already: nothing was asked, changed or recorded.`,
                  structured: settingsChangeOutput({
                    view,
                    changes: [],
                    unchanged: [INSTRUCTIONS_FIELD],
                    approval: null,
                  }),
                  details: {
                    scope: view.scope,
                    unchanged: [INSTRUCTIONS_FIELD],
                    agentChanges: [],
                  },
                }
              : undefined,
        };
      }),

    apply: ({ scope, text }, expected, author, known) =>
      Effect.gen(function* () {
        const view = known ?? (yield* access.get(scope));

        const result = yield* access.change({
          scope: view.scope,
          changes: [{ field: INSTRUCTIONS_FIELD, value: text, expected: { value: expected } }],
          author: { ...author, approved: true },
        });

        return { known: view, result };
      }),

    render: ({ text }, _expected, { known: view, result }) => {
      const where = scopeWhere(view);

      switch (result.status) {
        case "rejected":
          return Effect.fail(
            SettingsAccessError.make({
              message: `The user approved, but nothing was saved: ${result.message}`,
            }),
          );
        case "changed-since":
          return Effect.fail(
            SettingsAccessError.make({
              message: changedSince(
                `the Instructions ${where}`,
                Predicate.isString(result.current) && result.current !== ""
                  ? `${textSize(result.current)} long`
                  : "none",
              ),
            }),
          );
        case "unchanged":
          return Effect.succeed({
            text: approvedAlready(`the Instructions ${where} have that text`),
            structured: settingsChangeOutput({
              view,
              changes: [],
              unchanged: [INSTRUCTIONS_FIELD],
              approval: APPROVED,
            }),
            details: { scope: view.scope, approval: { approved: true }, agentChanges: [] },
          });
        case "changed": {
          const shownTo = isGlobalView(view)
            ? "Every conversation is shown them"
            : "Every conversation of its Sessions is shown them after the Global ones";

          const stopped = isGlobalView(view)
            ? "Conversations stop being shown them"
            : "Its Sessions' conversations stop being shown them";

          const done =
            text === ""
              ? `are removed. ${stopped} ${instructionsApply("their")}`
              : `are changed (${textSize(text)} now). ${shownTo} ${instructionsApply("its")}`;

          return Effect.succeed({
            text: `The user approved: the Instructions ${where} ${done} The change is recorded as approved, with your reason; the user can revert it on the Settings page.`,
            structured: settingsChangeOutput({
              view,
              changes: result.changes,
              unchanged: [],
              approval: APPROVED,
            }),
            details: {
              scope: view.scope,
              approval: { approved: true },
              agentChanges: agentChangeDetails(view, result.changes),
            },
          });
        }
      }
    },

    declined: ({ text }, view, answer) =>
      declinedAnswer(
        answer,
        text === ""
          ? `removing the Instructions ${scopeWhere(view)}`
          : `the new text of the Instructions ${scopeWhere(view)}`,
        (approval) => settingsChangeOutput({ view, changes: [], unchanged: [], approval }),
      ),
  };
};
