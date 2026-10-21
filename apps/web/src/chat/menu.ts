// What the composer's menu lists for a trigger: the Slash commands, Prompt templates and Skills whose names match what
// is typed after `/`, a command's argument values, or the Skills after `$`. Pure, so the composer only renders it.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- browser code with no Effect runtime: native arrays are the platform here, and these are plain functions, not combinators.

import { type CatalogEntry, rank } from "@cloudpid/protocol";
import type { ComposerCommand } from "./commands.ts";
import type { CompletionRow, CompletionSection } from "./completion-menu.tsx";
import type { Trigger } from "./completion.ts";

/** What a pick from the menu does: put text in place of the trigger, or run a command at once. */
export type MenuPick =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "run"; readonly command: ComposerCommand; readonly args: string };

export type MenuEntry = CompletionRow & { readonly pick: MenuPick };

export type Completion = {
  /** What the list holds, for assistive technology. */
  readonly label: string;
  readonly sections: readonly CompletionSection[];
  /** Every row, across the sections, in order. */
  readonly entries: readonly MenuEntry[];
};

/** The Prompt templates and Skills of the conversation's directory, as far as the Session has said. */
export type MenuCatalog = {
  readonly templates: readonly CatalogEntry[];
  readonly skills: readonly CatalogEntry[];
};

const NO_CATALOG: MenuCatalog = { templates: [], skills: [] };

/** The menu of `sections`, leaving out those with no rows; null when none has any. */
const menu = (
  label: string,
  sections: readonly { readonly label: string; readonly rows: readonly MenuEntry[] }[],
): Completion | null => {
  const shown = sections.filter((section) => section.rows.length > 0);

  return shown.length === 0
    ? null
    : { label, sections: shown, entries: shown.flatMap((section) => section.rows) };
};

/**
 * The menu for `trigger`. After `/`: the commands whose names match, then the Prompt templates, then the Skills as
 * `/skill:name`. After a command's name: the values its argument takes. After `$`: the Skills alone, and no menu when
 * none matches, so `$HOME` types on undisturbed.
 */
export const completionFor = (
  trigger: Trigger,
  commands: readonly ComposerCommand[],
  catalog: MenuCatalog = NO_CATALOG,
): Completion | null => {
  if (trigger.kind === "command") {
    return menu("Commands", [
      {
        label: "Commands",
        rows: rank(trigger.query, commands, ({ name }) => name).map((command): MenuEntry => ({
          id: `command:${command.name}`,
          label: `/${command.name}`,
          hint: command.argumentHint,
          description: command.description,
          // A command without an argument runs as it is picked; one with an argument waits for it.
          pick:
            command.argument === "none"
              ? { kind: "run", command, args: "" }
              : { kind: "insert", text: `/${command.name}` },
        })),
      },
      {
        label: "Prompt templates",
        rows: rank(trigger.query, catalog.templates, ({ name }) => name).map(
          (template): MenuEntry => ({
            id: `template:${template.name}`,
            label: `/${template.name}`,
            hint: template.argumentHint,
            description: template.description,
            pick: { kind: "insert", text: `/${template.name}` },
          }),
        ),
      },
      {
        label: "Skills",
        rows: rank(trigger.query, catalog.skills, ({ name }) => `skill:${name}`).map(
          (skill): MenuEntry => ({
            id: `skill:${skill.name}`,
            label: `/skill:${skill.name}`,
            hint: skill.argumentHint,
            description: skill.description,
            pick: { kind: "insert", text: `/skill:${skill.name}` },
          }),
        ),
      },
    ]);
  }

  if (trigger.kind === "argument") {
    const command = commands.find(({ name }) => name === trigger.command);

    if (command?.choices === undefined) return null;

    const label = `/${command.name}`;

    return menu(label, [
      {
        label,
        rows: rank(trigger.query, command.choices, ({ value }) => value).map(
          (choice): MenuEntry => ({
            id: `choice:${choice.value}`,
            label: choice.value,
            description: choice.description,
            pick: { kind: "run", command, args: choice.value },
          }),
        ),
      },
    ]);
  }

  if (trigger.kind === "skill") {
    return menu("Skills", [
      {
        label: "Skills",
        rows: rank(trigger.query, catalog.skills, ({ name }) => name).map((skill): MenuEntry => ({
          id: `skill:${skill.name}`,
          label: `$${skill.name}`,
          description: skill.description,
          pick: { kind: "insert", text: `$${skill.name}` },
        })),
      },
    ]);
  }

  return null;
};
