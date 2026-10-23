// A composer's completion menu over its state (`composerState`): what the menu lists for the trigger at the caret
// (`completionFor`), which row is highlighted, what a pick does, and what the keys do while it is open. Shared by the
// Session's composer and the draft's, which differ only in where the catalog and the files come from.

// @effect-diagnostics preferEffectArray:off -- the menu's rows are native arrays.

import { useAtom, useAtomValue } from "@effect/atom-react";
import { type KeyboardEvent, useId } from "react";
import type { ComposerCommand } from "./commands.ts";
import { rowId } from "./completion-menu.tsx";
import { type Edited, replaceTrigger } from "./completion.ts";
import type { ComposerState } from "./composer-state.ts";
import {
  type Completion,
  completionFor,
  type FileResults,
  type MenuCatalog,
  menuKey,
} from "./menu.ts";

export type CompletionOptions = {
  readonly state: ComposerState;
  /** The Slash commands the composer runs itself. */
  readonly commands: readonly ComposerCommand[];
  /** The Prompt templates and Skills, once they are known. */
  readonly catalog: MenuCatalog | undefined;
  /** The answers to the `@` menu (`fileResults`). */
  readonly files: FileResults;
  /** Put a pick's text in the composer, the caret where it goes. */
  readonly edit: (next: Edited) => void;
  /** Run a command picked from the menu; absent where the composer runs none. */
  readonly run?: (command: ComposerCommand, args: string) => void;
};

export type CompletionMenuState = {
  /** The id of the menu's list, for the input's `aria-controls`. */
  readonly id: string;
  /** What the open menu lists; null while it is closed. */
  readonly menu: Completion | null;
  /** The highlighted row, counted across sections: the first when the one highlighted is gone. */
  readonly active: number;
  readonly highlight: (index: number) => void;
  readonly pick: (index: number) => void;
  /** The menu's part in a key pressed in the input: true when it took the key, which then does nothing else. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The input's ARIA attributes for the menu it controls. */
  readonly inputProps: {
    readonly "aria-autocomplete": "list";
    readonly "aria-controls": string | undefined;
    readonly "aria-expanded": boolean;
    readonly "aria-activedescendant": string | undefined;
  };
};

/**
 * The completion menu of the composer whose state is `state`. Its menu is shown for a trigger the owner has not
 * dismissed (Escape) while it has rows or a notice. A command picked runs; anything else takes the trigger's place.
 */
export const useCompletion = ({
  state,
  commands,
  catalog,
  files,
  edit,
  run,
}: CompletionOptions): CompletionMenuState => {
  const id = useId();
  const text = useAtomValue(state.text);
  const trigger = useAtomValue(state.trigger);
  const [dismissed, setDismissed] = useAtom(state.dismissed);
  const [highlighted, setHighlighted] = useAtom(state.highlighted);

  const completion =
    trigger === null || trigger.start === dismissed
      ? null
      : completionFor(trigger, commands, catalog, files);

  const menu =
    completion !== null && (completion.entries.length > 0 || completion.notice !== undefined)
      ? completion
      : null;

  const entries = menu?.entries ?? [];

  const active = Math.max(
    0,
    entries.findIndex((entry) => entry.id === highlighted),
  );

  const highlight = (index: number) => {
    setHighlighted(entries[index]?.id ?? null);
  };

  const pick = (index: number) => {
    const entry = entries[index];

    if (entry === undefined || trigger === null) return;

    if (entry.pick.kind === "run") run?.(entry.pick.command, entry.pick.args);
    else {
      edit(
        replaceTrigger(text, trigger, entry.pick.text, { space: entry.pick.continues !== true }),
      );
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (menu === null || trigger === null || event.nativeEvent.isComposing) return false;

    const count = entries.length;
    const action = menuKey(event, count);

    if (action === null) return false;

    event.preventDefault();

    if (action === "close") setDismissed(trigger.start);
    else if (action === "pick") pick(active);
    else highlight((active + (action === "next" ? 1 : count - 1)) % count);

    return true;
  };

  const listed = entries.length > 0;

  return {
    id,
    menu,
    active,
    highlight,
    pick,
    onKeyDown,
    inputProps: {
      "aria-autocomplete": "list",
      "aria-controls": listed ? id : undefined,
      "aria-expanded": listed,
      "aria-activedescendant": listed ? rowId(id, active) : undefined,
    },
  };
};
