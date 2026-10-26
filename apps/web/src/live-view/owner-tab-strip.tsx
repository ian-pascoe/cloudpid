// @effect-diagnostics preferEffectArray:off -- a handful of tabs, mapped to elements.
// The Browser Pane's tab strip (#239): each Owner tab by its title with the one shown marked, a close button on each, and
// **+** for a new blank one. Which tab is shown is the Session's (the browser host's), so switching here switches the
// owner's other devices too; the Pane's connection follows what the Session says (`followOwnerTabAtom`), not the click.
// The titles are the pages' own: page content, shown as text. A tab a `browser` run is driving says so, shown or not.

import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Bot, Plus, X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Button } from "../components/ui/button.tsx";
import { settledFailureOf } from "../registry.ts";
import { ownerTabDriversAtom } from "../session/atoms.ts";
import {
  type BrowserPaneKey,
  ownerTabCommandAtom,
  ownerTabListAtom,
} from "./browser-pane-atoms.ts";
import { stripOf } from "./owner-tab-strip-model.ts";

/**
 * The tab strip of the Browser Pane `pane`. `onNew` runs when **+** is pressed, before the Session is asked: the Pane
 * focuses the URL bar once the new tab is shown. **+** is always `owner_tab_open`, so every device is told, one whose
 * Pane had ended included.
 */
export const OwnerTabStrip = ({
  pane,
  onNew,
}: {
  readonly pane: BrowserPaneKey;
  readonly onNew: () => void;
}) => {
  const listing = useAtomValue(ownerTabListAtom(pane.sessionId));
  const drivers = useAtomValue(ownerTabDriversAtom(pane.sessionId));
  const commandAtom = ownerTabCommandAtom(pane.sessionId);
  const command = useAtomSet(commandAtom);

  const failure = useAtomValue(commandAtom, (result) =>
    AsyncResult.isFailure(result) ? settledFailureOf(result) : null,
  );

  const { tabs, canOpen } = stripOf(listing, pane.archived, drivers);

  return (
    <div className="flex flex-col border-b">
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <div
          role="tablist"
          aria-label="Owner tabs"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const { shown, title, driven } = tab;

            return (
              <div
                key={tab.id}
                className={cn(
                  "flex h-8 max-w-48 min-w-24 shrink-0 items-center rounded-t-md border border-b-0 text-sm",
                  shown ? "bg-muted font-medium" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={shown}
                  title={title}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left"
                  onClick={() => {
                    if (!shown) command({ type: "show", id: tab.id });
                  }}
                >
                  {driven && (
                    <Bot
                      className="size-3.5 shrink-0 animate-pulse text-primary"
                      role="img"
                      aria-label="The agent is driving this tab"
                    />
                  )}
                  <span className="min-w-0 truncate">{title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  title="Close"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent [&_svg]:size-3.5"
                  onClick={() => {
                    command({ type: "close", id: tab.id });
                  }}
                >
                  <X aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
        {canOpen && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="New Owner tab"
            title="New Owner tab"
            onClick={() => {
              onNew();
              command({ type: "open" });
            }}
          >
            <Plus aria-hidden />
          </Button>
        )}
      </div>
      {failure !== null && (
        <p role="status" className="px-3 py-1 text-xs break-words text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
};
