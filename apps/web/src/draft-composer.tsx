// @effect-diagnostics preferEffectArray:off -- JSX lists of options are native arrays.

import { NEW_WORKSPACE } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowUp, GitBranch } from "lucide-react";
import type { KeyboardEvent, SubmitEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import {
  draftBaseAtom,
  draftBranchAtom,
  draftEnvironmentAtom,
  draftTextAtom,
  draftWorkspaceAtom,
  sendDraftAtom,
} from "./draft-state.ts";
import {
  draftBaseProblem,
  draftBranchProblem,
  draftSendable,
  effectiveWorkspace,
  type DraftInput,
} from "./draft.ts";
import {
  environmentListAtom,
  environmentNamesAtom,
  workspaceListAtom,
} from "./environments-state.ts";
import { settledFailureOf } from "./registry.ts";

/** Whether the screen has no mouse or trackpad: there Return starts a new line and the Send button sends. */
const touchOnly = (): boolean => window.matchMedia("(pointer: coarse)").matches;

/**
 * The draft of a new Session, in the style of a chat app's start page: choose the Environment in the headline, write
 * the first message, and choose below it which Workspace the Session works in. Sending registers the Session and opens
 * it; the message is sent once its page is up (`drainFirstMessageAtom`).
 */
export const DraftComposer = () => {
  const [text, setText] = useAtom(draftTextAtom);
  const [environment, setEnvironment] = useAtom(draftEnvironmentAtom);
  const [picked, setWorkspace] = useAtom(draftWorkspaceAtom);
  const [base, setBase] = useAtom(draftBaseAtom);
  const [branch, setBranch] = useAtom(draftBranchAtom);
  const environments = useAtomValue(environmentListAtom);
  const names = useAtomValue(environmentNamesAtom);
  const allWorkspaces = useAtomValue(workspaceListAtom);
  const sent = useAtomValue(sendDraftAtom);
  const send = useAtomSet(sendDraftAtom);

  const workspaces = (allWorkspaces ?? []).filter((known) => known.environment === environment);
  const workspace = effectiveWorkspace(picked, workspaces);
  const input: DraftInput = { text, environment, workspace, branch, base };
  const sending = sent.waiting;
  const branchProblem = draftBranchProblem(input);
  const baseProblem = draftBaseProblem(input);
  const sendable = draftSendable(input) && !sending;
  // The failure of the last send shows until the next one starts, with the text kept.
  const problem = settledFailureOf(sent);

  const submit = (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();

    if (sendable) send(input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

    if (touchOnly()) return;

    event.preventDefault();
    submit();
  };

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <h1 className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-2xl font-semibold">
        <label htmlFor="draft-environment">What should we work on in</label>
        <NativeSelect
          id="draft-environment"
          value={environment}
          onChange={(event) => {
            setEnvironment(event.target.value);
          }}
          className="h-10 max-w-full text-xl font-semibold"
        >
          {(environments ?? [{ id: environment }]).map((known) => (
            <option key={known.id} value={known.id}>
              {names[known.id] ?? known.id}
            </option>
          ))}
        </NativeSelect>
        <span aria-hidden>?</span>
      </h1>
      <form
        onSubmit={submit}
        className="flex flex-col gap-2 rounded-lg border bg-background p-2 transition-colors focus-within:border-ring"
      >
        <textarea
          aria-label="Message"
          rows={4}
          value={text}
          placeholder="Describe the task…"
          autoFocus={!touchOnly()}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="max-h-80 min-h-24 w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden />
          <NativeSelect
            aria-label="Workspace"
            value={workspace}
            onChange={(event) => {
              setWorkspace(event.target.value);
            }}
            className="h-8 max-w-48 text-xs"
          >
            <option value={NEW_WORKSPACE}>New workspace</option>
            {workspaces.map((known) => (
              <option key={known.id} value={known.id}>
                {known.branch}
              </option>
            ))}
          </NativeSelect>
          {workspace === NEW_WORKSPACE && (
            <>
              <Input
                aria-label="Base branch"
                value={base}
                onChange={(event) => {
                  setBase(event.target.value);
                }}
                placeholder="default branch"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={baseProblem !== null}
                className="h-8 w-36 font-mono text-xs"
              />
              <Input
                aria-label="Branch name"
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                }}
                placeholder="cloudpid/<id>"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={branchProblem !== null}
                className="h-8 w-36 font-mono text-xs"
              />
            </>
          )}
          <Button
            type="submit"
            size="icon"
            disabled={!sendable}
            aria-label={sending ? "Sending" : "Send"}
            title="Send (Enter)"
            className="ml-auto size-8 rounded-full"
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
      {(baseProblem ?? branchProblem) !== null && (
        <p role="alert" className="text-sm text-destructive">
          {baseProblem === null ? branchProblem : `Base branch: ${baseProblem}`}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {problem}
        </p>
      )}
      {workspace === NEW_WORKSPACE && (
        <p className="text-center text-xs text-muted-foreground">
          A new workspace gets its own clones of the environment's repos and its own container.
        </p>
      )}
    </div>
  );
};
