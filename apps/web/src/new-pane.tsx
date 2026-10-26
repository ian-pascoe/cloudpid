// The New pane: the tab the Pane area's button opens when no Pane is open, and the tab bar's + opens beside the others.
// It offers the Pane types the owner can open; picking one puts that Pane in this tab (or shows it where it is open
// already). A Live View is not offered: it opens by itself when the agent hands over its browser. The Browser Pane is the
// owner's own way into that browser, at any time.

import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { Bot, FileDiff, Globe, Network, type LucideIcon } from "lucide-react";
import { use } from "react";
import { useShownSessionId } from "./chat/conversation.ts";
import { TreeBarScope } from "./chat/tree-actions.ts";
import { useSubagentsWorking } from "./chat/subagents-pane.tsx";
import { changesTotals } from "./diff-pane/changes.ts";
import { filesLabel } from "./diff-pane/parts.tsx";
import { BROWSER_PANE, DIFF_PANE, NEW_PANE, SUBAGENTS_PANE, TREE_PANE } from "./panes.ts";
import { panesAtom } from "./panes-state.ts";
import { changesAtom } from "./session/atoms.ts";

/** One Pane the New pane offers. */
interface Choice {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** A short reading of what the Pane holds now, beside its name. */
  readonly status?: string | undefined;
}

/** The New pane: the Panes the owner can open, the ones open already marked so. */
export const NewPane = () => {
  const [{ open }, act] = useAtom(panesAtom);
  // An archived Session cannot move in its tree, so it offers none, as it has no `/tree`; nor does it start a browser.
  const archived = use(TreeBarScope)?.archived === true;
  const working = useSubagentsWorking();
  const changes = changesTotals(useAtomValue(changesAtom(useShownSessionId()))?.repos ?? []);

  const choices: readonly Choice[] = [
    {
      key: DIFF_PANE,
      name: "Diff",
      description: "The Changes in the Workspace: every changed file, in one scroll.",
      icon: FileDiff,
      status:
        changes.files > 0
          ? `${filesLabel(changes.files)} ${changes.approximate ? "≈" : ""}+${changes.additions} −${changes.deletions}`
          : undefined,
    },
    {
      key: SUBAGENTS_PANE,
      name: "Subagents",
      description: "The subagents, each opening in a pane of its own, and background work.",
      icon: Bot,
      status: working > 0 ? `${working} working` : undefined,
    },
    ...(archived
      ? []
      : [
          {
            key: TREE_PANE,
            name: "Session tree",
            description: "Every branch of the conversation; go back to any message.",
            icon: Network,
          },
          {
            key: BROWSER_PANE,
            name: "Browser",
            description:
              "The Session's browser, in a tab of your own: browse and sign in, with the agent's cookies and logins.",
            icon: Globe,
          },
        ]),
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-4">
      <h3 className="text-sm font-semibold">Open a pane</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {Arr.map(choices, ({ key, name, description, icon: Icon, status }) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => {
                act({ type: "replace", key: NEW_PANE, by: key });
              }}
              className="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                  {name}
                  {status !== undefined && (
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                      {status}
                    </span>
                  )}
                  {open.includes(key) && (
                    <span className="text-xs font-normal text-muted-foreground">Open</span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        A Live View opens here by itself when the agent hands you its browser.
      </p>
    </div>
  );
};
