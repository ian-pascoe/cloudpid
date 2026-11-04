// What the MCP task tests share (`mcp-tasks.test.ts`, `mcp-tasks-agents.test.ts`): a fake host whose server runs a task,
// and a Session over it with a scripted model.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off missingPipeableSignature:off
import {
  McpHostCallFailed,
  McpHostCompleted,
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  ServerError,
  type JsonObject,
  type McpHostRequestInput,
  type McpTaskSnapshot,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type { Mutable } from "effect/Types";
import { open, startOf } from "./mcp.fixture.ts";
import * as Mcp from "./mcp.ts";
import { type FakeMcpAnswer, type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import type { McpTasksTiming } from "./mcp/task-port.ts";
import type { McpToolOptions } from "./mcp/tools.ts";
import { McpTasksDoc } from "./mcp/task-state.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

export const SECRET = "srv-secret-7";

export const SERVER: FakeMcpServer = {
  name: "docs",
  exposure: "direct",
  tools: [{ name: "report", description: "Make a report" }],
};

export const CREATED = {
  taskId: SECRET,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttlMs: 60_000,
};

export type Sent = McpHostRequestInput;

/** What a test changes in the host's server. */
export type TaskHostOptions = {
  /** The status message the server gives its working task. */
  readonly message?: string;
  /** What the host answers the `n`th `tasks/get` instead of the task's state (1-based); `undefined`: the state. */
  readonly getAnswer?: (n: number) => ReturnType<FakeMcpAnswer> | undefined;
  /** The process a stdio server's task runs in, by the poll that asks (0 is the call): the spawn id the host answers. */
  readonly spawnOf?: (n: number) => string | undefined;
  /** What the host answers `tasks/cancel` instead of an acknowledgement. */
  readonly cancelAnswer?: () => ReturnType<FakeMcpAnswer>;
  /**
   * Questions the task waits on (`input_required`, by key) until a `tasks/update` brings answers; it then works, and ends
   * after `polls` polls as any task does.
   */
  readonly asks?: Readonly<Record<string, JsonObject>>;
  /** Questions it asks once the first update was taken (and the lag is over), until a second update brings answers. */
  readonly later?: Readonly<Record<string, JsonObject>>;
  /** What the host answers the `n`th `tasks/update` (1-based) instead of taking it; `undefined`: it takes it. */
  readonly updateAnswer?: (n: number) => ReturnType<FakeMcpAnswer> | undefined;
  /** Whether the `n`th `tasks/update` (1-based) reaches the server, which takes it, while its answer is lost. */
  readonly updateLostAfter?: (n: number) => boolean;
  /** The first poll after an update was tried lists no question at all, as a server may for a moment, then lists them again. */
  readonly omitOnce?: boolean;
  /** Keep answering `input_required` this many polls after the update, as a server slow to take it does. */
  readonly lagPolls?: number;
};

/** A task the host's server runs: it ends once it was polled `polls` times, unless it was cancelled. */
export const taskHost = (polls: number, options: TaskHostOptions = {}) => {
  const sent: Sent[] = [];
  let gets = 0;
  let cancelled = false;
  const updates: Array<Readonly<Record<string, JsonObject>>> = [];
  const attempts: Array<Readonly<Record<string, JsonObject>>> = [];
  let lag = options.lagPolls ?? 0;
  let omitted = false;

  /** The questions of `keys` the server was not answered yet. */
  const unanswered = (keys: Readonly<Record<string, JsonObject>> = {}) => {
    const taken = new Set(Arr.flatMap(updates, (each) => Record.keys(each)));

    return Record.filter(keys, (_, key) => !taken.has(key));
  };

  const asking = (): McpTaskSnapshot | undefined => {
    if (options.asks === undefined || cancelled) return undefined;

    const first = unanswered(options.asks);

    // A server that goes on listing what it was answered, for `lagPolls`, is slow to take the answers.
    const listed =
      Record.size(first) > 0
        ? first
        : updates.length > 0 && lag > 0
          ? options.asks
          : unanswered(options.later);

    // Before any update a task that asks nothing still waits; after, it waits only for what is left.
    if (Record.size(listed) === 0 && updates.length > 0) return undefined;

    // SAFETY: an `input_required` snapshot is the common fields, the status and the questions.
    return {
      ...CREATED,
      status: "input_required",
      statusMessage: "Waiting for input",
      inputRequests: listed,
    } as McpTaskSnapshot;
  };

  const snapshot = (status: McpTaskSnapshot["status"]): McpTaskSnapshot =>
    // SAFETY: only the statuses that carry no more than the common fields are made here.
    ({
      ...CREATED,
      status,
      statusMessage: options.message ?? "Making the report",
    }) as McpTaskSnapshot;

  const spawned = (n: number) => {
    const spawn = options.spawnOf?.(n);

    return spawn === undefined ? {} : { spawn };
  };

  const completed = (text = "a plain result") =>
    McpHostCompleted.make({
      result: { kind: "inline", value: { content: [{ type: "text", text }] } },
    });

  const answerOf: FakeMcpAnswer = async (input) => {
    sent.push(input);

    switch (input.op) {
      // A call not offered a task is answered at once, as a server does.
      case "tools/call":
        return input.ctx.allowTask === true
          ? McpHostTaskStarted.make({
              task: snapshot("working"),
              conn: "conn-docs",
              ...spawned(0),
            })
          : completed();
      case "tasks/get": {
        gets += 1;

        const forced = options.getAnswer?.(gets);

        if (forced !== undefined) return forced;

        if (cancelled) return McpHostTaskState.make({ task: snapshot("cancelled") });

        if (options.omitOnce === true && !omitted && attempts.length > 0 && !cancelled) {
          omitted = true;

          // SAFETY: an `input_required` snapshot is the common fields, the status and the questions.
          const empty = {
            ...CREATED,
            status: "input_required",
            statusMessage: "Waiting for input",
            inputRequests: {},
          } as McpTaskSnapshot;

          return McpHostTaskState.make({ task: empty });
        }

        const waiting = asking();

        if (waiting !== undefined) {
          if (updates.length > 0) lag -= 1;

          return McpHostTaskState.make({ task: waiting });
        }

        return gets >= polls
          ? McpHostTaskState.make({
              ...spawned(gets),
              task: snapshot("completed"),
              result: {
                kind: "inline",
                value: { content: [{ type: "text", text: "the report" }] },
              },
            })
          : McpHostTaskState.make({ task: snapshot("working"), ...spawned(gets) });
      }

      case "tasks/update": {
        attempts.push(input.params.inputResponses);

        const refused = options.updateAnswer?.(attempts.length);

        if (refused !== undefined) return refused;

        updates.push(input.params.inputResponses);

        if (options.updateLostAfter?.(attempts.length) === true) {
          return McpHostCallFailed.make({
            error: ServerError.make({ message: "the answer was lost", code: -32000 }),
          });
        }

        return McpHostTaskAck.make({});
      }

      case "tasks/cancel":
        if (options.cancelAnswer !== undefined) return options.cancelAnswer();

        cancelled = true;

        return McpHostTaskAck.make({});
      default:
        return completed();
    }
  };

  return { answerOf, sent, gets: () => gets, updates, attempts };
};

/** The pool's storage, and what a Session would give the tools. */
export const memory = () => {
  const map = new Map<string, unknown>();

  return {
    map,
    // SAFETY: the pool reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, value);
    },
    delete: (key: string) => map.delete(key),
  };
};

export const TIMING = {
  windowMs: 40,
  pollMs: 4,
  unknownGraceMs: 20,
  backoffMs: 5,
  cancelGraceMs: 40,
};

/** A script: "go" calls the tool; an ended entry is answered in words; `extra` answers the rest it knows. */
export type Script = Parameters<typeof open>[0];

export const scripted =
  (extra: (text: string) => ReturnType<typeof call> | undefined = () => undefined): Script =>
  (request) => {
    const { text } = request;
    const more = extra(text);

    if (more !== undefined) return more;

    if (text === "go") return call(["mcp__docs__report", {}]);

    return answer(text.startsWith("[MCP task ended") ? "noted the end" : "ok");
  };

/** What a test changes in the Session around the host. */
export type SetupOptions = {
  readonly servers?: ReadonlyArray<FakeMcpServer>;
  readonly host?: TaskHostOptions;
  readonly redact?: (text: string) => Promise<string>;
  readonly ready?: () => Promise<boolean>;
  readonly offered?: ReadonlyArray<string>;
  /** The Session's questions: a task's are asked through them, and answered through `tasks/update`. */
  readonly questions?: McpToolOptions["questions"];
  readonly sampling?: McpToolOptions["sampling"];
};

export const setup = async (
  polls: number,
  timing: McpTasksTiming = TIMING,
  script: Script = scripted(),
  more: SetupOptions = {},
) => {
  const host = fakeMcpHost(more.servers ?? [SERVER]);
  const taskServer = taskHost(polls, more.host);
  const storage = memory();
  const submitted: unknown[] = [];

  const written: Array<{
    readonly requestId: string;
    readonly kind: string;
    readonly text: string;
  }> = [];

  host.answer(taskServer.answerOf);

  const toolOptions: Mutable<McpToolOptions> = {
    slackMs: 0,
    tasks: {
      storage,
      timing,
      redact: more.redact,
      submitted: (id) => {
        submitted.push(id);
      },
      write: async (_conversation, note) => {
        written.push({
          requestId: note.requestId,
          kind: note.entry.kind,
          text: JSON.stringify(note.entry.model),
        });
      },
    },
  };

  if (more.ready !== undefined) toolOptions.ready = more.ready;

  if (more.questions !== undefined) toolOptions.questions = more.questions;

  if (more.sampling !== undefined) toolOptions.sampling = more.sampling;

  const tools = Mcp.makeMcpTools(host.client, Mcp.memoryMcpToolsStore(), toolOptions);

  const session = await open(script);

  await session.start(tools, startOf(more.servers?.length ?? 1, { offered: more.offered ?? [] }));

  tools.bindTaskHarness(session.harness);

  const toolCalls = () => taskServer.sent.filter((input) => input.op === "tools/call");
  const everything = async () => JSON.stringify(await session.entries());

  return {
    session,
    taskServer,
    storage,
    submitted,
    written,
    toolCalls,
    everything,
    client: host.client,
    tools,
  };
};

/** Run the turn `text` on the root conversation and wait for its answer. */
export const turn = async (session: Awaited<ReturnType<typeof setup>>["session"], text: string) => {
  const submission = await session.root.submit({ type: "input", content: text }, context);

  await submission.wait(context);
};

/** The record of `handle` as the Session's document holds it now. */
export const recordNow = async (
  session: Awaited<ReturnType<typeof setup>>["session"],
  handle: string,
) => (await session.harness.snapshot(McpTasksDoc, context))?.tasks[handle];

/** Whether the task `handle` has ended. */
export const ended =
  (session: Awaited<ReturnType<typeof setup>>["session"], handle = "mcp-task-1") =>
  async () =>
    (await recordNow(session, handle))?.end !== undefined;

/** Whether an entry told the agent a task ended. */
export const toldOfEnd = async (session: Awaited<ReturnType<typeof setup>>["session"]) =>
  (await session.texts("user")).some((text) => text.startsWith("[MCP task ended"));

/** Whether each `tools/call` the host was sent was offered a task. */
export const offers = (taskServer: Awaited<ReturnType<typeof setup>>["taskServer"]) =>
  taskServer.sent.flatMap((input) =>
    input.op === "tools/call" ? [input.ctx.allowTask === true] : [],
  );
