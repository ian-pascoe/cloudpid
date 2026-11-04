// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The composer's attached pages (`docs/architecture/client-and-protocol.md` → Attached pages): a chip per Owner tab attached to the message, above the
// Attachments' tiles, removable before sending, with a thumbnail of its screen when it carries one; and the toolbar's
// button that attaches a page, offering the Session's Owner tabs in a menu with the one shown first. The button is there
// only while the Session has Owner tabs.

import { RegistryContext, useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";
import { Globe, ImageOff } from "lucide-react";
import { Menu, MenuItem, MenuLabel } from "../components/ui/menu.tsx";
import { ownerTabsAtom } from "../session/atoms.ts";
import { latestScreenAtom } from "../live-view/owner-tab-screen.ts";
import { askOwnerTabsAtom, offeredPages, pageLabel, toAttach } from "./attached-pages.ts";
import type { AttachmentsState, PageToAttach } from "./attachments-state.ts";
import { screenNote } from "./attachments-state.ts";
import { ChipIcon, ChipList, ComposerChip } from "./chip-card.tsx";

/** The chips of the pages attached to the message, each with a button that removes it. */
export const PageChips = ({
  state,
  onRemove,
}: {
  state: AttachmentsState;
  onRemove: (ownerTabId: string) => void;
}) => (
  <ChipList label="Attached pages" empty={state.pages.length === 0}>
    {state.pages.map((chip) => {
      const label = pageLabel(chip);
      const screen = state.items.find((item) => item.id === chip.screenId);
      const note = screenNote(state, chip);

      return (
        <ComposerChip
          key={chip.ownerTabId}
          lead={
            screen?.preview !== undefined && note === undefined ? (
              <img
                src={screen.preview}
                alt=""
                className="size-8 shrink-0 rounded-sm border object-cover object-top"
              />
            ) : (
              <ChipIcon>
                <Globe className="size-4" aria-hidden />
              </ChipIcon>
            )
          }
          title={label}
          tooltip={label}
          note={
            note === undefined ? (
              <>{chip.screenId === undefined ? "Open page" : "Open page · with its screen"}</>
            ) : (
              <>
                <ImageOff className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                {note}
              </>
            )
          }
          removeLabel={`Remove page ${label}`}
          onRemove={() => {
            onRemove(chip.ownerTabId);
          }}
        />
      );
    })}
  </ChipList>
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
