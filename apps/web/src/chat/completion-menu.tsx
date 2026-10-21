import { useEffect } from "react";
import * as Arr from "effect/Array";
import { cn } from "../lib/utils.ts";

/** One row of the menu: what is picked, the argument it takes, and what it does. */
export type CompletionRow = {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly description?: string | undefined;
  /** What `label` is in, such as a file's folder: muted after it, and cut from its start when the menu is narrow. */
  readonly detail?: string | undefined;
};

/** A labelled group of rows: Commands, Prompt templates, Skills, Files. */
export type CompletionSection = {
  readonly label: string;
  readonly rows: readonly CompletionRow[];
};

/** The id of row `index` of the menu `menuId`, for the input's `aria-activedescendant`. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain id helper, not a combinator.
export const rowId = (menuId: string, index: number): string => `${menuId}-row-${index}`;

/**
 * The composer's completion menu: a listbox that rises from the composer's top edge, at its width. The input keeps the
 * focus throughout (the owner types on while it is open), so a row is picked with the keys the composer handles, or a
 * click that does not take the focus from the input. With no rows, it shows `notice` (searching, nothing found) in a
 * live region beside the list, which cannot be picked and is announced as it changes.
 */
export const CompletionMenu = ({
  id,
  label,
  sections,
  notice,
  highlighted,
  onHighlight,
  onPick,
}: {
  id: string;
  /** What the list holds, for assistive technology: "Commands", "Skills", "Files". */
  label: string;
  sections: readonly CompletionSection[];
  /** What the menu says in place of rows when it has none. */
  notice?: string | undefined;
  /** The highlighted row, counted across sections. */
  highlighted: number;
  onHighlight: (index: number) => void;
  onPick: (index: number) => void;
}) => {
  useEffect(() => {
    document.getElementById(rowId(id, highlighted))?.scrollIntoView({ block: "nearest" });
  }, [id, highlighted]);

  let index = 0;

  return (
    <div
      // The input keeps the focus: a press on the menu must not take it.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      className={cn(
        "absolute inset-x-0 bottom-full z-10 mb-2 max-h-[min(18rem,45dvh)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border bg-background p-1 shadow-sm",
        "motion-safe:transition-[opacity,translate] motion-safe:duration-150 motion-safe:ease-out motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0",
      )}
    >
      {sections.length > 0 && (
        <div id={id} role="listbox" aria-label={label}>
          {Arr.map(sections, (section) => (
            <div key={section.label} role="group" aria-label={section.label}>
              <div
                aria-hidden
                className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground select-none"
              >
                {section.label}
              </div>
              {Arr.map(section.rows, (row) => {
                const at = index;

                index += 1;

                return (
                  <div
                    key={row.id}
                    id={rowId(id, at)}
                    role="option"
                    aria-selected={at === highlighted}
                    aria-label={row.detail === undefined ? undefined : `${row.detail}${row.label}`}
                    onMouseMove={() => {
                      if (at !== highlighted) onHighlight(at);
                    }}
                    onClick={() => {
                      onPick(at);
                    }}
                    className="flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 select-none aria-selected:bg-accent aria-selected:text-accent-foreground pointer-coarse:min-h-11 pointer-coarse:items-center"
                  >
                    <span className="max-w-full shrink-0 truncate font-mono text-[0.8125rem]">
                      {row.label}
                    </span>
                    {row.detail !== undefined && (
                      // Cut from its start, so the end nearest the name stays: `…web/src/chat/`.
                      <span className="min-w-0 truncate text-left font-mono text-xs text-muted-foreground [direction:rtl]">
                        <bdi dir="ltr">{row.detail}</bdi>
                      </span>
                    )}
                    {row.hint !== undefined && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {row.hint}
                      </span>
                    )}
                    {row.description !== undefined && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {row.description}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {/* Announced as it changes: "Searching files…", then "No matching files or folders.". */}
      <div
        role="status"
        aria-live="polite"
        className={
          sections.length === 0 && notice !== undefined
            ? "px-2.5 py-1.5 text-xs text-muted-foreground select-none pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            : "sr-only"
        }
      >
        {sections.length === 0 ? notice : undefined}
      </div>
    </div>
  );
};
