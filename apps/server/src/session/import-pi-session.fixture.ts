// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain arrays and objects of fixtures.
// Sanitized fixtures of a pi session file for the Session import's translation tests: the entries are shaped as pi writes
// them (`@earendil-works/pi-coding-agent`'s `session-manager.ts`, the extensions' own `custom` entries as
// `ian-pascoe/pi-extensions` at 1a9d7cc684b74ff08a367694623361ab315cbdcd writes them: see `import-pi-state.ts`), taken from
// the owner's real sessions with every name, path, number and sentence replaced.
import { type Schema } from "effect";

/** What a fixture entry carries beside its place in the tree. */
type Body = Readonly<Record<string, Schema.Json>>;

/** A line of a pi file: `type`, `id` and `parentId` first, as pi writes them. */
export const line = (type: string, id: string, parentId: string | null, body: Body = {}): string =>
  JSON.stringify({ type, id, parentId, timestamp: "2026-01-02T03:04:05.000Z", ...body });

export const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "0195d1c2-1111-7000-8000-000000000001",
  timestamp: "2026-01-02T03:00:00.000Z",
  cwd: "/Users/example/src/app",
});

const usage = {
  input: 120,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const userMessage = (text: string, timestamp = 1_767_322_800_000) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

export const assistantMessage = (
  content: Schema.Json,
  stopReason = "stop",
  timestamp = 1_767_322_801_000,
) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  usage,
  stopReason,
  timestamp,
});

export const toolCall = (id: string, name: string, args: Schema.Json = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

export const toolResultMessage = (
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp = 1_767_322_802_000,
) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

/** A message entry. */
export const message = (id: string, parentId: string | null, body: Schema.Json): string =>
  line("message", id, parentId, { message: body });

/** The `pi-todo-state` entry of a list of three Tasks, one with a description. */
export const todoState = (id: string, parentId: string | null): string =>
  line("custom", id, parentId, {
    customType: "pi-todo-state",
    data: {
      nextId: 4,
      tasks: [
        { id: 1, title: "Reproduce the failing build", status: "completed" },
        {
          id: 2,
          title: "Fix the cache key",
          description: "The key ignores the lockfile hash.",
          status: "active",
        },
        { id: 3, title: "Open the pull request", status: "pending" },
      ],
    },
  });

/** A `pi-context-note` entry: `content: null` deletes the Note. */
export const contextNote = (
  id: string,
  parentId: string | null,
  name: string,
  content: string | null,
): string =>
  line("custom", id, parentId, {
    customType: "pi-context-note",
    data: { version: 1, name, content, sourceSession: "0195d1c2-1111-7000-8000-000000000001" },
  });

/** A `pi-context-handoff` entry. */
export const contextHandoff = (id: string, parentId: string | null, handoff: string): string =>
  line("custom", id, parentId, {
    customType: "pi-context-handoff",
    data: { version: 1, handoff },
  });

/** A small conversation on one branch: a question, a call, its result and the answer, then the owner's next message. */
export const conversation = (): string[] => [
  header,
  message("a1", null, userMessage("Why does the build ignore the lockfile?")),
  message(
    "a2",
    "a1",
    assistantMessage(
      [{ type: "text", text: "Let me look." }, toolCall("call-1", "read", { path: "build.ts" })],
      "toolUse",
    ),
  ),
  message("a3", "a2", toolResultMessage("call-1", "read", "export const key = hash(src);")),
  message(
    "a4",
    "a3",
    assistantMessage([{ type: "text", text: "The key hashes the sources only." }]),
  ),
  message("a5", "a4", userMessage("Fix it.")),
];
