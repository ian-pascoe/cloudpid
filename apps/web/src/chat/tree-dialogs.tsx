// @effect-diagnostics preferEffectArray:off -- the owner's messages are a short native array rendered as a JSX list.

// The dialogs the Session tree asks through (GLOSSARY.md → Session tree, Fork, Clone): whether to carry a summary of
// the Session branch left, which message a `/fork` starts before and where a `/fork` or `/clone` goes, and the Git
// branch of a Fork or Clone's new Workspace.

import { ownBranchProblem } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import type { ReactNode } from "react";
import { useCall } from "../calls.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { exitFailure } from "../registry.ts";
import { ownerMessages, pointOf } from "../session/tree.ts";
import { useShownSessionId } from "./conversation.ts";
import { useFork, useTree } from "./tree-actions.ts";
import {
  forkChooserAtom,
  forkingAtom,
  forkSessionAtom,
  navigateAtom,
  pendingForkAtom,
  pendingMoveAtom,
} from "./tree-state.ts";

/** What the summary dialog's own form holds: the focus typed, once the owner asked to give one, and its run. */
const SummaryForm = ScopedAtom.make(() =>
  Atom.make<{
    readonly focus: string | null;
    readonly running: boolean;
    readonly failure: string | null;
  }>({ focus: null, running: false, failure: null }),
);

const SummaryChoices = ({ close }: { close: () => void }) => {
  const pending = useAtomValue(pendingMoveAtom);
  const [{ focus, running, failure }, setForm] = useAtom(SummaryForm.use());
  const navigate = useCall(navigateAtom(pending?.sessionId ?? ""));

  if (pending === null) return null;

  const setFocus = (next: string) => {
    setForm({ focus: next, running, failure });
  };

  const go = (summary: { readonly instructions?: string } | undefined) => {
    setForm({ focus, running: true, failure: null });
    void navigate({ point: pending.point, summary }).then((exit) => {
      const why = exitFailure(exit);

      setForm({ focus, running: false, failure: why });

      if (why === null) close();
    });
  };

  return (
    <>
      {focus !== null && (
        <label className="flex flex-col gap-1.5 text-sm">
          What the summary should keep
          <textarea
            autoFocus
            rows={3}
            value={focus}
            disabled={running}
            onChange={(event) => {
              setFocus(event.target.value);
            }}
            className="rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={running}
          onClick={() => {
            go(undefined);
          }}
        >
          No summary
        </Button>
        {focus === null ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => {
                setFocus("");
              }}
            >
              Summarize with a focus…
            </Button>
            <Button
              type="button"
              disabled={running}
              onClick={() => {
                go({});
              }}
            >
              {running ? "Summarizing…" : "Summarize"}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            disabled={running}
            onClick={() => {
              go(focus.trim() === "" ? {} : { instructions: focus.trim() });
            }}
          >
            {running ? "Summarizing…" : "Summarize"}
          </Button>
        )}
      </div>
    </>
  );
};

/** Asks whether to carry a summary of the Session branch left, for the move waiting in `pendingMoveAtom`. */
const SummaryDialog = () => {
  const [pending, setPending] = useAtom(pendingMoveAtom);

  const close = () => {
    setPending(null);
  };

  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      title="Summarize the session branch you leave?"
      description="A summary of what this session branch did starts the one you go to, so the agent keeps it in mind. It is a model request on this session's usage."
    >
      <SummaryForm.Provider>
        <SummaryChoices close={close} />
      </SummaryForm.Provider>
    </Dialog>
  );
};

/** What the new-workspace dialog's own form holds: the Git branch typed, and its run. */
const ForkForm = ScopedAtom.make(() =>
  Atom.make<{
    readonly branch: string;
    readonly running: boolean;
    readonly failure: string | null;
  }>({ branch: "", running: false, failure: null }),
);

const ForkFields = ({ close }: { close: () => void }) => {
  const pending = useAtomValue(pendingForkAtom);
  const [{ branch, running, failure }, setForm] = useAtom(ForkForm.use());
  const fork = useCall(forkSessionAtom);
  const setForking = useAtomSet(forkingAtom(pending?.source ?? ""));

  if (pending === null) return null;

  const problem = branch.trim() === "" ? undefined : ownBranchProblem(branch.trim());
  const shown = problem ?? failure ?? undefined;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (problem !== undefined || running) return;

        setForm({ branch, running: true, failure: null });
        setForking(true);
        void fork({ ...pending, newWorkspace: true, branch }).then((exit) => {
          const why = exitFailure(exit);

          setForking(false);
          setForm({ branch, running: false, failure: why });

          if (why === null) close();
        });
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        Git branch
        <Input
          autoFocus
          value={branch}
          placeholder="cloudpid/<workspace id>"
          spellCheck={false}
          aria-invalid={problem !== undefined}
          disabled={running}
          className="font-mono"
          onChange={(event) => {
            setForm({ branch: event.target.value, running, failure });
          }}
        />
      </label>
      {shown !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {shown}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={running} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={running || problem !== undefined}>
          {running ? "Carrying the files…" : pending.point === undefined ? "Clone" : "Fork"}
        </Button>
      </div>
    </form>
  );
};

/** Asks for the Git branch of a Fork or Clone's new Workspace, for the one waiting in `pendingForkAtom`. */
const ForkDialog = () => {
  const [pending, setPending] = useAtom(pendingForkAtom);
  const clone = pending?.point === undefined;

  return (
    <Dialog
      open={pending !== null}
      onClose={() => {
        setPending(null);
      }}
      title={clone ? "Clone in a new workspace" : "Fork in a new workspace"}
      description="The new workspace starts from this one's files as they are now, uncommitted changes included: each repo's HEAD is pushed to its remote as the new workspace's Git branch. Leave it empty for cloudpid/<workspace id>. Nothing of this session may be running, and it takes no message until the files are carried."
    >
      <ForkForm.Provider>
        <ForkFields
          close={() => {
            setPending(null);
          }}
        />
      </ForkForm.Provider>
    </Dialog>
  );
};

/** The owner's message a `/fork` starts before, as the chooser picks it: the newest until another is picked. */
const ChosenMessage = ScopedAtom.make(() => Atom.make<number | null>(null));

/** The chooser's own form: for a Fork, the owner's messages to pick from; then where to make it. */
const ChooserFields = ({ close }: { close: () => void }) => {
  const chooser = useAtomValue(forkChooserAtom);
  const sessionId = useShownSessionId();
  const tree = useTree(sessionId);
  const [chosen, setChosen] = useAtom(ChosenMessage.use());
  const fork = useFork();

  if (chooser === null) return null;

  const clone = chooser.kind === "clone";
  const word = clone ? "Clone" : "Fork";
  const messages = tree === null ? [] : ownerMessages(tree).toReversed();
  const picked = messages.find((node) => node.id === chosen) ?? messages[0];
  const ready = clone || picked !== undefined;

  const make = (newWorkspace: boolean) => {
    close();
    fork(clone || picked === undefined ? undefined : pointOf(picked), newWorkspace);
  };

  return (
    <div className="flex flex-col gap-4">
      {!clone &&
        (messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {tree === null ? "Loading…" : "There is no message of yours to fork from yet."}
          </p>
        ) : (
          <ul
            role="radiogroup"
            aria-label="Your messages"
            className="flex max-h-80 flex-col overflow-y-auto"
          >
            {messages.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={node.id === picked?.id}
                  onClick={() => {
                    setChosen(node.id);
                  }}
                  className={cn(
                    "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    node.id === picked?.id && "bg-accent font-medium",
                  )}
                >
                  {node.text === "" ? "…" : node.text}
                </button>
              </li>
            ))}
          </ul>
        ))}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!ready}
          onClick={() => {
            make(true);
          }}
        >
          {word} in a new workspace…
        </Button>
        <Button
          type="button"
          disabled={!ready}
          onClick={() => {
            make(false);
          }}
        >
          {word} in this workspace
        </Button>
      </div>
    </div>
  );
};

/** `/fork` and `/clone`: what to make and where, as the bar's buttons and their menu offer. */
const ForkChooserDialog = () => {
  const [chooser, setChooser] = useAtom(forkChooserAtom);
  const sessionId = useShownSessionId();
  const open = chooser !== null && chooser.sessionId === sessionId;

  const close = () => {
    setChooser(null);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={chooser?.kind === "clone" ? "Clone" : "Fork"}
      description={
        chooser?.kind === "clone"
          ? "A new session with this conversation as it is now, to go on from here separately."
          : "A new session from before one of your messages: it goes back in the new session's composer."
      }
    >
      <ChosenMessage.Provider>
        <ChooserFields close={close} />
      </ChosenMessage.Provider>
    </Dialog>
  );
};

/** The dialogs of the Session tree: mounted once on the Session's page. */
export const TreeDialogs = (): ReactNode => (
  <>
    <SummaryDialog />
    <ForkDialog />
    <ForkChooserDialog />
  </>
);
