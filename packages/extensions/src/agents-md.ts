// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- tool wrappers and commit callbacks are pi-durable's Promise code; plain functions over a request's messages.
// The `agents-md` extension (docs/architecture/workspace.md → Filesystem and tools → Project instructions): the `AGENTS.md` files of the
// Workspace in front of the model, as local pi and codex put them there, without moving the provider's cache prefix.
//
// - The `project_context` section holds the instructions of the conversation's `cwd` and of each directory above it up
//   to the Workspace root, the farthest first, in pi's format. Its text is fixed for as long as the context lasts: once
//   shown it is shown again as it is (`PromptInput.shown`), so an edit of an `AGENTS.md` never rewrites the system
//   prompt, which a provider without mid-conversation system messages (Anthropic's) would send as a new prefix. A
//   Handoff starts a context without it, and the next request reads the files again.
// - `read`, `edit` and `write` add to their result the instructions that apply to the file they touched (those of its
//   directory and of each directory above it), which the context does not show yet or shows with other text, as Claude
//   Code does for the `CLAUDE.md` files below its working directory. The result is the end of the context, so nothing
//   before it changes; it is committed with the text, so every later request sends the same bytes.
//
// What the context shows is a conversation document (`AgentsMdDoc`): each file's path and the hash of the text shown.
// A `beforeRequest` hook makes it what the request holds (the section, and the results that carry `details.agentsMd`),
// so after a Handoff or a compaction took a result out, the instructions it showed are added again at the next touch.
// A call of a script (`codemode`) leaves no result in the context, so it adds nothing.
import { callDurable, effectHook, frozenSection, Harness } from "@cloudpid/effect-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  type Extension,
  GenerationTask,
  type JsonObject,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  discoverInstructions,
  INSTRUCTIONS_ROOT,
  type InstructionFile,
  InstructionsError,
  isInstructionSource,
} from "./agents-md-discovery.ts";

export * from "./agents-md-discovery.ts";

export const extensionName = "agents-md";

/** The section's key; also the tag that wraps its text. */
export const SECTION_KEY = "project_context";

/** The key of a result's `details` that maps each instructions file the result shows to the hash of its text. */
export const SHOWN_DETAILS_KEY = "agentsMd";

/** The tools whose results get the instructions of the file they touch. */
export const TOUCHING_TOOLS = ["read", "edit", "write"] as const;

/**
 * The most bytes and lines of instructions one result gets. A touching tool's output limits are raised by as much, so
 * pi-durable, which keeps only the head of a result over its limits, never cuts them off; files that do not fit wait for
 * the next call. `read` bounds its own text to pi-durable's defaults.
 */
export const MAX_ADDED_BYTES = 128 * 1024;

export const MAX_ADDED_LINES = 2_500;

/** pi-durable's default output limits of a tool (`DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, not exported). */
const DEFAULT_MAX_BYTES = 50 * 1024;

const DEFAULT_MAX_LINES = 2_000;

/** What the conversation's context shows: each instructions file's path, and the hash of the text it shows. */
export type AgentsMdState = { shown: Record<string, string> };

export const AgentsMdDoc = defineDoc<AgentsMdState>({
  kind: "cloudpid.agents-md",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ shown: {} }),
  checkpointWhen: () => false,
});

/** A hash of `text` (cyrb53): it tells whether the context shows a file's current text, so it need not resist anyone. */
export const hashText = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const unescapeAttribute = (text: string) => text.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** One file as pi's system prompt shows it. */
export const formatInstructions = (file: InstructionFile): string =>
  `<project_instructions path="${escapeAttribute(file.path)}">\n${file.content}\n</project_instructions>`;

const BLOCK = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;

/** The files `text` shows, by path, with the hash of the text it shows of each. */
const shownIn = (text: string): Record<string, string> =>
  Object.fromEntries(
    Arr.map([...text.matchAll(BLOCK)], (match) => [
      unescapeAttribute(match[1] ?? ""),
      hashText(match[2] ?? ""),
    ]),
  );

/** What the section says before the files: pi's heading, and what this extension does for the files elsewhere. */
export const SECTION_INTRODUCTION =
  "Project-specific instructions and guidelines from AGENTS.md files. Each applies to the files in its directory and below; where two disagree, the nearer one wins. When you read or change a file in a directory with instructions of its own, they are added to that tool's result: follow them too.";

/** The section's text for `files`; undefined when there are none. */
export const formatSection = (files: ReadonlyArray<InstructionFile>): string | undefined =>
  files.length === 0
    ? undefined
    : `<${SECTION_KEY}>\n${SECTION_INTRODUCTION}\n\n${Arr.join(Arr.map(files, formatInstructions), "\n\n")}\n</${SECTION_KEY}>`;

/** The instructions for the files of `directory` in `env`: its own lookup if it has one (one call), else a walk of its files. */
const instructionsOf = (
  env: Pick<ExecutionEnv, "readTextFile">,
  directory: string,
  root: string,
  context: Context,
): Effect.Effect<ReadonlyArray<InstructionFile>, InstructionsError> =>
  isInstructionSource(env)
    ? Effect.tryPromise({
        try: () => env.discoverInstructions(directory, context),
        catch: (cause) =>
          InstructionsError.make({
            message: `Cannot discover instructions: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
    : discoverInstructions(env, directory, root, context);

const decodeDetails = Schema.decodeUnknownOption(
  Schema.Struct({ [SHOWN_DETAILS_KEY]: Schema.Record(Schema.String, Schema.String) }),
);

/** The files `messages` show, by path, with the hash of the text each shows: the section's, then each result's, the latest last. */
export const shownInstructions = (messages: ReadonlyArray<Message>): Record<string, string> => {
  let section: string | undefined;

  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;

    if (Object.hasOwn(message.sections, SECTION_KEY)) {
      section = message.sections[SECTION_KEY] ?? undefined;
    }
  }

  const fromResults = Arr.flatMap(messages, (message) =>
    message.role === "toolResult"
      ? Option.match(decodeDetails(message.details), {
          onNone: () => [],
          onSome: (details) => [details[SHOWN_DETAILS_KEY]],
        })
      : [],
  );

  return Object.assign({}, section === undefined ? {} : shownIn(section), ...fromResults);
};

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = Object.keys(a);

  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** Keeps the document what the request shows: after a Handoff or compaction, the files whose results were taken out are gone from it. */
const Shown = Effect.gen(function* () {
  const { harness } = yield* Harness;

  return yield* effectHook(GenerationTask, {
    beforeRequest: (request, api) =>
      Effect.gen(function* () {
        const shown = shownInstructions(request.messages);

        const state = yield* callDurable("snapshot", (context) =>
          api.snapshot(AgentsMdDoc, api.conversationId, context),
        );

        if (sameRecord(state?.shown ?? {}, shown)) return undefined;

        yield* callDurable("record", (context) =>
          harness.commit(async (tx) => {
            (await tx.doc(AgentsMdDoc, api.conversationId)).shown = shown;
          }, context),
        );

        return undefined;
      }),
  });
});

/** The section: the instructions of the conversation's `cwd`, read once per context and then shown as they were. */
const Section = (root: string) =>
  // A file the agent changes is shown again with its tool's result.
  frozenSection(SECTION_KEY, (input) => {
    const { env } = input;

    if (env === undefined) return Effect.undefined;

    // As the `skills` section's discovery: the section's Effect is not handed the request's Chord context.
    return Effect.map(instructionsOf(env, env.cwd, root, BACKGROUND_CONTEXT), formatSection);
  });

/** A file to add to a result: new to the context, or shown with other text (`updated`). */
type Added = { readonly file: InstructionFile; readonly hash: string; readonly updated: boolean };

const utf8 = new TextEncoder();

const sizeOf = (text: string) => ({
  bytes: utf8.encode(text).length,
  lines: text.split("\n").length,
});

/** The text a result gets for `added`, which a touch of `path` found. */
export const addedText = (path: string, touchedBy: string, added: ReadonlyArray<Added>): string => {
  const blocks = Arr.map(added, ({ file, updated }) => {
    if (file.path === path && touchedBy !== "read" && updated) {
      return `[${file.path} holds the project instructions for ${file.directory}: what it says now replaces what it said before.]`;
    }

    const block = formatInstructions(file);

    return updated
      ? `[The instructions in ${file.path} changed since they were shown: these replace them.]\n${block}`
      : block;
  });

  return `\n\n[Project instructions that apply to ${path}, from AGENTS.md files: added by the agents-md extension, not part of the tool's output. Each applies to the files in its directory and below; where two disagree, the nearer one wins.]\n${Arr.join(blocks, "\n\n")}`;
};

/** `@` and Unicode spaces as pi-durable's tools take them out of a path (`normalizeToolPath`, not exported). */
const toolPath = (path: string) =>
  path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");

const dirname = (path: string) => {
  const at = path.lastIndexOf("/");

  return at <= 0 ? "/" : path.slice(0, at);
};

/** The arguments of a touching tool that name its file: `path` in each of the three. */
const decodeTouch = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/**
 * `result` with the instructions that apply to the file `requested` names and that the context does not show yet, or
 * shows with other text. A failed call, a script's call, a call without an environment, and a lookup that fails are
 * left as they are: the instructions are added at a later touch.
 */
const withInstructions = async (
  tool: string,
  requested: string,
  result: ToolExecutionResult,
  api: ToolExecutionApi,
  root: string,
  context: Context,
): Promise<ToolExecutionResult> => {
  const env = api.env;

  if (result.isError === true || result.output === undefined || env === undefined) return result;

  // A script's call (`codemode`) gives its result to the script, not to the context.
  const task = await api.getTask(api.taskId, context);
  // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
  const input = task?.input as ToolTaskInput | undefined;

  if (input?.kind === "nested") return result;

  const absolute = await env.absolutePath(toolPath(requested), context);

  if (!absolute.ok) return result;

  const path = absolute.value;

  const found = await Effect.runPromise(
    Effect.orElseSucceed(instructionsOf(env, dirname(path), root, context), () => []),
  );

  // A `read` of an instructions file shows it in the result already.
  const files = Arr.filter(found, (file) => tool !== "read" || file.path !== path);

  if (files.length === 0) return result;

  const added = await api.commit(async (tx) => {
    const state = await tx.doc(AgentsMdDoc, api.conversationId);
    const picked: Added[] = [];
    let bytes = 0;
    let lines = 0;

    for (const file of files) {
      const hash = hashText(file.content);
      const before = state.shown[file.path];

      if (before === hash) continue;

      const entry = { file, hash, updated: before !== undefined };
      const size = sizeOf(addedText(path, tool, [entry]));

      // Over the budget: left for a later call, which finds it unshown.
      if (bytes + size.bytes > MAX_ADDED_BYTES || lines + size.lines > MAX_ADDED_LINES) continue;

      bytes += size.bytes;
      lines += size.lines;
      picked.push(entry);
      state.shown[file.path] = hash;
    }

    return picked;
  }, context);

  if (added.length === 0) return result;

  const kept = Option.getOrElse(decodeRecord(result.details), () => ({}));

  // SAFETY: `Schema.Json` values are JSON, as `JsonValue`'s are; the types differ only in `readonly`.
  const details = {
    ...kept,
    [SHOWN_DETAILS_KEY]: Object.fromEntries(Arr.map(added, ({ file, hash }) => [file.path, hash])),
  } as JsonObject;

  return {
    ...result,
    output: [...result.output, { type: "text", text: addedText(path, tool, added) }],
    details,
  };
};

/** `tool`, adding the instructions of the file it touches to its result, with room for them in its output limits. */
const touching =
  (root: string) =>
  (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    outputLimits: {
      ...tool.outputLimits,
      maxBytes: (tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES) + MAX_ADDED_BYTES,
      maxLines: (tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES) + MAX_ADDED_LINES,
    },
    execute: async (args, api, context) => {
      const result = await tool.execute(args, api, context);
      const touched = decodeTouch(args);

      if (Option.isNone(touched)) return result;

      try {
        return await withInstructions(tool.name, touched.value.path, result, api, root, context);
      } catch (cause) {
        // A Stop ends the call as it would have.
        if (context.abortSignal?.aborted === true) throw cause;

        // The tool did its work (an edit or a write is made by now): the instructions wait for a later touch.
        return result;
      }
    },
  });

export type AgentsMdOptions = {
  /** Where discovery stops going up: the Workspace root, unless a test's files are elsewhere. */
  readonly root?: string;
};

/** The `agents-md` extension: the `project_context` section, the hook that keeps its document, and the touching tools' wraps. */
export const agentsMdExtension = (
  options: AgentsMdOptions = {},
): Effect.Effect<Extension, never, Harness> => {
  const root = options.root ?? INSTRUCTIONS_ROOT;

  return Effect.map(Effect.all([Section(root), Shown]), ([section, shown]) =>
    defineExtension({
      name: extensionName,
      sections: [section],
      hooks: [shown],
      wraps: Arr.map(TOUCHING_TOOLS, (name) => ({ tool: name, wrap: touching(root) })),
    }),
  );
};

export const AgentsMd: Effect.Effect<Extension, never, Harness> = agentsMdExtension();
