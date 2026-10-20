// @effect-diagnostics asyncFunction:off -- pi-durable commit callbacks are Promise code.
// The six coordinator tools (`docs/spec.md` → Subagents), with pi-minimal-subagents' parameters and semantics, over the
// Subagents document and the tasks in `./tasks.ts`. Each tool that changes state decides in one commit and records its
// result for its own call, so a call rerun after a restart (`replay: "safe"`) returns what the first run decided.
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import type { Draft } from "@earendil-works/chord";
import type { Context as ChordContextValue } from "@earendil-works/chord/context";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  type Agent,
  configure,
  defineDoc,
  InboxDoc,
  type JsonObject,
  LiveDoc,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  type TaskDocToken,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { firstInput, parentContext } from "./context.ts";
import { fail, SubagentError } from "./errors.ts";
import {
  agentDepth,
  CANONICAL,
  childAgentId,
  isWithin,
  normalizeAgentId,
  parentAgentId,
  RESERVED_AGENT_IDS,
  ROOT_AGENT,
  SEGMENT,
} from "./ids.ts";
import { currentOptions, type SubagentOptions } from "./options.ts";
import {
  agentOf,
  type AgentRecord,
  answerText,
  childrenOf,
  EMPTY_STATE,
  openWaiter,
  type SubagentsState,
  SubagentsDoc,
  subtreeOf,
  type Turn,
  type WaitEvent,
  waitEvent,
} from "./state.ts";
import { Anchor, AGENT_INPUT_KIND, envelope, startTurn, WaitTask } from "./tasks.ts";
import {
  coordinatorToolsFor,
  ordinaryTools,
  resolveTools,
  type ToolSelection,
} from "./toolsets.ts";

/** A decision a commit refuses; it rolls the commit back and becomes the call's error. */
// @effect-diagnostics-next-line extendsNativeError:off -- thrown inside a pi-durable commit callback, to roll it back.
class Refusal extends Error {}

/** Run pi-durable call `run` with the fiber's Chord context; a refusal's message is the call's error. */
const durable = <A>(
  operation: string,
  run: (context: ChordContextValue) => Promise<A>,
): Effect.Effect<A, SubagentError> =>
  Effect.gen(function* () {
    const chord = yield* ChordContext;

    return yield* Effect.tryPromise({
      try: (signal) => run(withAbortSignal(signal, chord)),
      catch: (cause) =>
        SubagentError.make({
          message:
            cause instanceof Refusal ? cause.message : `${operation} failed: ${String(cause)}`,
        }),
    });
  });

const refuse = (message: string): never => {
  throw new Refusal(message);
};

/** The result a call recorded, so a rerun returns it instead of deciding again. */
type CallState<T extends JsonObject> = { result: T | null };

const callDoc = <T extends JsonObject>(kind: string): TaskDocToken<CallState<T>> =>
  defineDoc<CallState<T>>({ kind, version: 1, scope: "task", initial: () => ({ result: null }) });

/** What an earlier run of this call recorded, if it got that far. */
const recorded = <T extends JsonObject>(api: ToolExecutionApi, doc: TaskDocToken<CallState<T>>) =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(doc, api.taskId, context)),
    (state) => Option.fromNullishOr(state?.result),
  );

/** Decide in one commit and record the result for this call; a rerun gets the recorded result. */
const decide = Effect.fnUntraced(function* <T extends JsonObject>(
  api: ToolExecutionApi,
  doc: TaskDocToken<CallState<T>>,
  operation: string,
  change: (tx: Tx) => Promise<T>,
): Effect.fn.Return<T, SubagentError> {
  const decided = yield* durable(operation, (context) =>
    api.commit(async (tx) => {
      const call = await tx.doc(doc, api.taskId);

      if (call.result !== null) return undefined;

      const result = await change(tx);

      // SAFETY: a document draft accepts the plain JSON value it holds.
      call.result = result as Draft<T>;

      return result;
    }, context),
  );

  if (decided !== undefined) return decided;

  // An earlier run of this call decided already.
  const found = yield* recorded(api, doc);

  return Option.isSome(found)
    ? found.value
    : yield* fail(`${operation}: its recorded result is missing`);
});

const readState = (api: ToolExecutionApi) =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(SubagentsDoc, context)),
    (state): SubagentsState => state ?? EMPTY_STATE,
  );

/** The agent the calling conversation runs. */
const callerOf = (api: ToolExecutionApi, state: SubagentsState) => {
  const caller = agentOf(state, api.conversationId);

  return caller === undefined
    ? fail("This conversation is not a live agent; it may have been deleted")
    : Effect.succeed(caller);
};

/** `id` as a live agent, or why it is not one. */
const liveAgent = (state: SubagentsState, id: string) => {
  const agent = state.agents[id];

  if (agent !== undefined) return Effect.succeed(agent);

  return fail(
    Arr.contains(state.tombstones, id)
      ? `Agent ${id} was deleted`
      : `No agent ${id}; subagent_status lists your children`,
  );
};

/** `id`, a direct child of `caller`, as a live agent. */
const directChild = (state: SubagentsState, caller: string, id: string) =>
  parentAgentId(id) === caller
    ? liveAgent(state, id)
    : fail(`${id} is not a direct child of ${caller}; you may only address your own children`);

/** An agent as cancel and delete stop it. */
type Stoppable = Pick<AgentRecord, "id" | "conversationId">;

const isBusy = (api: ToolExecutionApi, agent: Stoppable) =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(LiveDoc, agent.conversationId, context)),
    (live) => live?.run !== undefined,
  );

const text = (value: string) => [{ type: "text" as const, text: value }];

/** `provider/modelId` of a model reference. */
const modelId = (model: ModelRef): string => `${model.provider}/${model.modelId}`;

/** The coordinator tools of an agent that may spawn, under the depth cap. */
const canSpawn = (agent: AgentRecord, options: SubagentOptions): boolean =>
  agent.contract.delegation === "fanout" && agent.depth < options.maxSubagentDepth;

/** Every tool an agent has enabled, the ceiling of what it may grant. */
const enabledTools = (agent: Agent): ReadonlyArray<string> =>
  Arr.dedupe(Arr.map([...agent.tools, ...agent.callable, ...agent.deferred], (tool) => tool.name));

/** A child's standing instructions. */
const instructions = (id: string, parent: string, spawns: boolean): string =>
  Arr.join(
    [
      `You are subagent \`${id}\`, a persistent child agent working for \`${parent}\`.`,
      `Your final answer to each input is delivered to \`${parent}\` automatically, so end every turn with a self-contained answer.`,
      "Use agent_message only for coordination that cannot wait for your final answer.",
      ...(spawns
        ? [
            "You may delegate self-contained parts of your work with subagent; their answers arrive as messages.",
          ]
        : []),
    ],
    " ",
  );

const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const CanonicalId = (description: string) =>
  Schema.String.check(Schema.isPattern(CANONICAL)).annotate({ description });

// ─── subagent ────────────────────────────────────────────────────────────────

type SpawnResult = {
  agent_id: string;
  turn_id: string;
  conversation_id: number;
  model: string;
  thinking_level: string;
  role: string | null;
  tools: string[];
  coordinator_tools: string[];
  tool_selection: string;
  delegation: string;
  session_context: string;
  warnings: string[];
};

const SpawnCall = callDoc<SpawnResult>("cloudpid.subagent-call.spawn");

const describeSelection = (result: SpawnResult): string =>
  result.tool_selection === "exact"
    ? `${result.tools.length} exact tools`
    : `the ${result.tool_selection} toolset (${result.tools.length} tools)`;

const spawnText = (result: SpawnResult): string =>
  Arr.join(
    [
      `Spawned ${result.agent_id} (turn ${result.turn_id}) on ${result.model}:${result.thinking_level} with ${describeSelection(result)}, delegation ${result.delegation}.`,
      ...Arr.map(result.warnings, (warning) => `warning: ${warning}`),
    ],
    "\n",
  );

const SpawnParameters = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Self-contained brief for the persistent child agent: the goal and relevant background, target files and non-goals, the change or question, and observable acceptance criteria. Reference large inputs by file path instead of pasting them.",
  }),
  agent_id: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(SEGMENT)).annotate({
      description:
        "Friendly peer-unique ID segment; a root child uses this segment as its canonical ID",
    }),
  ),
  session_context: Schema.optionalKey(
    Schema.Literals(["inherit", "compact", "omit"]).annotate({
      description:
        "Default omit: the child starts blank, so write a self-contained task. inherit quotes your whole conversation (costly); compact summarizes it first (adds a summarization call). Opt in only when the child needs the discussion itself.",
    }),
  ),
  role: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description:
        "Name of a model role listed in the subagent_roles section. Resolves to the role's model; an explicit model overrides it.",
    }),
  ),
  model: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "Model as provider/modelId; default: the role's model, or your own",
    }),
  ),
  thinking_level: Schema.optionalKey(ThinkingLevel),
  tools: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["none", "read", "modify"]),
      Schema.Array(Schema.String.check(Schema.isMinLength(1))),
    ]).annotate({
      description:
        'Presets: "read" grants read, grep, find, ls; "modify" adds bash, edit, write; "none" grants only the base toolset. An array names exact ordinary tools. Omit to grant your own ordinary tools. Grants never exceed your own tools; coordinator tools are granted by delegation and must not appear here.',
    }),
  ),
  delegation: Schema.optionalKey(
    Schema.Literals(["none", "fanout"]).annotate({
      description:
        "fanout lets the child spawn children of its own, below the depth cap; default none",
    }),
  ),
});

type SpawnArgs = typeof SpawnParameters.Type;

/** The model a spawn runs on, and the role it named. */
const resolveModel = Effect.fnUntraced(function* (
  api: ToolExecutionApi,
  args: SpawnArgs,
  options: SubagentOptions,
  caller: Agent,
) {
  const role = args.role === undefined ? undefined : options.roles[args.role];

  if (args.role !== undefined && role === undefined) {
    const names = Record.keys(options.roles);

    return yield* fail(
      `Unknown role ${args.role}. ${names.length === 0 ? "No roles are configured." : `Configured roles: ${Arr.join(names, ", ")}.`}`,
    );
  }

  const explicit = args.model === undefined ? undefined : args.model.split("/");

  const model: ModelRef | undefined =
    explicit === undefined
      ? (role?.model ?? caller.model)
      : { provider: explicit[0] ?? "", modelId: Arr.join(explicit.slice(1), "/") };

  if (model === undefined) return yield* fail("No model to run the subagent on; pass model");

  if (api.models.getModel(model.provider, model.modelId) === undefined) {
    return yield* fail(
      `Model ${modelId(model)} is not available. Available models: ${Arr.join(
        Arr.map(api.models.getModels(), (each) => `${each.provider}/${each.id}`),
        ", ",
      )}`,
    );
  }

  return model;
});

const Spawn = defineEffectTool({
  name: "subagent",
  description:
    "Create a persistent nested agent asynchronously. Returns its canonical agent ID, active turn ID, and resolved model and tools immediately. Root-child IDs omit the root prefix; nested IDs retain the parent path. Children start without your conversation unless session_context opts in, so the task must be self-contained. Its final response is delivered automatically unless you claim it with subagent_wait. To continue an idle child later, send it agent_message; that starts a new turn you can wait on.",
  parameters: SpawnParameters,
  // A spawn must be registered before a wait or message in the same batch can target it.
  executionMode: "sequential",
  replay: "safe",
  execute: Effect.fnUntraced(function* (args: SpawnArgs, api: ToolExecutionApi) {
    const earlier = yield* recorded(api, SpawnCall);

    if (Option.isSome(earlier)) return spawnResult(earlier.value);

    if (args.agent_id !== undefined && RESERVED_AGENT_IDS.has(args.agent_id)) {
      return yield* fail(`${args.agent_id} is reserved; choose another agent_id`);
    }

    const options = yield* currentOptions;
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);

    if (caller === ROOT_AGENT) {
      if (options.maxSubagentDepth < 1) return yield* fail("Subagents are disabled (depth cap 0)");
    } else {
      const record = yield* liveAgent(state, caller);

      if (!canSpawn(record, options)) {
        return yield* fail(
          record.contract.delegation === "fanout"
            ? `${caller} is at the depth cap (${options.maxSubagentDepth}) and cannot spawn subagents`
            : `${caller} was launched with delegation none and cannot spawn subagents`,
        );
      }
    }

    const agent = yield* durable("agent", (context) => api.agent(context));
    const model = yield* resolveModel(api, args, options, agent);
    const thinkingLevel = args.thinking_level ?? agent.thinkingLevel;
    const ceiling = ordinaryTools(enabledTools(agent));
    const selection: ToolSelection | undefined = args.tools;

    const selectionName =
      selection === "none" || selection === "read" || selection === "modify"
        ? selection
        : selection === undefined
          ? "inherit"
          : "exact";

    const resolved = yield* Result.match(resolveTools(selection, ceiling, options.toolsets), {
      onFailure: (message) => fail(message),
      onSuccess: (tools) => Effect.succeed(tools),
    });

    const sessionContext = args.session_context ?? "omit";
    const delegation = args.delegation ?? "none";
    const preamble = yield* parentContext(api, sessionContext, options.roles.small?.model ?? model);
    const now = yield* Clock.currentTimeMillis;
    const installed = api.registry.tools();

    const result = yield* decide(api, SpawnCall, "spawn", async (tx) => {
      const doc = await tx.doc(SubagentsDoc);

      let id: string;

      if (args.agent_id === undefined) {
        let index = doc.nextIndex[caller] ?? 1;

        while (
          doc.agents[childAgentId(caller, `agent-${index}`)] !== undefined ||
          doc.tombstones.includes(childAgentId(caller, `agent-${index}`))
        ) {
          index += 1;
        }

        id = childAgentId(caller, `agent-${index}`);
        doc.nextIndex[caller] = index + 1;
      } else {
        id = childAgentId(caller, args.agent_id);

        if (doc.tombstones.includes(id)) {
          refuse(`${id} was deleted, and deleted IDs are never reused; choose another agent_id`);
        }

        const existing = doc.agents[id];

        if (existing !== undefined) {
          const running = Arr.some(existing.turns, (turn) => turn.status === "running");

          refuse(
            `${id} already exists and is ${running ? "running" : "idle"}; send it agent_message, delete it with subagent_delete, or choose another agent_id`,
          );
        }
      }

      const depth = agentDepth(id);
      const spawns = delegation === "fanout" && depth < options.maxSubagentDepth;
      const coordinator = coordinatorToolsFor(spawns);

      const registrations = Arr.flatMap([...resolved.tools, ...coordinator], (name) =>
        Option.toArray(
          Option.map(
            Arr.findFirst(installed, (each) => each.tool.name === name),
            (each): ToolRegistration => each.tool,
          ),
        ),
      );

      const anchor = await tx.createTask(Anchor, null, {
        ownership: { kind: "conversation" },
        background: true,
      });

      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });

      await configure(tx, child.id, {
        model,
        thinkingLevel,
        tools: registrations,
        modelTools: null,
        instructions: instructions(id, caller, spawns),
      });

      doc.agents[id] = {
        id,
        parent: caller,
        depth,
        conversationId: child.id,
        anchor,
        createdAt: now,
        contract: {
          task: args.task,
          role: args.role ?? null,
          model: modelId(model),
          thinkingLevel,
          tools: [...resolved.tools],
          toolSelection: selectionName,
          delegation,
          sessionContext,
          ceiling: [...ceiling],
        },
        nextTurn: 1,
        turns: [],
      };
      doc.conversations[String(child.id)] = id;

      const turnId = await startTurn(
        tx,
        doc,
        {
          agentId: id,
          content: firstInput(preamble.preamble, args.task),
          whenBusy: "followUp",
          from: caller,
        },
        now,
      );

      return {
        agent_id: id,
        turn_id: turnId ?? "",
        conversation_id: child.id,
        model: modelId(model),
        thinking_level: thinkingLevel,
        role: args.role ?? null,
        tools: [...resolved.tools],
        coordinator_tools: [...coordinator],
        tool_selection: selectionName,
        delegation,
        session_context: sessionContext,
        warnings: [...resolved.warnings],
      } satisfies SpawnResult;
    });

    const spawned = spawnResult(result);

    return preamble.usage === undefined ? spawned : { ...spawned, usage: preamble.usage };
  }),
});

const spawnResult = (result: SpawnResult): ToolExecutionResult => ({
  output: text(spawnText(result)),
  structuredOutput: result,
  details: { agent_id: result.agent_id, conversation_id: result.conversation_id },
});

// ─── agent_message ───────────────────────────────────────────────────────────

type MessageResult = {
  agent_id: string;
  disposition: "delivered-via-wait" | "queued" | "started-turn";
  turn_id: string | null;
  conversation_id: number;
};

const MessageCall = callDoc<MessageResult>("cloudpid.subagent-call.message");

const messageText = (result: MessageResult): string => {
  switch (result.disposition) {
    case "delivered-via-wait":
      return `Message delivered to ${result.agent_id} through its active wait.`;
    case "queued":
      return `Message queued into ${result.agent_id}'s active turn.`;
    case "started-turn":
      return result.turn_id === null
        ? `${result.agent_id} was idle; the message started a new turn.`
        : `${result.agent_id} was idle; the message started turn ${result.turn_id}. Wait on it with subagent_wait.`;
  }
};

/** The caller's running turn, which a message it sends is attributed to. */
const currentTurn = (state: SubagentsState, caller: string): string =>
  caller === ROOT_AGENT
    ? ROOT_AGENT
    : Option.getOrElse(
        Option.map(
          Arr.findLast(state.agents[caller]?.turns ?? [], (turn) => turn.status === "running"),
          (turn) => turn.id,
        ),
        () => "none",
      );

/** The agent `agent_message` addresses: its parent by default or by the `parent` alias, else a canonical ID. */
const messageTarget = (caller: string, requested: string | undefined) => {
  const target =
    requested === undefined || requested === "parent"
      ? parentAgentId(caller)
      : normalizeAgentId(requested);

  if (target === undefined) return fail("The root agent has no parent to message");

  if (target === caller) return fail("An agent cannot message itself");

  const adjacent =
    parentAgentId(caller) === target ||
    parentAgentId(target) === caller ||
    parentAgentId(target) === parentAgentId(caller);

  return adjacent
    ? Effect.succeed(target)
    : fail(`${target} is not your parent, a sibling, or a direct child`);
};

const MessageParameters = Schema.Struct({
  agent_id: Schema.optionalKey(
    CanonicalId("Direct parent, sibling, or child canonical agent ID, or parent alias").pipe((id) =>
      Schema.Union([id, Schema.Literal("parent")]),
    ),
  ),
  message: Schema.String.check(Schema.isMinLength(1)),
});

const Message = defineEffectTool({
  name: "agent_message",
  description:
    "Send one coordination message to a direct parent, direct sibling, or direct child. The result says whether it was delivered through an active wait, queued into the recipient's active turn, or started a new turn on an idle child (with its turn_id).",
  parameters: MessageParameters,
  replay: "safe",
  execute: Effect.fnUntraced(function* (
    { agent_id, message }: typeof MessageParameters.Type,
    api: ToolExecutionApi,
  ) {
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);
    const target = yield* messageTarget(caller, agent_id);

    if (target !== ROOT_AGENT) yield* liveAgent(state, target);

    const content = `${envelope("message", caller, currentTurn(state, caller))}\n${message}`;
    const now = yield* Clock.currentTimeMillis;

    const result = yield* decide(
      api,
      MessageCall,
      "message",
      async (tx): Promise<MessageResult> => {
        const doc = await tx.doc(SubagentsDoc);
        const waiter = openWaiter(doc, target, caller);

        const conversationId =
          target === ROOT_AGENT ? ROOT_CONVERSATION_ID : doc.agents[target]?.conversationId;

        if (conversationId === undefined) return refuse(`Agent ${target} was deleted`);

        if (waiter !== undefined) {
          waiter[1].result = waitEvent("message", caller, {
            turn_id: currentTurn(doc, caller),
            status: "running",
            message,
            elapsed_ms: now - waiter[1].startedAt,
          });

          return {
            agent_id: target,
            disposition: "delivered-via-wait",
            turn_id: null,
            conversation_id: conversationId,
          };
        }

        const busy = (await tx.doc(LiveDoc, conversationId)).run !== undefined;

        const turnId =
          target === ROOT_AGENT
            ? null
            : ((await startTurn(
                tx,
                doc,
                { agentId: target, content, whenBusy: "steer", from: caller },
                now,
              )) ?? null);

        return {
          agent_id: target,
          disposition: busy ? "queued" : "started-turn",
          turn_id: turnId,
          conversation_id: conversationId,
        };
      },
    );

    // The root has no reporter: the message is submitted to it directly, once, by its request ID.
    if (result.agent_id === ROOT_AGENT && result.disposition !== "delivered-via-wait") {
      yield* durable("submit", async (context) => {
        const root = await api.conversation(ROOT_CONVERSATION_ID, context);

        await root?.submit(
          {
            type: "input",
            content,
            whenBusy: "steer",
            requestId: `agent-message:${api.taskId}`,
            entry: { kind: AGENT_INPUT_KIND, data: { from: caller, agent_id: caller } },
          },
          context,
        );
      });
    }

    return {
      output: text(messageText(result)),
      structuredOutput: result,
      details: { agent_id: result.agent_id, conversation_id: result.conversation_id },
    };
  }),
});

// ─── subagent_wait ───────────────────────────────────────────────────────────

type WaitDecision = { event: WaitEvent | null; waitTask: TaskId<WaitEvent> | null };

const WaitCall = callDoc<WaitDecision>("cloudpid.subagent-call.wait");

/** The turn a wait observes: `turnId` exactly, else the oldest running turn, else the latest. */
const selectTurn = (agent: AgentRecord, turnId: string | undefined): Turn | undefined =>
  turnId === undefined
    ? Option.getOrUndefined(
        Option.orElse(
          Arr.findFirst(agent.turns, (turn) => turn.status === "running"),
          () => Arr.last(agent.turns),
        ),
      )
    : Option.getOrUndefined(Arr.findFirst(agent.turns, (turn) => turn.id === turnId));

const waitText = (event: WaitEvent): string => {
  const elapsed = `${(event.elapsed_ms / 1000).toFixed(1)}s`;

  switch (event.event) {
    case "turn": {
      if (event.status === "deleted") return `${event.agent_id} was deleted.`;

      const head = `${event.agent_id} ${event.turn_id ?? ""} ${event.status} (${elapsed})`;

      if (event.already_delivered) {
        return `${head}. Its result was already delivered to you automatically; pass turn_id ${event.turn_id ?? ""} to read it again.`;
      }

      if (event.error !== null) return `${head}: ${event.error}`;

      return `${head}\n\n${event.output ?? ""}`;
    }

    case "message":
      return `Message from ${event.agent_id} (${event.turn_id ?? "no turn"}):\n\n${event.message ?? ""}`;
    case "timeout":
      return `Timed out after ${elapsed}; ${event.agent_id} is ${event.status} on ${event.turn_id ?? "no turn"}. It keeps working; wait again or check subagent_status.`;
    case "steered":
      return `A message is waiting for you, so the wait ended after ${elapsed}; ${event.agent_id} is ${event.status} on ${event.turn_id ?? "no turn"} and keeps working. Wait again to resume.`;
  }
};

const WaitParameters = Schema.Struct({
  agent_id: CanonicalId("Direct child canonical agent ID"),
  turn_id: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "Exact retained child turn ID",
    }),
  ),
  timeout_ms: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const Wait = defineEffectTool({
  name: "subagent_wait",
  description:
    "Wait for one direct child's turn: by default its oldest running turn, else its latest, or an exact retained turn_id. Returns event=turn with the result when the turn settles; event=message when the child messages you first; event=timeout after timeout_ms (the child keeps working); or event=steered when a message is queued for you (wait again to resume). A result already delivered to you automatically is not repeated unless you pass its turn_id.",
  parameters: WaitParameters,
  // A rerun after a restart finds the wait it started and keeps waiting.
  replay: "safe",
  execute: Effect.fnUntraced(function* (
    { agent_id, turn_id, timeout_ms }: typeof WaitParameters.Type,
    api: ToolExecutionApi,
  ) {
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);
    const target = normalizeAgentId(agent_id);
    const agent = yield* directChild(state, caller, target);
    const now = yield* Clock.currentTimeMillis;

    const decision = yield* decide(api, WaitCall, "wait", async (tx) => {
      const doc = await tx.doc(SubagentsDoc);
      const record = doc.agents[target];

      if (record === undefined) return refuse(`Agent ${target} was deleted`);

      const turn = selectTurn(record, turn_id);

      if (turn === undefined) {
        return refuse(
          turn_id === undefined
            ? `${target} has no turns`
            : `${target} has no retained turn ${turn_id}; subagent_status lists its turns`,
        );
      }

      if (turn.status !== "running") {
        const repeat = turn.delivery === "auto" || turn.delivery === "duplicate";

        if (repeat && turn_id === undefined) {
          return {
            event: waitEvent("turn", target, {
              turn_id: turn.id,
              status: turn.status,
              already_delivered: true,
            }),
            waitTask: null,
          };
        }

        // Unreported, or held while this agent is busy: the wait claims it, and the reporter drops its report.
        if (turn.delivery === null || turn.delivery === "pending") turn.delivery = "wait";

        return {
          event: waitEvent("turn", target, {
            turn_id: turn.id,
            status: turn.status,
            output: turn.answer === null ? null : await answerText(tx, turn.answer),
            error: turn.error,
          }),
          waitTask: null,
        };
      }

      if (openWaiter(doc, caller, target) !== undefined) {
        return refuse(`Duplicate wait: you are already waiting for ${target}`);
      }

      const inbox = await tx.doc(InboxDoc, api.conversationId);

      if (Arr.some(inbox.items, (item) => item.mode === "steer") || timeout_ms === 0) {
        return {
          event: waitEvent(timeout_ms === 0 ? "timeout" : "steered", target, {
            turn_id: turn.id,
            status: "running",
          }),
          waitTask: null,
        };
      }

      const waitTask = await tx.createTask(
        WaitTask,
        {
          caller,
          callerConversation: api.conversationId,
          target,
          turnId: turn.id,
          startedAt: now,
          deadline: timeout_ms === undefined ? null : now + timeout_ms,
        },
        { ownership: { kind: "task", taskId: api.taskId } },
      );

      doc.waiters[String(waitTask)] = {
        caller,
        target,
        turnId: turn.id,
        startedAt: now,
        result: null,
      };

      return { event: null, waitTask };
    });

    yield* durable("details", (context) =>
      api.details({ agent_id: target, conversation_id: agent.conversationId }, context),
    );

    const event =
      decision.event ??
      (yield* durable("wait", async (context) => {
        // SAFETY: the decision recorded the ID of the wait task it created.
        const settled = await api.waitForTask(decision.waitTask!, context);

        return settled.state.outcome;
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome.status === "completed"
            ? Effect.succeed(outcome.result)
            : fail(`The wait ended without an event (${outcome.status})`),
        ),
      ));

    return {
      output: text(waitText(event)),
      structuredOutput: event,
      details: { agent_id: target, conversation_id: agent.conversationId },
    };
  }),
});

// ─── subagent_status ─────────────────────────────────────────────────────────

const PREVIEW = 300;

const preview = (value: string, verbose: boolean): string =>
  verbose || value.length <= PREVIEW ? value : `${value.slice(0, PREVIEW)}…`;

/** Total tokens and cost of a conversation's usage. */
const usageOf = (api: ToolExecutionApi, agent: AgentRecord) =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(UsageDoc, agent.conversationId, context)),
    (usage) =>
      Arr.reduce(
        [...Record.values(usage?.models ?? {}), ...Record.values(usage?.tools ?? {})],
        { total_tokens: 0, cost: 0 },
        (sum, each) => ({
          total_tokens: sum.total_tokens + each.totalTokens,
          cost: sum.cost + each.cost.total,
        }),
      ),
  );

const latestOutput = (api: ToolExecutionApi, agent: AgentRecord) => {
  const answer = Option.getOrUndefined(
    Option.flatMapNullishOr(
      Arr.findLast(agent.turns, (turn) => turn.answer !== null),
      (turn) => turn.answer,
    ),
  );

  return answer === undefined
    ? Effect.succeed("")
    : durable("read", (context) => api.commit((tx) => answerText(tx, answer), context));
};

const StatusParameters = Schema.Struct({
  agent_id: Schema.optionalKey(
    CanonicalId("Direct child canonical agent ID; the root may name any descendant"),
  ),
  verbose: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "With agent_id: the full task, latest output, and capability ceiling",
    }),
  ),
});

const Status = defineEffectTool({
  name: "subagent_status",
  description:
    "List direct children when agent_id is omitted, or inspect one direct child's launch contract, turns, latest output, and usage. Without verbose, the task and latest output are short previews. The root may inspect any descendant.",
  parameters: StatusParameters,
  replay: "safe",
  execute: Effect.fnUntraced(function* (
    { agent_id, verbose }: typeof StatusParameters.Type,
    api: ToolExecutionApi,
  ) {
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);

    if (agent_id === undefined) {
      const children = childrenOf(state, caller);

      const rows = yield* Effect.forEach(children, (child) =>
        Effect.map(isBusy(api, child), (busy) => ({
          agent_id: child.id,
          state: busy ? "running" : "idle",
          model: `${child.contract.model}:${child.contract.thinkingLevel}`,
          turns: child.turns.length,
          child_count: childrenOf(state, child.id).length,
        })),
      );

      return {
        output: text(
          rows.length === 0
            ? "No subagents."
            : Arr.join(
                Arr.map(
                  rows,
                  (row) =>
                    `${row.agent_id}: ${row.state}, ${row.model}, ${row.turns} turns${row.child_count === 0 ? "" : `, ${row.child_count} children`}`,
                ),
                "\n",
              ),
        ),
        structuredOutput: { agents: rows },
      };
    }

    const target = normalizeAgentId(agent_id);

    const allowed =
      caller === ROOT_AGENT ? isWithin(target, ROOT_AGENT) : parentAgentId(target) === caller;

    if (!allowed) return yield* fail(`${target} is not a direct child of ${caller}`);

    const agent = yield* liveAgent(state, target);
    const busy = yield* isBusy(api, agent);
    const usage = yield* usageOf(api, agent);
    const output = yield* latestOutput(api, agent);
    const full = verbose === true;
    const { contract } = agent;

    const record = {
      agent_id: agent.id,
      parent_id: agent.parent,
      state: busy ? "running" : "idle",
      conversation_id: agent.conversationId,
      model: contract.model,
      thinking_level: contract.thinkingLevel,
      role: contract.role,
      tools: contract.tools,
      tool_selection: contract.toolSelection,
      delegation: contract.delegation,
      session_context: contract.sessionContext,
      capability_ceiling: contract.ceiling,
      task: contract.task,
      child_count: childrenOf(state, agent.id).length,
      turns: Arr.map(agent.turns, (turn) => ({
        turn_id: turn.id,
        status: turn.status,
        delivery: turn.delivery,
      })),
      latest_output: output,
      usage,
    };

    const lines = [
      `${agent.id}: ${record.state}, ${contract.model}:${contract.thinkingLevel}${contract.role === null ? "" : ` (role ${contract.role})`}, delegation ${contract.delegation}, ${record.child_count} children, ${usage.total_tokens} tokens, $${usage.cost.toFixed(4)}`,
      `tools (${contract.toolSelection}): ${contract.tools.length === 0 ? "none" : Arr.join(contract.tools, ", ")}`,
      ...(full ? [`capability ceiling: ${Arr.join(contract.ceiling, ", ")}`] : []),
      `turns: ${Arr.join(
        Arr.map(
          agent.turns,
          (turn) =>
            `${turn.id} ${turn.status}${turn.delivery === null ? "" : ` (${turn.delivery})`}`,
        ),
        ", ",
      )}`,
      `task: ${preview(contract.task, full)}`,
      ...(output === "" ? [] : [`latest output: ${preview(output, full)}`]),
    ];

    return {
      output: text(Arr.join(lines, "\n")),
      structuredOutput: record,
      details: { agent_id: agent.id, conversation_id: agent.conversationId },
    };
  }),
});

// ─── subagent_cancel and subagent_delete ─────────────────────────────────────

/** Abort the work of `agents`, deepest first; which of them were running. */
const stopAll = (api: ToolExecutionApi, agents: ReadonlyArray<Stoppable>, background: boolean) =>
  Effect.map(
    Effect.forEach(agents, (agent) =>
      Effect.flatMap(isBusy(api, agent), (busy) =>
        durable("abort", async (context) => {
          const conversation = await api.conversation(agent.conversationId, context);

          await conversation?.abort(context, { background });

          return busy ? [agent.id] : [];
        }),
      ),
    ),
    Arr.flatten,
  );

/**
 * Abort `target`, with its subtree when `recursive`, then again for any descendant spawned while it was being stopped,
 * until none is left running unstopped. Returns which agents were running, and every agent stopped.
 */
const stopSubtree = Effect.fnUntraced(function* (
  api: ToolExecutionApi,
  target: string,
  recursive: boolean,
) {
  const stopped = new Set<string>();
  const affected: string[] = [];

  for (;;) {
    const state = yield* readState(api);

    const scope = recursive
      ? subtreeOf(state, target)
      : Option.toArray(Record.get(state.agents, target));

    const fresh = Arr.filter(scope, (agent) => !stopped.has(agent.id));

    if (fresh.length === 0) return { affected, stopped };

    for (const agent of fresh) stopped.add(agent.id);

    affected.push(...(yield* stopAll(api, fresh, recursive)));
  }
});

const CancelParameters = Schema.Struct({
  agent_id: CanonicalId("Direct child canonical agent ID"),
  recursive: Schema.optionalKey(Schema.Boolean),
});

const Cancel = defineEffectTool({
  name: "subagent_cancel",
  description:
    "Abort active work for one direct child while keeping it for later continuation. Recursive cancellation includes its subtree and defaults to true.",
  parameters: CancelParameters,
  execute: Effect.fnUntraced(function* (
    { agent_id, recursive }: typeof CancelParameters.Type,
    api: ToolExecutionApi,
  ) {
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);
    const target = normalizeAgentId(agent_id);
    const agent = yield* directChild(state, caller, target);
    const { affected } = yield* stopSubtree(api, agent.id, recursive ?? true);

    return {
      output: text(
        affected.length === 0
          ? `Nothing was running under ${target}.`
          : `Cancelled ${Arr.join(affected, ", ")}.`,
      ),
      structuredOutput: { agent_id: target, affected_agent_ids: affected },
    };
  }),
});

const DeleteParameters = Schema.Struct({
  agent_id: CanonicalId("Direct child canonical agent ID"),
  recursive: Schema.optionalKey(Schema.Boolean),
});

const Delete = defineEffectTool({
  name: "subagent_delete",
  description:
    "Delete one direct child, stopping its work, and tombstone its ID so it is never reused. Recursive deletion includes its subtree and defaults to true.",
  parameters: DeleteParameters,
  execute: Effect.fnUntraced(function* (
    { agent_id, recursive }: typeof DeleteParameters.Type,
    api: ToolExecutionApi,
  ) {
    const state = yield* readState(api);
    const caller = yield* callerOf(api, state);
    const target = normalizeAgentId(agent_id);

    if (parentAgentId(target) === caller && Arr.contains(state.tombstones, target)) {
      return {
        output: text(`${target} was already deleted.`),
        structuredOutput: { agent_id: target, deleted_agent_ids: [] },
      };
    }

    yield* directChild(state, caller, target);

    const subtree = subtreeOf(state, target);

    if (subtree.length > 1 && recursive === false) {
      return yield* fail(
        `${target} has children (${Arr.join(
          Arr.flatMap(subtree, (agent) => (agent.id === target ? [] : [agent.id])),
          ", ",
        )}); pass recursive: true or delete them first`,
      );
    }

    const { stopped } = yield* stopSubtree(api, target, true);

    // The subtree as it is now: a descendant spawned after the last scan is deleted too, and stopped below. Once its
    // conversation is unmapped, no deleted agent can spawn again.
    const removed = yield* durable("delete", (context) =>
      api.commit(async (tx) => {
        const doc = await tx.doc(SubagentsDoc);
        const gone: Stoppable[] = [];

        for (const agent of subtreeOf(doc, target)) {
          delete doc.agents[agent.id];
          delete doc.conversations[String(agent.conversationId)];
          doc.tombstones.push(agent.id);
          gone.push({ id: agent.id, conversationId: agent.conversationId });
        }

        const ids = Arr.map(gone, (agent) => agent.id);

        for (const [key, waiter] of Record.toEntries(doc.waiters)) {
          if (!ids.includes(waiter.target) || waiter.result !== null) continue;

          const entry = doc.waiters[key];

          if (entry !== undefined) {
            entry.result = waitEvent("turn", waiter.target, {
              turn_id: waiter.turnId,
              status: "deleted",
            });
          }
        }

        return gone;
      }, context),
    );

    yield* stopAll(
      api,
      Arr.filter(removed, (agent) => !stopped.has(agent.id)),
      true,
    );

    const deleted = Arr.map(removed, (agent) => agent.id);

    return {
      output: text(
        deleted.length === 0
          ? `${target} was already deleted.`
          : `Deleted ${Arr.join(deleted, ", ")}; their IDs are retired.`,
      ),
      structuredOutput: { agent_id: target, deleted_agent_ids: deleted },
    };
  }),
});

/** The six coordinator tools. */
export const coordinatorTools = Effect.all([Spawn, Message, Wait, Status, Cancel, Delete]);
