// @effect-diagnostics missingPipeableSignature:off
// The `instructions` extension (docs/architecture/workspace.md → Filesystem and tools → Instructions, ADR-0027): the
// owner's Instructions (`GLOSSARY.md` → Instructions), which they keep in the Settings, in front of every conversation's
// model, subagents included, as a system prompt section of their own before `project_context` (the Session installs
// this extension just before `agents-md`). The section is read once per Context Window and then shown as it was
// (`frozenSection`, as `project_context` and `skills` are): an edit of the Instructions applies from a Session's next
// Context Window (a new Session, a Handoff, a Rollover), never inside one, since a changed section would rewrite the
// system prompt, the head of the provider's cache prefix. With no Instructions the section is kept empty, not absent:
// it adds nothing to the prompt's text (pi-ai leaves empty parts out), and an edit made later is not added mid-context
// as a patch, which an absent section would be once it had text.
import { frozenSection } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const extensionName = "instructions";

/** The section's key; also the tag that wraps its text. pi-durable keeps `instructions` for an agent's own. */
export const SECTION_KEY = "owner_instructions";

/** The Instructions in force for a Session's conversations, by Scope: the Global ones (empty for none). */
export type InstructionsInForce = {
  readonly global: string;
};

/** The Instructions as the Session last read its Settings: synchronous, as the section reads them. */
export class InstructionsSettings extends Context.Service<
  InstructionsSettings,
  { readonly current: () => InstructionsInForce }
>()("@cloudpid/extensions/instructions/InstructionsSettings") {}

/** What the section says before the Instructions: whose they are, and which wins where they disagree. */
export const SECTION_INTRODUCTION =
  "Instructions the owner keeps in the Settings for every conversation. Follow them. Where they disagree with the Project instructions from AGENTS.md files below, the Project instructions win: they are nearer to the work.";

/** One Scope's Instructions as the section shows them. */
const formatScope = (scope: string, text: string): string =>
  `<instructions scope="${scope}">\n${text}\n</instructions>`;

/** The section's text for `instructions`: empty when there are none, so the section adds nothing to the prompt. */
export const formatSection = (instructions: InstructionsInForce): string => {
  const shown = Arr.filter(
    [{ scope: "Global", text: instructions.global }],
    ({ text }) => text.trim() !== "",
  );

  return shown.length === 0
    ? ""
    : `<${SECTION_KEY}>\n${SECTION_INTRODUCTION}\n\n${Arr.join(
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
