// A stand-in for a Session's Workspace, for tests of what the host asks of one (the composer's catalog, the expansion
// of a submitted message) without a Workspace DO: what it holds and how it fails are set in the object's storage, and
// the conversations it was asked for are recorded there, so a test sets and reads them from outside the instance.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off missingPipeableSignature:off
import type { PromptSource, PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { Skill, SkillSource } from "@cloudpid/extensions/skills-discovery";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import {
  err,
  type ExecutionEnv,
  FileError,
  type FileListEntry,
  ok,
} from "@earendil-works/pi-durable/env";

/** A file the fake Workspace holds: its path and text. */
type FakeFile = { readonly path: string; readonly text: string };

/** What the fake Workspace holds and how it answers. */
export type FakeWorkspace = {
  /** Its Skills, each seen only from the conversations it names, when it names any. */
  readonly skills?: ReadonlyArray<
    Pick<Skill, "name" | "description" | "filePath"> & {
      readonly conversations?: readonly number[];
    }
  >;
  readonly templates?: ReadonlyArray<PromptTemplate>;
  /** The files it can read; any other read fails. */
  readonly files?: readonly FakeFile[];
  /** Listing its Skills, templates and files fails. */
  readonly failing?: boolean;
  /** Listing its Skills, templates and files never answers. */
  readonly hanging?: boolean;
  /** How long each file read takes. */
  readonly readDelayMs?: number;
  /** The directory each conversation works in, when not `/workspace`. */
  readonly cwds?: Readonly<Record<number, string>>;
  /** What listing each directory finds (`listFiles`), relative to it; a directory not here lists nothing. */
  readonly trees?: Readonly<Record<string, readonly FileListEntry[]>>;
};

const KEY = "fake-workspace";
const ASKED = "fake-workspace-asked";
const LISTED = "fake-workspace-listed";

/** Make the Session's fake Workspace hold and answer what `workspace` says. */
export const useFakeWorkspace = (kv: DurableObjectStorage["kv"], workspace: FakeWorkspace) => {
  kv.put(KEY, workspace);
};

/** The conversations the fake Workspace built an environment for, in order. */
export const askedConversations = (kv: DurableObjectStorage["kv"]): readonly number[] =>
  kv.get<number[]>(ASKED) ?? [];

/** The directories the fake Workspace listed, in order. */
export const listedDirectories = (kv: DurableObjectStorage["kv"]): readonly string[] =>
  kv.get<string[]>(LISTED) ?? [];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `HarnessOptions.env` over the fake Workspace: none until a test sets one. */
export const fakeWorkspaceEnv =
  (kv: DurableObjectStorage["kv"]): NonNullable<HarnessOptions["env"]> =>
  (target) => {
    const workspace = kv.get<FakeWorkspace>(KEY);

    if (workspace === undefined) return undefined;

    kv.put(ASKED, [...askedConversations(kv), target.conversationId]);

    const listed = async () => {
      if (workspace.hanging === true) await new Promise(() => {});

      if (workspace.failing === true) throw new Error("The Workspace is unreachable");
    };

    const sources: SkillSource & PromptSource = {
      discoverSkills: async () => {
        await listed();

        return (workspace.skills ?? []).flatMap(({ conversations, ...skill }) =>
          conversations === undefined || conversations.includes(target.conversationId)
            ? [{ ...skill, disableModelInvocation: false }]
            : [],
        );
      },
      discoverPrompts: async () => {
        await listed();

        return workspace.templates ?? [];
      },
    };

    const cwd = workspace.cwds?.[target.conversationId] ?? target.cwd ?? "/workspace";

    const files: Pick<ExecutionEnv, "id" | "cwd" | "readTextFile" | "listFiles"> = {
      id: "fake-workspace",
      cwd,
      listFiles: async (path) => {
        await listed();

        const directory = path === "." ? cwd : path;

        kv.put(LISTED, [...listedDirectories(kv), directory]);

        return ok({ entries: [...(workspace.trees?.[directory] ?? [])], truncated: false });
      },
      readTextFile: async (path) => {
        await pause(workspace.readDelayMs ?? 0);

        const file = workspace.files?.find((each) => each.path === path);

        return file === undefined
          ? err(new FileError("not_found", "No such file", path))
          : ok(file.text);
      },
    };

    // SAFETY: the host asks a conversation's environment only for its Skills and templates, file reads and listings,
    // which this one answers; the scripted model calls no tool that uses it.
    return Object.assign(files as ExecutionEnv, sources);
  };
