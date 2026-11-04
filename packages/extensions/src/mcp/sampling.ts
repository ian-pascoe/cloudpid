// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off -- the Session's model seam is pi-ai's Promise streams, and these are plain functions over values.
// A Legacy server's Sampling request, run on the owner's models (`docs/architecture/mcp-server-requests.md` → Sampling
// requests; ADR-0039): a completion of its own through the Session's `Models` (`models.stream`), so the Secret scrubbing,
// the Spend limit and the spans of every other model request apply, with nothing of cloudpid's in it. The server's system
// prompt, messages and tools go in; the reply goes back only to the server.
//
// What is here: the caps (20 samples per call), the rate (2 at once and 30 a minute per server, which delay and never
// refuse), the checks that refuse a request cloudpid cannot serve before it costs anything (the pairing rules, the
// bounds, the Spend limit), the Role and the model, the sample with its 2-minute bound, the Usage it cost, and the
// record. A request is answered `-1` when it is turned down, `-32602` when it is invalid or cannot be served, and
// `-32603` when the model fails. Only a server whose definition says `sampling: "allow"` is answered here: the owner's
// yes on a card is not built yet.
import { ROLE_NAMES, type RoleName } from "@cloudpid/config";
import type { JsonObject, McpSamplingResult } from "@cloudpid/mcp/types";
import type {
  Api,
  Context as ModelContext,
  Model,
  Models,
  ModelsApiStreamOptions,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { Mutable } from "effect/Types";
import type { McpSamplingDetail } from "./details.ts";
import type { McpQuestionStorage } from "./question-records.ts";
import {
  cutText,
  type McpSamplingRecord,
  samplingRecords,
  SAMPLING_RECORD_TEXT,
} from "./sampling-records.ts";
import { pairingProblem, toPiMessages } from "./sampling-messages.ts";
import {
  AUTOMATIC_CEILING,
  chooseRole,
  lowestAvailable,
  type RoleModel,
  toolChoiceFor,
} from "./sampling-model.ts";
import { blocksOf, decodeSamplingParams, type SamplingParams } from "./sampling-params.ts";
import { replyOf } from "./sampling-reply.ts";

export type { McpSamplingRecord } from "./sampling-records.ts";

/** The most Sampling requests one call may make, whatever was allowed. */
export const MCP_SAMPLINGS_PER_CALL = 20;

/** The most tokens a sample may be asked for. */
export const SAMPLING_MAX_TOKENS = 8192;

/** How long a sample may take: 2 minutes. */
export const SAMPLING_SAMPLE_MS = 2 * 60 * 1000;

/** The most tools, and the most bytes of their schemas, a request may offer. */
export const SAMPLING_MAX_TOOLS = 64;

export const SAMPLING_MAX_SCHEMA_BYTES = 256 * 1024;

/** The most samples at once, and in a minute, for one server of a Session. */
export const SAMPLING_CONCURRENT = 2;

export const SAMPLING_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

/** The model of each Role the Settings in force name, as pi-durable's `ModelRef` holds it. */
export type McpSamplingRoles = Readonly<
  Partial<Record<RoleName, { readonly provider: string; readonly modelId: string }>>
>;

/** What the Session gives the sampler once its Harness is open: the models, its Roles, the limit and where Usage goes. */
export type McpSamplingBinding = {
  /** The Session's `Models`: scrubbed of its Secrets, held to its Spend limit, each request a span. */
  readonly models: Models;
  /** The model of each Role the Settings in force name, as `provider/modelId`. */
  readonly roles: () => McpSamplingRoles;
  /** Why the Spend limit stops a sample now, or undefined when it does not (checked before the sample is made). */
  readonly overLimit: () => Promise<string | undefined>;
  /** A sample ended: what it cost is the Session's, by the conversation and the server. */
  readonly usage: (
    who: { readonly conversationId: number; readonly server: string },
    usage: Usage,
  ) => void;
};

/** One request, as the call that carries it knows it. */
export type McpSamplingAsk = {
  readonly server: string;
  /** The model-facing name of the tool whose call the request came in. */
  readonly tool: string;
  readonly callId: string;
  readonly conversationId: number;
  /** The server's own request id. */
  readonly key: string;
  readonly params: JsonObject;
  /** Aborts when Stop does. */
  readonly signal?: AbortSignal | undefined;
};

/** What a request came to: the reply for the server, or the refusal it is answered with. */
export type McpSamplingOutcome =
  | {
      readonly kind: "sampled";
      readonly result: McpSamplingResult;
      readonly detail: McpSamplingDetail;
    }
  | {
      readonly kind: "refused";
      /** `-1` a refusal, `-32602` invalid or unservable, `-32603` a model failure. */
      readonly code: number;
      readonly message: string;
      readonly detail: McpSamplingDetail;
    };

/** The Session's sampler (an implementation word, not a GLOSSARY term). */
export type McpSamplingService = {
  /** Run one Sampling request. Never fails: every end is an outcome. */
  readonly sample: (ask: McpSamplingAsk) => Effect.Effect<McpSamplingOutcome>;
  /** The call is over: its count and the messages its records were taken against are forgotten. */
  readonly settleCall: (callId: string) => Effect.Effect<void>;
  /** The models and the rest, bound once the Session's Harness is open; a request before that is refused. */
  readonly bind: (binding: McpSamplingBinding) => void;
  /** The records kept, oldest first. */
  readonly records: Effect.Effect<ReadonlyArray<McpSamplingRecord>>;
};

export class McpSampling extends Context.Service<McpSampling, McpSamplingService>()(
  "@cloudpid/extensions/mcp/sampling/McpSampling",
) {}

export type McpSamplingOptions = {
  readonly storage: McpQuestionStorage;
  /** `value` with every Secret the Session holds replaced by its reference: what a record keeps, and the tools a model sees. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
};

type Pace = {
  readonly active: Semaphore.Semaphore;
  readonly stamps: Array<number>;
};

/** The model of `role` the Session's models list, or undefined. */
const modelOf = (
  models: Models,
  roles: McpSamplingRoles,
  role: RoleName,
): Model<Api> | undefined => {
  const ref = roles[role];

  return ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
};

/** The sampler over `options.storage`. Synchronous: the tools that ask are built before the runtime. */
export const createMcpSampling = (options: McpSamplingOptions): McpSamplingService => {
  const store = samplingRecords(options.storage);
  const counts = new Map<string, number>();
  const taken = new Map<string, ReadonlyArray<string>>();
  const paces = new Map<string, Pace>();
  let binding: McpSamplingBinding | undefined;

  const paceOf = (server: string): Pace => {
    const held = paces.get(server);

    if (held !== undefined) return held;

    const made: Pace = { active: Semaphore.makeUnsafe(SAMPLING_CONCURRENT), stamps: [] };

    paces.set(server, made);

    return made;
  };

  /** Wait until the server has had fewer than `SAMPLING_PER_MINUTE` samples in the last minute, then count this one. */
  const pace = (server: string) =>
    Effect.gen(function* () {
      const { stamps } = paceOf(server);

      while (true) {
        const now = yield* Clock.currentTimeMillis;

        while (stamps.length > 0 && (stamps[0] ?? now) <= now - MINUTE_MS) stamps.shift();

        if (stamps.length < SAMPLING_PER_MINUTE) {
          stamps.push(now);

          return;
        }

        yield* Effect.sleep((stamps[0] ?? now) + MINUTE_MS - now);
      }
    });

  const sample = (ask: McpSamplingAsk): Effect.Effect<McpSamplingOutcome> =>
    Effect.gen(function* () {
      const askedAt = yield* Clock.currentTimeMillis;
      const sequence = (counts.get(ask.callId) ?? 0) + 1;

      counts.set(ask.callId, sequence);

      const id = `${ask.callId}:${sequence}`;
      const notes: Array<string> = [];

      let record: McpSamplingRecord = {
        id,
        server: ask.server,
        tool: ask.tool,
        origin: "agent",
        conversationId: ask.conversationId,
        callId: ask.callId,
        sequence,
        status: "running",
        by: "definition",
        notes,
        askedAt,
      };

      /** Settle the record, redacted, and the request's outcome. */
      const end = (
        status: "refused" | "failed",
        code: number,
        message: string,
        by: "definition" | "cloudpid" = "cloudpid",
      ): Effect.Effect<McpSamplingOutcome> =>
        Effect.gen(function* () {
          const settledAt = yield* Clock.currentTimeMillis;

          record = { ...record, status, reason: message, by, settledAt };
          yield* keep(record);

          return {
            kind: "refused",
            code,
            message,
            detail: detailOf(record),
          } satisfies McpSamplingOutcome;
        });

      /** Write the record redacted; a write the storage refuses is told as false. */
      const keep = (next: McpSamplingRecord) =>
        options
          .redact(next)
          .pipe(
            Effect.flatMap((redacted) =>
              Effect.suspend(() =>
                Clock.currentTimeMillis.pipe(Effect.map((now) => store.put(redacted, now))),
              ),
            ),
          );

      const detailOf = (settled: McpSamplingRecord): McpSamplingDetail => {
        const detail: Mutable<McpSamplingDetail> = {
          server: ask.server,
          status: settled.status === "running" ? "failed" : settled.status,
          by: settled.by,
        };

        if (settled.reason !== undefined) detail.reason = settled.reason;

        if (settled.role !== undefined) detail.role = settled.role;

        if (settled.model !== undefined) detail.model = settled.model;

        if (settled.tokens !== undefined) detail.tokens = settled.tokens;

        if (settled.cost !== undefined) detail.cost = settled.cost;

        return detail;
      };

      if (sequence > MCP_SAMPLINGS_PER_CALL) {
        return yield* end("refused", -1, "sampling limit for this call reached");
      }

      const bound = binding;

      if (bound === undefined) {
        return yield* end("refused", -32603, "the Session's models are not ready yet");
      }

      const decoded = decodeSamplingParams(ask.params);

      if (Option.isNone(decoded)) {
        return yield* end(
          "refused",
          -32602,
          "invalid sampling request: its parameters are malformed",
        );
      }

      const params: SamplingParams = decoded.value;

      record = {
        ...record,
        ...(yield* summaryOf(params, taken.get(ask.callId), options.redact)),
      };

      const problem = pairingProblem(params.messages);

      if (problem !== undefined)
        return yield* end("refused", -32602, `invalid sampling messages: ${problem}`);

      const tooLarge = boundsProblem(params);

      if (tooLarge !== undefined)
        return yield* end("refused", -32602, `invalid sampling request: ${tooLarge}`);

      taken.set(
        ask.callId,
        Arr.map(params.messages, (message) => JSON.stringify(message)),
      );

      const over = yield* Effect.tryPromise(() => bound.overLimit()).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (over !== undefined) return yield* end("refused", -1, `out of budget: ${over}`);

      // The model: the Role the server's preferences ask for, lowered to the first Role whose model the Session has.
      const roles = bound.roles();

      const named: Array<RoleModel> = [];

      for (const each of ROLE_NAMES) {
        const held = roles[each];

        if (held !== undefined) named.push({ role: each, id: held.modelId });
      }

      const chosen = chooseRole(params.modelPreferences, named);

      if (chosen.clamped) {
        notes.push(
          `the server's hint asked for a larger model; automatic choice stops at ${AUTOMATIC_CEILING}`,
        );
      }

      const role = lowestAvailable(
        chosen.role,
        (each) => modelOf(bound.models, roles, each) !== undefined,
      );

      const model = role === undefined ? undefined : modelOf(bound.models, roles, role);

      if (role === undefined || model === undefined) {
        return yield* end("refused", -32602, "no model is available for this request");
      }

      record = { ...record, role, model: model.id };

      if (params.includeContext !== undefined && params.includeContext !== "none") {
        notes.push("asked to include context; none given");
      }

      if (params.stopSequences !== undefined && params.stopSequences.length > 0) {
        notes.push("stopSequences were not passed");
      }

      const converted = toPiMessages(params.messages, model, askedAt);

      if (converted.kind === "refused") {
        return yield* end("refused", -32602, `unservable sampling request: ${converted.reason}`);
      }

      const offered = params.tools ?? [];
      const choice = toolChoiceFor(model.api, params.toolChoice?.mode);

      if (choice.note !== undefined) notes.push(choice.note);

      if (model.api === "anthropic-messages" && Arr.some(offered, flattens)) {
        notes.push("a tool's schema was flattened for the model: $defs or oneOf may be lost");
      }

      // Scrubbing covers messages and the system prompt; the server's tool definitions are redacted here.
      const tools: Array<Tool> = yield* options.redact(
        Arr.map(offered, (tool) => ({
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          // SAFETY: the server's JSON Schema, which pi-ai's `TSchema` describes.
          parameters: tool.inputSchema as Tool["parameters"],
        })),
      );

      const systemPrompt =
        params.systemPrompt === undefined ? undefined : yield* options.redact(params.systemPrompt);

      const context: Mutable<ModelContext> = { messages: converted.messages };

      if (systemPrompt !== undefined) context.systemPrompt = systemPrompt;

      if (tools.length > 0 && choice.value !== "none") context.tools = tools;

      const transcript = normalizeContext(context);

      if (estimateContextTokens(transcript).tokens >= model.contextWindow) {
        return yield* end("refused", -32602, "the request does not fit the model's context window");
      }

      const maxTokens = clampMaxTokensToContext(
        model,
        transcript,
        Math.min(params.maxTokens, SAMPLING_MAX_TOKENS, model.maxTokens),
      );

      const kept = yield* keep(record);

      // A replaced Session, whose storage cannot take the record, cannot count the sample either: refused.
      if (!kept) return yield* end("refused", -1, "cloudpid could not record the request");

      const sampled = yield* pace(ask.server).pipe(
        Effect.andThen(
          paceOf(ask.server).active.withPermit(
            Effect.tryPromise(() =>
              run(bound, model, context, maxTokens, params, choice.value, ask.signal),
            ),
          ),
        ),
        Effect.result,
      );

      if (Result.isFailure(sampled)) {
        return yield* end("refused", -32603, "the model could not be reached");
      }

      const { message, timedOut } = sampled.success;

      bound.usage({ conversationId: ask.conversationId, server: ask.server }, message.usage);

      record = {
        ...record,
        tokens: message.usage.totalTokens,
        cost: message.usage.cost.total,
      };

      const replied = replyOf(message, offered.length > 0 && choice.value !== "none");

      if (replied.kind === "failed") {
        const reason = timedOut ? "the sample took longer than 2 minutes" : replied.reason;

        return yield* end("failed", -32603, reason);
      }

      const settledAt = yield* Clock.currentTimeMillis;

      record = {
        ...record,
        status: "answered",
        reply: replied.result.content,
        stopReason: replied.stopReason,
        model: replied.result.model,
        settledAt,
      };
      yield* keep(record);

      return {
        kind: "sampled",
        result: replied.result,
        detail: detailOf(record),
      } satisfies McpSamplingOutcome;
    }).pipe(
      Effect.withSpan("mcp.sampling.sample", { attributes: { "mcp.server": ask.server } }),
      // Whatever goes wrong inside is a failure of the model seam, told to the server as one.
      Effect.catchCause((cause) =>
        Effect.logWarning("A Sampling request could not be answered", cause).pipe(
          Effect.as({
            kind: "refused",
            code: -32603,
            message: "cloudpid could not answer the sampling request",
            detail: { server: ask.server, status: "failed", by: "cloudpid" },
          } satisfies McpSamplingOutcome),
        ),
      ),
    );

  return {
    sample,
    settleCall: (callId) =>
      Effect.sync(() => {
        counts.delete(callId);
        taken.delete(callId);
      }),
    bind: (next) => {
      binding = next;
    },
    records: Effect.sync(() => store.list()),
  };
};

/** Whether a tool's schema has what a non-strict flattening may lose. */
const flattens = (tool: { readonly inputSchema: unknown }): boolean => {
  const text = JSON.stringify(tool.inputSchema);

  return text.includes('"$defs"') || text.includes('"oneOf"');
};

/** The request's bounds: the tools offered and their schemas. */
const boundsProblem = (params: SamplingParams): string | undefined => {
  const tools = params.tools ?? [];

  if (tools.length > SAMPLING_MAX_TOOLS) return `it offers more than ${SAMPLING_MAX_TOOLS} tools`;

  const bytes = new TextEncoder().encode(
    JSON.stringify(Arr.map(tools, (tool) => tool.inputSchema)),
  ).byteLength;

  return bytes > SAMPLING_MAX_SCHEMA_BYTES ? "its tool schemas are over 256 KiB" : undefined;
};

/** One sample: the model's reply, and whether the 2 minutes ran out. */
const run = async (
  bound: McpSamplingBinding,
  model: Model<Api>,
  context: ModelContext,
  maxTokens: number,
  params: SamplingParams,
  toolChoice: "any" | "required" | "none" | undefined,
  stopped: AbortSignal | undefined,
) => {
  const limit = AbortSignal.timeout(SAMPLING_SAMPLE_MS);
  const signal = stopped === undefined ? limit : AbortSignal.any([limit, stopped]);

  const options: Mutable<Omit<ModelsApiStreamOptions<"anthropic-messages">, "toolChoice">> & {
    toolChoice?: "any" | "required" | "none";
  } = {
    maxTokens,
    signal,
  };

  if (params.temperature !== undefined) options.temperature = params.temperature;

  // The API's own spelling of the choice, chosen from the model's API by `toolChoiceFor`; thinking is left off.
  if (toolChoice !== undefined) options.toolChoice = toolChoice;

  // SAFETY: the options of the model's own API, whose `toolChoice` `toolChoiceFor` spelled for it.
  const message = await bound.models
    .stream(model, context, options as Parameters<Models["stream"]>[2])
    .result();

  return { message, timedOut: limit.aborted };
};

/** What a record starts from: the preferences, the system prompt and the messages (those past the call's earlier request's). */
const summaryOf = (
  params: SamplingParams,
  earlier: ReadonlyArray<string> | undefined,
  redact: McpSamplingOptions["redact"],
) =>
  Effect.gen(function* () {
    const texts = Arr.map(params.messages, (message) => JSON.stringify(message));
    let shared = 0;

    while (
      shared < texts.length &&
      shared < (earlier?.length ?? 0) &&
      texts[shared] === earlier?.[shared]
    ) {
      shared += 1;
    }

    const messages = Arr.map(params.messages.slice(shared), (message) => cutMessage(message));
    const prefs = params.modelPreferences;
    const hints: Array<string> = [];

    for (const hint of prefs?.hints ?? []) {
      if (hint.name !== undefined) hints.push(hint.name);
    }

    const summary: Mutable<Partial<McpSamplingRecord>> = {
      messages: yield* redact(messages),
      tools: Arr.map(params.tools ?? [], (tool) => tool.name),
    };

    if (shared > 0) summary.messagesFrom = shared;

    if (hints.length > 0) summary.hints = hints;

    if (prefs !== undefined) {
      const priorities: Mutable<NonNullable<McpSamplingRecord["priorities"]>> = {};

      if (prefs.costPriority !== undefined) priorities.cost = prefs.costPriority;

      if (prefs.speedPriority !== undefined) priorities.speed = prefs.speedPriority;

      if (prefs.intelligencePriority !== undefined) {
        priorities.intelligence = prefs.intelligencePriority;
      }

      if (
        Arr.some(
          [priorities.cost, priorities.speed, priorities.intelligence],
          (v) => v !== undefined,
        )
      ) {
        summary.priorities = priorities;
      }
    }

    if (params.systemPrompt !== undefined) {
      summary.systemPrompt = yield* redact(cutText(params.systemPrompt, SAMPLING_RECORD_TEXT));
    }

    if (params.toolChoice?.mode !== undefined) summary.toolChoice = params.toolChoice.mode;

    return summary;
  });

/** `message` with each text cut at `SAMPLING_RECORD_TEXT` (an image's data is left out). */
const cutMessage = (message: SamplingParams["messages"][number]): Schema.Json => ({
  role: message.role,
  content: Arr.map(blocksOf(message), (block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: cutText(block.text, SAMPLING_RECORD_TEXT) };
      case "image":
        return { type: "image", mimeType: block.mimeType };
      case "audio":
        return { type: "audio", mimeType: block.mimeType };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return {
          type: "tool_result",
          toolUseId: block.toolUseId,
          isError: block.isError === true,
          text: cutText(
            Arr.join(
              Arr.map(block.content, (part) =>
                part.type === "text" ? part.text : `[${part.type}]`,
              ),
              "\n",
            ),
            SAMPLING_RECORD_TEXT,
          ),
        };
    }
  }),
});
