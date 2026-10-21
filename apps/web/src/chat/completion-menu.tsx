// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays are the platform here.

import { useEffect } from "react";
import { cn } from "../lib/utils.ts";

/** One row of the menu: what is picked, the argument it takes, and what it does. */
export type CompletionRow = {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly description?: string | undefined;
};

/** A labelled group of rows: Commands, Prompt templates, Skills, Files. */
export type CompletionSection = {
  readonly label: string;
  readonly rows: readonly CompletionRow[];
};

/** The id of row `index` of the menu `menuId`, for the input's `aria-activedescendant`. */
export const rowId = (menuId: string, index: number): string => `${menuId}-row-${index}`;

/**
 * The composer's completion menu: a listbox that rises from the composer's top edge, at its width. The input keeps the
 * focus throughout (the owner types on while it is open), so a row is picked with the keys the composer handles, or a
 * click that does not take the focus from the input.
 */
export const CompletionMenu = ({
  id,
  label,
  sections,
  highlighted,
  onHighlight,
  onPick,
}: {
  id: string;
  /** What the list holds, for assistive technology: "Commands", "Skills", "Files". */
  label: string;
  sections: readonly CompletionSection[];
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
      id={id}
      role="listbox"
      aria-label={label}
      // The input keeps the focus: a press on the menu must not take it.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      className={cn(
        "absolute inset-x-0 bottom-full z-10 mb-2 max-h-[min(18rem,45dvh)] overflow-y-auto overscroll-contain rounded-lg border bg-background p-1 shadow-sm",
        "motion-safe:transition-[opacity,translate] motion-safe:duration-150 motion-safe:ease-out motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0",
      )}
    >
      {sections.map((section) => (
        <div key={section.label} role="group" aria-label={section.label}>
          <div
            aria-hidden
            className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground select-none"
          >
            {section.label}
          </div>
          {section.rows.map((row) => {
            const at = index;

            index += 1;

            return (
              <div
                key={row.id}
                id={rowId(id, at)}
                role="option"
                aria-selected={at === highlighted}
                onMouseMove={() => {
                  if (at !== highlighted) onHighlight(at);
                }}
                onClick={() => {
                  onPick(at);
                }}
                className="flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 select-none aria-selected:bg-accent aria-selected:text-accent-foreground pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                <span className="shrink-0 font-mono text-[0.8125rem]">{row.label}</span>
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
  );
};
