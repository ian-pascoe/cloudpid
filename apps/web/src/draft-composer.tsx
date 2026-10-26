// @effect-diagnostics globalDate:off preferEffectArray:off -- the Workspaces' ages are read against the wall clock as the menu renders, and JSX lists of options are native arrays.

import { NEW_WORKSPACE, type EnvironmentRecord, type WorkspaceRecord } from "@cloudpid/protocol";
import {
  RegistryContext,
  useAtom,
  useAtomMount,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
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
  Settings2,
} from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  type SubmitEvent,
  useContext,
  useId,
  useRef,
} from "react";
import { AttachmentTiles } from "./chat/attachment-tiles.tsx";
import {
  addDraftAttachmentsAtom,
  draftAttachmentsAtom,
  draftWaitingFor,
  removeDraftAttachmentAtom,
} from "./chat/attachments-state.ts";
import type { Edited } from "./chat/completion.ts";
import { CompletionMenu } from "./chat/completion-menu.tsx";
import { AttachButton, attachPasted, composerBox, sendButton } from "./chat/composer-parts.tsx";
import { type ComposerSource, composerState } from "./chat/composer-state.ts";
import { useFileDrop } from "./chat/file-drop.ts";
import { fileResults } from "./chat/file-search.ts";
import { useCompletion } from "./chat/use-completion.ts";
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
  draftCatalogAtom,
  draftFileSearchAtom,
  draftLookups,
  draftPlaceAtom,
} from "./draft-lookups.ts";
import {
  environmentListAtom,
  environmentNamesAtom,
  workspaceListAtom,
} from "./environments-state.ts";
import { relativeTime } from "./format.ts";
import { isTouchScreen } from "./lib/device.ts";
import { cn } from "./lib/utils.ts";
import { settledFailureOf } from "./registry.ts";
import { ENVIRONMENTS_PATH, navigate } from "./router.ts";

/** Whether files are being dragged over the draft. */
const draftDragAtom = Atom.make(false);

/** The draft's composer state (`composerState`) over `draftTextAtom`, kept while the draft is shown. */
const DraftComposerScope = ScopedAtom.make((source: ComposerSource) =>
  Atom.make(composerState(source)),
);

/** A quiet control in the strip under the box: an icon and a value, which opens a menu or a small form. */
const chip =
  "touch-target inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** The width of the pickers' panels: never wider than a 320 px screen leaves room for. */
const panelWidth = "w-[min(20rem,calc(100vw-1rem))]";

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
    menuClassName={cn(panelWidth, "text-left")}
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
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              known.repos.length > 0 && "font-mono",
            )}
          >
            {reposOf(known)}
          </span>
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
      className={cn(chip, "size-auto h-8 justify-start")}
      menuClassName={panelWidth}
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

/** A branch field of the draft: what is typed, why it cannot be used (or null), and how to change it. */
interface BranchInput {
  readonly value: string;
  readonly problem: string | null;
  readonly onChange: (value: string) => void;
}

/** One field of the branch form: its label, the field in mono, and under it why it is wrong or what empty means. */
const BranchField = ({
  label,
  field,
  placeholder,
  hint,
}: {
  label: string;
  field: BranchInput;
  placeholder: string;
  hint: string;
}) => {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={field.value}
        onChange={(event) => {
          field.onChange(event.target.value);
        }}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={field.problem !== null}
        aria-describedby={`${id}-note`}
        className="font-mono aria-invalid:border-destructive"
      />
      <p
        id={`${id}-note`}
        className={cn(
          "text-xs",
          field.problem === null ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {field.problem ?? hint}
      </p>
    </div>
  );
};

/** A new Workspace's branch and the branch it starts from, as a chip that opens a small form of both. */
const BranchPicker = ({
  branch,
  base,
  disabled,
}: {
  branch: BranchInput;
  base: BranchInput;
  disabled: boolean;
}) => {
  const invalid = branch.problem !== null || base.problem !== null;

  return (
    <Popover
      label="Branch"
      title="Name the branch and where it starts"
      align="start"
      disabled={disabled}
      trigger={
        <>
          {invalid ? <AlertCircle aria-hidden /> : <GitBranch aria-hidden />}
          <span className="truncate font-mono">{branch.value.trim() || "cloudpid/<id>"}</span>
          <span className="hidden shrink-0 sm:inline">from</span>
          <span className="hidden truncate font-mono sm:inline">
            {base.value.trim() || "default branch"}
          </span>
          <ChevronDown className="opacity-60" aria-hidden />
        </>
      }
      className={cn(chip, invalid && "text-destructive hover:text-destructive")}
      panelClassName={cn(panelWidth, "p-3")}
    >
      <div className="flex flex-col gap-3">
        <BranchField
          label="Branch"
          field={branch}
          placeholder="cloudpid/<id>"
          hint="The workspace's own branch. Leave it empty for cloudpid/<id>."
        />
        <BranchField
          label="Start from"
          field={base}
          placeholder="default branch"
          hint="Each repo's default branch when left empty."
        />
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
 *
 * The box completes as the Session's composer does, but from the directory the Session would work in, asked of the
 * Registry (`draft-lookups.ts`): `/` opens a menu of the Prompt templates and Skills (`/skill:name`), `$` one of the
 * Skills, and `@` one of the files and folders. A draft has no Session to run commands on, so it offers none: what is
 * picked is text, which the Session expands when it takes the first message.
 */
export const DraftComposer = () => {
  const registry = useContext(RegistryContext);
  const box = useRef<HTMLTextAreaElement>(null);

  return (
    <DraftComposerScope.Provider
      value={{
        lookups: draftLookups,
        text: () => registry.get(draftTextAtom),
        subscribe: (listener) => registry.subscribe(draftTextAtom, listener),
        input: () => box.current,
        setText: (text) => {
          registry.set(draftTextAtom, text);
        },
      }}
    >
      <DraftPage box={box} />
    </DraftComposerScope.Provider>
  );
};

/** The draft's page; `box` is its message box. */
const DraftPage = ({ box }: { box: RefObject<HTMLTextAreaElement | null> }) => {
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
  const noteId = useId();

  const state = useAtomValue(DraftComposerScope.use());
  const setCaret = useAtomSet(state.caret);
  const setFocused = useAtomSet(state.focused);
  const fileQuery = useAtomValue(state.fileQuery);
  const place = useAtomValue(draftPlaceAtom);
  const catalog = useAtomValue(draftCatalogAtom(place));
  const files = fileResults(useAtomValue(draftFileSearchAtom(place)), fileQuery);

  useAtomMount(state.effects);

  const edit = (next: Edited) => {
    Atom.batch(() => {
      setText(next.text);
      setCaret(next.caret);
    });

    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // Templates and Skills only: the draft has no Session to run a command on.
  const completion = useCompletion({
    state,
    commands: [],
    catalog: catalog ?? undefined,
    files,
    edit,
  });

  const trackCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart);
  };

  const workspaces = (allWorkspaces ?? []).filter((known) => known.environment === environment);
  const workspace = effectiveWorkspace(picked, workspaces);
  const input: DraftInput = { text, environment, workspace, branch, base };
  const sending = sent.waiting;

  // A file attached while the draft is sent would miss its message.
  const attach = (files: File[]) => {
    if (!sending) addAttachments(files);
  };

  useFileDrop(page, attach, setDragging);

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
    if (completion.onKeyDown(event)) return;

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

    // On a touch screen Return starts a new line and the Send button sends.
    if (isTouchScreen()) return;

    event.preventDefault();
    submit();
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
    <div ref={page} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
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
          <h1 className="flex max-w-full flex-wrap items-baseline justify-center gap-x-2.5 gap-y-1 text-2xl font-normal tracking-tight">
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
          {completion.menu !== null && (
            <CompletionMenu
              id={completion.id}
              label={completion.menu.label}
              sections={completion.menu.sections}
              notice={completion.menu.notice}
              highlighted={completion.active}
              onHighlight={completion.highlight}
              onPick={completion.pick}
            />
          )}
          <div className={cn(composerBox(dragging), "relative z-10 flex flex-col")}>
            <AttachmentTiles
              items={attachments.items}
              fits={attachments.fits}
              onRemove={(id) => {
                if (!sending) removeAttachment(id);
              }}
            />
            <textarea
              ref={box}
              aria-label="Message"
              {...completion.inputProps}
              rows={3}
              value={text}
              placeholder="Describe a task, ask a question, or paste a screenshot…"
              autoFocus={!isTouchScreen()}
              readOnly={sending}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onSelect={(event) => {
                trackCaret(event.currentTarget);
              }}
              onFocus={(event) => {
                setFocused(true);
                trackCaret(event.currentTarget);
              }}
              onBlur={() => {
                setFocused(false);
              }}
              onPaste={(event) => {
                attachPasted(event, attach);
              }}
              className="field-sizing-content max-h-80 min-h-24 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <AttachButton onAttach={attach} disabled={sending} />
              <span className="flex-1" />
              <button
                type="submit"
                disabled={!sendable}
                aria-label={sending ? "Sending" : "Send"}
                aria-describedby={status === null ? undefined : noteId}
                title={status ?? "Send (Enter)"}
                className={sendButton}
              >
                {sending ? (
                  <Loader2 className="motion-safe:animate-spin" aria-hidden />
                ) : (
                  <ArrowUp aria-hidden />
                )}
              </button>
            </div>
          </div>
          <div className="relative mx-3 -mt-3 flex min-w-0 items-center gap-1 rounded-b-lg border border-t-0 bg-muted/60 px-1.5 pt-4 pb-1 sm:mx-5">
            <WorkspacePicker
              workspace={workspace}
              workspaces={workspaces}
              disabled={sending}
              onPick={setWorkspace}
            />
            {workspace === NEW_WORKSPACE && (
              <BranchPicker
                branch={{ value: branch, problem: branchProblem, onChange: setBranch }}
                base={{ value: base, problem: baseProblem, onChange: setBase }}
                disabled={sending}
              />
            )}
          </div>
        </form>
        {/* Under the box: why Send waits, in Faded Ink, or what is wrong, in Brick Red. */}
        {(status !== null || problem !== null) && (
          <div className="-mt-6 flex flex-col gap-1 px-1 text-xs">
            {status !== null && (
              <p
                id={noteId}
                role={fieldProblem === null ? "status" : "alert"}
                className={fieldProblem === null ? "text-muted-foreground" : "text-destructive"}
              >
                {status}
              </p>
            )}
            {problem !== null && (
              <p role="alert" className="whitespace-pre-wrap text-destructive">
                {problem}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
