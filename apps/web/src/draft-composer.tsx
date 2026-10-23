// @effect-diagnostics globalDate:off preferEffectArray:off -- the Workspaces' ages are read against the wall clock as the menu renders, and JSX lists of options are native arrays.

import { NEW_WORKSPACE, type EnvironmentRecord, type WorkspaceRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Loader2,
  Paperclip,
  Settings2,
} from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type SubmitEvent, useId, useRef } from "react";
import { AttachmentTiles } from "./chat/attachment-tiles.tsx";
import {
  addDraftAttachmentsAtom,
  draftAttachmentsAtom,
  draftWaitingFor,
  removeDraftAttachmentAtom,
} from "./chat/attachments-state.ts";
import { useFileDrop } from "./chat/file-drop.ts";
import { Input } from "./components/ui/input.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./components/ui/menu.tsx";
import { Popover } from "./components/ui/popover.tsx";
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
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { settledFailureOf } from "./registry.ts";
import { ENVIRONMENTS_PATH, navigate } from "./router.ts";

/** Whether the screen has no mouse or trackpad: there Return starts a new line and the Send button sends. */
const touchOnly = (): boolean => window.matchMedia("(pointer: coarse)").matches;

/** Whether files are being dragged over the draft. */
const draftDragAtom = Atom.make(false);

/** A quiet control in the strip under the box: an icon and a value, which opens a menu or a small form. */
const chip =
  "touch-target inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** An Environment's Repos, by name, for the line under its name. */
const reposOf = (environment: Pick<EnvironmentRecord, "repos">): string =>
  environment.repos.length === 0
    ? "No repos"
    : environment.repos.map((repo) => repo.name).join(", ");

/**
 * The Environment the draft is made in, as the headline's last words: a dotted underline, which opens the list of
 * Environments, with the page that manages them below it.
 */
const EnvironmentPicker = ({
  environment,
  environments,
  name,
  disabled,
  onPick,
}: {
  environment: string;
  environments: readonly EnvironmentRecord[] | null;
  name: string;
  disabled: boolean;
  onPick: (id: string) => void;
}) => (
  <Menu
    label={`Environment: ${name}`}
    title="Choose the environment"
    align="center"
    disabled={disabled}
    icon={<span className="truncate">{name}</span>}
    className="size-auto max-w-full gap-1 rounded-sm px-0 text-[length:inherit] font-medium text-foreground underline decoration-foreground/30 decoration-dotted underline-offset-[6px] hover:bg-transparent hover:text-foreground hover:decoration-foreground hover:decoration-solid aria-expanded:decoration-foreground aria-expanded:decoration-solid focus-visible:outline-2 focus-visible:outline-ring"
    menuClassName="w-72 text-left"
  >
    <MenuLabel>Environments</MenuLabel>
    {(environments ?? []).map((known) => (
      <MenuItem
        key={known.id}
        checked={known.id === environment}
        onSelect={() => {
          onPick(known.id);
        }}
      >
        <FolderGit2 className="mt-0.5 self-start text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{known.name}</span>
          <span className="truncate text-xs text-muted-foreground">{reposOf(known)}</span>
        </span>
      </MenuItem>
    ))}
    <MenuSeparator />
    <MenuItem
      onSelect={() => {
        navigate(ENVIRONMENTS_PATH);
      }}
      className="text-muted-foreground"
    >
      <Settings2 aria-hidden />
      Manage environments
    </MenuItem>
  </Menu>
);

/** Which Workspace the Session works in: a new one, or one of the Environment's, by its branch. */
const WorkspacePicker = ({
  workspace,
  workspaces,
  disabled,
  onPick,
}: {
  workspace: string;
  workspaces: readonly WorkspaceRecord[];
  disabled: boolean;
  onPick: (id: string) => void;
}) => {
  const picked = workspaces.find((known) => known.id === workspace);
  const now = Date.now();

  return (
    <Menu
      label={`Workspace: ${picked === undefined ? "new workspace" : picked.branch}`}
      title="Choose the workspace"
      align="start"
      disabled={disabled}
      icon={
        <>
          {picked === undefined ? <FolderPlus aria-hidden /> : <FolderGit2 aria-hidden />}
          <span className={cn("truncate", picked !== undefined && "font-mono")}>
            {picked === undefined ? "New workspace" : picked.branch}
          </span>
          <ChevronDown className="opacity-60" aria-hidden />
        </>
      }
      className={cn(chip, "size-auto h-7 justify-start")}
      menuClassName="w-80"
    >
      <MenuItem
        checked={picked === undefined}
        onSelect={() => {
          onPick(NEW_WORKSPACE);
        }}
      >
        <FolderPlus className="mt-0.5 self-start text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span>New workspace</span>
          <span className="text-xs text-muted-foreground">
            Its own clones of the repos, on a new branch, and its own container
          </span>
        </span>
      </MenuItem>
      {workspaces.length > 0 && (
        <>
          <MenuSeparator />
          <MenuLabel>Continue in a workspace</MenuLabel>
          {workspaces.map((known) => (
            <MenuItem
              key={known.id}
              checked={known.id === workspace}
              onSelect={() => {
                onPick(known.id);
              }}
            >
              <GitBranch className="text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate font-mono text-xs">{known.branch}</span>
              <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                {relativeTime(known.createdAt, now)}
              </span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
};

/** A new Workspace's branch and the branch it starts from, as a chip that opens a small form of both. */
const BranchPicker = ({
  branch,
  base,
  branchProblem,
  baseProblem,
  disabled,
  onBranch,
  onBase,
}: {
  branch: string;
  base: string;
  branchProblem: string | null;
  baseProblem: string | null;
  disabled: boolean;
  onBranch: (branch: string) => void;
  onBase: (base: string) => void;
}) => {
  const branchId = useId();
  const baseId = useId();
  const invalid = branchProblem !== null || baseProblem !== null;

  return (
    <Popover
      label="Branch"
      title="Name the branch and where it starts"
      align="start"
      disabled={disabled}
      trigger={
        <>
          {invalid ? <AlertCircle aria-hidden /> : <GitBranch aria-hidden />}
          <span className="truncate font-mono">{branch.trim() || "cloudpid/<id>"}</span>
          <span className="hidden shrink-0 sm:inline">from</span>
          <span className="hidden truncate font-mono sm:inline">
            {base.trim() || "default branch"}
          </span>
          <ChevronDown className="opacity-60" aria-hidden />
        </>
      }
      className={cn(chip, invalid && "text-destructive hover:text-destructive")}
      panelClassName="w-80 p-3"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={branchId} className="text-xs font-medium">
            Branch
          </label>
          <Input
            id={branchId}
            value={branch}
            onChange={(event) => {
              onBranch(event.target.value);
            }}
            placeholder="cloudpid/<id>"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={branchProblem !== null}
            aria-describedby={`${branchId}-note`}
            className="h-8 font-mono text-xs aria-invalid:border-destructive"
          />
          <p
            id={`${branchId}-note`}
            className={cn(
              "text-xs",
              branchProblem === null ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {branchProblem ?? "The workspace's own branch. Leave it empty for cloudpid/<id>."}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={baseId} className="text-xs font-medium">
            Start from
          </label>
          <Input
            id={baseId}
            value={base}
            onChange={(event) => {
              onBase(event.target.value);
            }}
            placeholder="default branch"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={baseProblem !== null}
            aria-describedby={`${baseId}-note`}
            className="h-8 font-mono text-xs aria-invalid:border-destructive"
          />
          <p
            id={`${baseId}-note`}
            className={cn(
              "text-xs",
              baseProblem === null ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {baseProblem ?? "Each repo's default branch when left empty."}
          </p>
        </div>
      </div>
    </Popover>
  );
};

/**
 * The draft of a new Session, in the style of a chat app's start page: the headline names the Environment (a picker),
 * then comes the box for the first message, with its Attachments, and under it a strip with the Workspace the Session
 * works in and, for a new one, its branch. Files attach with the Attach button, a paste or a drop anywhere on the page;
 * they upload once Send has made the Session. Sending registers the Session and opens it; the message is sent once its
 * page is up (`drainFirstMessageAtom`).
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
  const attachments = useAtomValue(draftAttachmentsAtom);
  const addAttachments = useAtomSet(addDraftAttachmentsAtom);
  const removeAttachment = useAtomSet(removeDraftAttachmentAtom);
  const [dragging, setDragging] = useAtom(draftDragAtom);
  const sent = useAtomValue(sendDraftAtom);
  const send = useAtomSet(sendDraftAtom);
  const page = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const noteId = useId();

  useFileDrop(page, addAttachments, setDragging);

  const workspaces = (allWorkspaces ?? []).filter((known) => known.environment === environment);
  const workspace = effectiveWorkspace(picked, workspaces);
  const input: DraftInput = { text, environment, workspace, branch, base };
  const sending = sent.waiting;
  const branchProblem = draftBranchProblem(input);
  const baseProblem = draftBaseProblem(input);
  const attached = attachments.items.length > 0;
  // Why Send waits for the Attachments, shown under the box.
  const waiting = attached ? draftWaitingFor(attachments) : null;
  const sendable = draftSendable(input, attached) && waiting === null && !sending;
  // The failure of the last send shows until the next one starts, with the text kept.
  const problem = settledFailureOf(sent);
  const environmentName = names[environment] ?? (environments === null ? "…" : environment);
  const uploading = sending && attached;

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

  /** Pasted files attach; the clipboard's text, when it has any too, is pasted as well. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);

    if (files.length === 0 || sending) return;

    if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();

    addAttachments(files);
  };

  // What the strip's branch fields hold back, else what the Attachments wait for, beside Send.
  const fieldProblem =
    branchProblem === null
      ? baseProblem === null
        ? null
        : `Start from: ${baseProblem}`
      : `Branch: ${branchProblem}`;

  const status = fieldProblem ?? (uploading ? "Uploading the attachments…" : waiting);

  return (
    <div ref={page} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 px-2 pt-2 md:hidden">
        <button
          type="button"
          onClick={() => {
            navigate("/");
          }}
          aria-label="Back to sessions"
          className="touch-target rounded-md p-2 hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
        </button>
      </div>
      <div className="m-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-[12vh]">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="flex max-w-full flex-wrap items-baseline justify-center gap-x-2.5 gap-y-1 text-2xl font-normal tracking-tight sm:text-3xl">
            <span>What should we work on in</span>
            <span className="flex min-w-0 max-w-full items-baseline">
              <EnvironmentPicker
                environment={environment}
                environments={environments}
                name={environmentName}
                disabled={sending}
                onPick={setEnvironment}
              />
              <span aria-hidden>?</span>
            </span>
          </h1>
        </div>
        <form onSubmit={submit} className="relative flex flex-col">
          <div
            className={cn(
              "relative z-10 flex flex-col rounded-2xl border bg-background shadow-[0_12px_32px_-16px_rgb(0_0_0/0.25)] transition-colors focus-within:border-ring/60 dark:shadow-[0_14px_32px_-18px_rgb(0_0_0/0.75)]",
              dragging && "border-ring bg-muted",
            )}
          >
            <AttachmentTiles
              items={attachments.items}
              fits={attachments.fits}
              onRemove={(id) => {
                if (!sending) removeAttachment(id);
              }}
            />
            <textarea
              aria-label="Message"
              rows={3}
              value={text}
              placeholder="Describe a task, ask a question, or paste a screenshot…"
              autoFocus={!touchOnly()}
              readOnly={sending}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="field-sizing-content max-h-80 min-h-24 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={(event) => {
                  addAttachments(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                disabled={sending}
                onClick={() => {
                  picker.current?.click();
                }}
                className="touch-target inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4"
              >
                <Paperclip aria-hidden />
              </button>
              <p
                id={noteId}
                role="status"
                title={status ?? undefined}
                className={cn(
                  "min-w-0 flex-1 truncate px-1 text-xs",
                  fieldProblem === null ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {status}
              </p>
              <button
                type="submit"
                disabled={!sendable}
                aria-label={sending ? "Sending" : "Send"}
                aria-describedby={status === null ? undefined : noteId}
                title={status ?? "Send (Enter)"}
                className="touch-target inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4"
              >
                {sending ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <ArrowUp aria-hidden />
                )}
              </button>
            </div>
          </div>
          <div className="relative mx-3 -mt-3 flex min-w-0 items-center gap-1 rounded-b-xl border border-t-0 bg-muted/60 px-1.5 pt-4 pb-1 sm:mx-5">
            <WorkspacePicker
              workspace={workspace}
              workspaces={workspaces}
              disabled={sending}
              onPick={setWorkspace}
            />
            {workspace === NEW_WORKSPACE && (
              <BranchPicker
                branch={branch}
                base={base}
                branchProblem={branchProblem}
                baseProblem={baseProblem}
                disabled={sending}
                onBranch={setBranch}
                onBase={setBase}
              />
            )}
          </div>
        </form>
        {problem !== null && (
          <p role="alert" className="-mt-4 px-1 text-sm whitespace-pre-wrap text-destructive">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
};
