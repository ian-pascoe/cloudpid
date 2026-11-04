// What a composer does with an MCP prompt it is offered (`docs/architecture/mcp-in-a-session.md` → Arguments and
// completions): a pick opens its form or, with no arguments, is the chip at once; Done makes the chip of the form's
// values; the chip edits through the form again. Shared by the Session's composer and the draft's.

import type { Catalog, McpPromptEntry } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ComposerState } from "./composer-state.ts";
import { chipStanding, needsForm, promptWaitingFor, startingValues } from "./mcp-prompt-state.ts";

/** The composer's chip and form, and what the owner does with them. */
export const usePromptChip = ({
  state,
  catalog,
  focusInput,
  clearNote,
  reviewing = false,
}: {
  state: ComposerState;
  /** The catalog as the composer has it: the prompt a chip names may have gone from it. */
  catalog: Catalog | null;
  /** Give the focus back to the input (a frame later when a form just unmounted). */
  focusInput: () => void;
  /** Take the note under the composer away: the owner is acting on it. */
  clearNote?: () => void;
  /** Whether the message is a Review of drafts, which no MCP prompt goes with. */
  reviewing?: boolean;
}) => {
  const chip = useAtomValue(state.chip);
  const setChip = useAtomSet(state.chip);
  const [form, setForm] = useAtom(state.form);
  const standing = chip === null ? null : chipStanding(chip, catalog);

  return {
    chip,
    setChip,
    form,
    setForm,
    standing,
    /** Why the message cannot be sent while the prompt is in the composer, or null (`promptWaitingFor`). */
    promptWaiting: promptWaitingFor({ form, chip, standing, reviewing }),
    /** Why the chip cannot be sent, when its prompt has gone from the catalog: for the chip to say. */
    gone: standing?.kind === "gone" ? standing.message : undefined,
    /** An MCP prompt picked from the menu: its form opens, or, with no arguments, it is the chip at once. */
    pickPrompt: (prompt: McpPromptEntry) => {
      clearNote?.();

      if (needsForm(prompt)) {
        setForm({ prompt, values: startingValues(prompt) });

        return;
      }

      setChip({ prompt, values: {} });
      setForm(null);
      focusInput();
    },
    /** Done: the form's values are the chip's. */
    finishForm: () => {
      if (form === null) return;

      setChip({ prompt: form.prompt, values: form.values });
      setForm(null);
      clearNote?.();
      focusInput();
    },
    cancelForm: () => {
      setForm(null);
      focusInput();
    },
    /** Open the chip's form again, on the prompt as the catalog has it now. */
    editChip: () => {
      if (chip === null) return;

      const prompt = standing === null || standing.kind === "gone" ? chip.prompt : standing.prompt;

      setForm({ prompt, values: startingValues(prompt, chip.values) });
    },
  };
};
