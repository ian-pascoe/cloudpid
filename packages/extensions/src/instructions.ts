// @effect-diagnostics missingPipeableSignature:off
// The `instructions` extension (docs/architecture/workspace.md → Filesystem and tools → Instructions, ADR-0027): the
// owner's Instructions (`GLOSSARY.md` → Instructions), which they keep in the Settings, in front of every conversation's
// model, subagents included, as a system prompt section of their own before `project_context` (the Session installs
// this extension just before `agents-md`). They add up rather than being overridden: the Global ones, then the
// Environment's, each under a heading naming its Scope, so the nearer comes later and wins where two disagree. The
// section is read once per Context Window and then shown as it was (`frozenSection`, as `project_context` and `skills` are): an edit of the Instructions applies from a Session's next
// Context Window (a new Session, a Handoff, a Rollover), never inside one, since a changed section would rewrite the
// system prompt, the head of the provider's cache prefix. With no Instructions the section is kept empty, not absent:
// it adds nothing to the prompt's text (pi-ai leaves empty parts out), and an edit made later is not added mid-context
// as a patch, which an absent section would be once it had text.
import { frozenSection } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const extensionName = "instructions";

/** The section's key; also the tag that wraps its text. pi-durable keeps `instructions` for an agent's own. */
export const SECTION_KEY = "owner_instructions";

/** An Environment's own Instructions (empty text for none), by its name, which their heading shows. */
export type EnvironmentInstructions = { readonly name: string; readonly text: string };

/**
 * The Instructions in force for a Session's conversations, by Scope: the Global ones (empty for none), and those of the
 * Session's Environment, by its name (none, or empty text, for an Environment with none).
 */
export type InstructionsInForce = {
  readonly global: string;
  readonly environment?: EnvironmentInstructions | undefined;
};

/** The Instructions as the Session last read its Settings: synchronous, as the section reads them. */
export class InstructionsSettings extends Context.Service<
  InstructionsSettings,
  { readonly current: () => InstructionsInForce }
>()("@cloudpid/extensions/instructions/InstructionsSettings") {}

/** What the section says before the Global Instructions alone: whose they are, and that the Project instructions win. */
export const SECTION_INTRODUCTION =
  "Instructions the owner keeps in the Settings for every conversation. Follow them. Where they disagree with the Project instructions from AGENTS.md files below, the Project instructions win: they are nearer to the work.";

/**
 * What the section says before Instructions that include this Environment's own: each block's Scope, and that the nearer
 * wins where two disagree.
 */
export const ENVIRONMENT_SECTION_INTRODUCTION =
  "Instructions the owner keeps in the Settings, each block under its Scope: the Global ones are for every conversation, this Environment's for its conversations. Follow them. Where two disagree, the nearer wins: this Environment's win over the Global ones, and the Project instructions from AGENTS.md files below win over both, as they are nearer to the work.";

/** The Global Instructions' heading. */
const GLOBAL_SCOPE_NAME = "Global";

/** `text` as an XML attribute's value holds it. */
const attribute = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** One Scope's Instructions as the section shows them, under a heading naming the Scope; `settings_get` shows them so too. */
export const formatScope = (scope: string, text: string): string =>
  `<instructions scope="${attribute(scope)}">\n${text}\n</instructions>`;

/** The section's text for `instructions`: empty when there are none, so the section adds nothing to the prompt. */
export const formatSection = (instructions: InstructionsInForce): string => {
  const { environment } = instructions;

  const shown = Arr.filter(
    [
      { scope: GLOBAL_SCOPE_NAME, text: instructions.global },
      ...(environment === undefined
        ? []
        : [{ scope: `Environment ${environment.name}`, text: environment.text }]),
    ],
    ({ text }) => text.trim() !== "",
  );

  // The Environment's block, shown last when it has text, is the only one that is not Global's.
  const introduction = Arr.last(shown).pipe(
    Option.exists(({ scope }) => scope !== GLOBAL_SCOPE_NAME),
  )
    ? ENVIRONMENT_SECTION_INTRODUCTION
    : SECTION_INTRODUCTION;

  return shown.length === 0
    ? ""
    : `<${SECTION_KEY}>\n${introduction}\n\n${Arr.join(
        Arr.map(shown, ({ scope, text }) => formatScope(scope, text)),
        "\n\n",
      )}\n</${SECTION_KEY}>`;
};

/** The `instructions` extension: the section, over the Instructions the Session last read (`InstructionsSettings`). */
export const Instructions: Effect.Effect<Extension, never, InstructionsSettings> = Effect.gen(
  function* () {
    const settings = yield* InstructionsSettings;

    const section = yield* frozenSection(SECTION_KEY, () =>
      Effect.sync(() => formatSection(settings.current())),
    );

    return defineExtension({ name: extensionName, sections: [section] });
  },
);
