// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The composer's attached pages (`docs/architecture/client-and-protocol.md` → Attached pages): a chip per Owner tab attached to the message, above the
// Attachments' tiles, removable before sending, with a thumbnail of its screen when it carries one; and the toolbar's
// button that attaches a page, offering the Session's Owner tabs in a menu with the one shown first. The button is there
// only while the Session has Owner tabs.

import { RegistryContext, useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";
import { Globe, ImageOff, X } from "lucide-react";
import { Menu, MenuItem, MenuLabel } from "../components/ui/menu.tsx";
import { ownerTabsAtom } from "../session/atoms.ts";
import { latestScreenAtom } from "../live-view/owner-tab-screen.ts";
import { askOwnerTabsAtom, offeredPages, pageLabel, toAttach } from "./attached-pages.ts";
import type { AttachmentsState, PageToAttach } from "./attachments-state.ts";
import { screenNote } from "./attachments-state.ts";

/** The chips of the pages attached to the message, each with a button that removes it. */
export const PageChips = ({
  state,
  onRemove,
}: {
  state: AttachmentsState;
  onRemove: (ownerTabId: string) => void;
}) =>
  state.pages.length === 0 ? null : (
    <ul
      aria-label="Attached pages"
      aria-live="polite"
      aria-relevant="additions"
      className="flex flex-wrap gap-2 px-2.5 pt-2.5"
    >
      {state.pages.map((chip) => {
        const label = pageLabel(chip);
        const screen = state.items.find((item) => item.id === chip.screenId);
        const note = screenNote(state, chip);

        return (
          <li
            key={chip.ownerTabId}
            className="relative flex h-12 max-w-full min-w-0 items-center gap-2 rounded-md border bg-background pr-8 pl-2"
          >
            {screen?.preview !== undefined && note === undefined ? (
              <img
                src={screen.preview}
                alt=""
                className="size-8 shrink-0 rounded-sm border object-cover object-top"
              />
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Globe className="size-4" aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="max-w-64 truncate text-sm" title={label}>
                {label}
              </p>
              <p className="max-w-64 truncate text-xs text-muted-foreground">
                {note === undefined ? (
                  <>{chip.screenId === undefined ? "Open page" : "Open page · with its screen"}</>
                ) : (
                  <>
                    <ImageOff className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                    {note}
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              aria-label={`Remove page ${label}`}
              title={`Remove page ${label}`}
              onClick={() => {
                onRemove(chip.ownerTabId);
              }}
              className="group absolute -top-1.5 -right-1.5 z-10 inline-flex size-11 items-center justify-center text-muted-foreground outline-none pointer-fine:pointer-events-none"
            >
              <span className="pointer-events-auto inline-flex size-5 items-center justify-center rounded-full border bg-background transition-colors group-hover:bg-accent group-hover:text-accent-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <X className="size-3" aria-hidden />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

/**
 * The toolbar's page button: a menu of the Session's Owner tabs, the one the Browser Pane shows first (and focused, so
 * Enter attaches it), a check on the ones attached; picking one attaches it, or takes it off again. The list is asked
 * again each time the menu opens. Nothing while the Session has no Owner tab.
 */
export const AttachPageButton = ({
  sessionId,
  attached,
  onAttach,
  onDetach,
}: {
  sessionId: string;
  /** The Owner tabs attached now. */
  attached: ReadonlySet<string>;
  onAttach: (page: PageToAttach) => void;
  onDetach: (ownerTabId: string) => void;
}) => {
  const asking = askOwnerTabsAtom(sessionId);

  useAtomMount(asking);

  const pages = offeredPages(useAtomValue(ownerTabsAtom(sessionId)));
  const refresh = useAtomRefresh(asking);
  const registry = useContext(RegistryContext);

  if (pages.length === 0) return null;

  return (
    <Menu
      label="Attach a page"
      title="Attach an open page"
      icon={<Globe className="size-4" aria-hidden />}
      className="touch-target"
      menuClassName="max-w-80"
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <MenuLabel>Attach an open page</MenuLabel>
      {pages.map((page) => (
        <MenuItem
          key={page.ownerTabId}
          checked={attached.has(page.ownerTabId)}
          onSelect={() => {
            if (attached.has(page.ownerTabId)) onDetach(page.ownerTabId);
            else onAttach(toAttach(page, registry.get(latestScreenAtom(sessionId))));
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{pageLabel(page)}</span>
            {page.shown ? (
              <span className="block truncate text-xs text-muted-foreground">
                Shown in the Browser Pane
              </span>
            ) : null}
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
};
