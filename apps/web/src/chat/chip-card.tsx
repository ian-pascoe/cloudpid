// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The chips above the composer's input and under an owner's message that stand for something attached to it: a page, an
// MCP resource. The composer's chip (`ComposerChip`) has its button that removes it; the transcript's (`SentChip`) has a
// line of its own for what became of it.

import { X } from "lucide-react";
import type { ReactNode } from "react";

/** The row of chips above the composer's input; nothing for none. */
export const ChipList = ({
  label,
  empty,
  children,
}: {
  label: string;
  empty: boolean;
  children: ReactNode;
}) =>
  empty ? null : (
    <ul
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions"
      className="flex flex-wrap gap-2 px-2.5 pt-2.5"
    >
      {children}
    </ul>
  );

/** The grey square a chip's icon sits in. */
export const ChipIcon = ({ children }: { children: ReactNode }) => (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
    {children}
  </span>
);

/** One chip of the composer: what leads it (an icon or a thumbnail), its title, a line under it, and the button that removes it. */
export const ComposerChip = ({
  lead,
  title,
  tooltip,
  note,
  removeLabel,
  onRemove,
}: {
  lead: ReactNode;
  title: string;
  /** The title's tooltip: the whole of what it is, when the title is short. */
  tooltip: string;
  note: ReactNode;
  removeLabel: string;
  onRemove: () => void;
}) => (
  <li className="relative flex h-12 max-w-full min-w-0 items-center gap-2 rounded-md border bg-background pr-8 pl-2">
    {lead}
    <div className="min-w-0 flex-1">
      <p className="max-w-64 truncate text-sm" title={tooltip}>
        {title}
      </p>
      <p className="max-w-64 truncate text-xs text-muted-foreground">{note}</p>
    </div>
    <button
      type="button"
      aria-label={removeLabel}
      title={removeLabel}
      onClick={onRemove}
      className="group absolute -top-1.5 -right-1.5 z-10 inline-flex size-11 items-center justify-center text-muted-foreground outline-none pointer-fine:pointer-events-none"
    >
      <span className="pointer-events-auto inline-flex size-5 items-center justify-center rounded-full border bg-background transition-colors group-hover:bg-accent group-hover:text-accent-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <X className="size-3" aria-hidden />
      </span>
    </button>
  </li>
);

/** One chip of an owner's message: its icon, its title (with a tooltip), a line under it, and what more it has to say. */
export const SentChip = ({
  icon,
  title,
  tooltip,
  note,
  children,
}: {
  icon: ReactNode;
  title: string;
  tooltip: string;
  note: string;
  children?: ReactNode;
}) => (
  <li className="rounded-md border bg-background px-2.5 py-1.5 text-sm whitespace-normal">
    <div className="flex items-center gap-2">
      {icon}
      <span className="min-w-0">
        <span className="block truncate" title={tooltip}>
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{note}</span>
      </span>
    </div>
    {children}
  </li>
);
