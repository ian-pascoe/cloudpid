// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off -- the Session's model seam is pi-ai's Promise streams, and these are plain functions over values.
// A server's Sampling request, run on the owner's models (`docs/architecture/mcp-server-requests.md` → Sampling
// requests; ADR-0039): a completion of its own through the Session's `Models` (`models.stream`), so the Secret scrubbing,
// the Spend limit and the spans of every other model request apply, with nothing of cloudpid's in it. The server's system
// prompt, messages and tools go in; the reply goes back only to the server.
//
// What is here: the caps (20 samples per call), the rate (2 at once and 30 a minute per server, which delay and never
// refuse), the checks that refuse a request cloudpid cannot serve before it costs anything (the pairing rules, the
// bounds, the Spend limit), the Role and the model, the sample with its 2-minute bound, the Usage it cost, and the
// record. A request is answered `-1` when it is turned down, `-32602` when it is invalid or cannot be served, and
// `-32603` when the model fails. A server whose definition says `sampling: "allow"` is answered at once; one that says
// `ask` (the default) is answered after the owner's yes on a card (`./sampling-questions.ts`), or a grant of theirs. A
// Modern server's request on a call that keeps its questions for later is checked, then kept with the call's round
// (`deferred`) for the owner; when the round resumes the same request is run again with what the owner decided
// (`resumed`): the checks again, the Role, the sample, the record as the same one.
import { type McpSampledMode, ROLE_NAMES, type RoleName } from "@cloudpid/config";
import type {
  McpElicitationSource,
  McpSamplingRecordView,
  McpSamplingRequest,
} from "@cloudpid/protocol";
import {
  type JsonObject,
  MCP_INTERNAL_ERROR,
  MCP_INVALID_PARAMS,
  MCP_SAMPLING_REFUSED,
  type McpSamplingResult,
} from "@cloudpid/mcp/types";
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
import type { McpSamplingDetail, McpSamplingWhy } from "./details.ts";
import {
  askOriginOf,
  type McpQuestionStorage,
  type McpSamplingDecision,
} from "./question-records.ts";
import type { McpQuestionsService } from "./questions.ts";
import { cardMessages, recordView } from "./sampling-card.ts";
import { MCP_APP_HIDDEN_REASON, type McpSamplingCard, stoppedBy } from "./sampling-questions.ts";
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
  /** The model-facing name of the tool whose call the request came in; for a prompt send, the prompt's command. */
  readonly tool: string;
  /** The title of the MCP prompt whose `prompts/get` the request came in, when it is a prompt send's. */
  readonly prompt?: string | undefined;
  /** Whether the request came in an App View's `tools/call`: it waits live, 5 min, and tells the owner nothing. */
  readonly app?: true | undefined;
  /** The handle of the MCP task whose question it is, when it is one's: `callId` is then the task's key (`taskOwner`). */
  readonly task?: string | undefined;
  readonly callId: string;
  readonly conversationId: McpSamplingRequest["conversationId"];
  /** The server's own request id. */
  readonly key: string;
  readonly params: JsonObject;
  /** Aborts when Stop does. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Aborts when only a card still waiting for the owner is to be withdrawn, an App View's page hidden: the request is
   * refused as stopped. One that needs no card (`allow`), or whose owner has decided, is unaffected.
   */
  readonly withdraw?: AbortSignal | undefined;
  /** What the server's definition says: `allow` answers without asking, `ask` asks the owner on a card first. */
  readonly decision: McpSampledMode;
  /**
   * The call keeps a Modern server's questions for later: an `ask` request the owner has not decided yet is kept with the
   * call's round (`kind: "deferred"`) instead of waiting on a card here.
   */
  readonly defers?: boolean | undefined;
  /**
   * A request that was kept, run when its round resumes: the id and number it was kept under, and what the owner decided.
   * Its card is not shown again, and its record goes on from the one written while it waited.
   */
  readonly resumed?:
    | {
        readonly id: string;
        readonly sequence: number;
        readonly decision: McpSamplingDecision;
      }
    | undefined;
  /** Where the server's definition is, for the card's badge. */
  readonly source?: McpElicitationSource | undefined;
  /** Stop the call's own clock while the owner decides, and start it again. */
  readonly hold?:
    | { readonly pause: Effect.Effect<void>; readonly resume: Effect.Effect<void> }
    | undefined;
};

/** What a request came to: the reply for the server, the refusal it is answered with, or its keeping for later. */
export type McpSamplingOutcome =
  /** A Modern server's request, kept with the call's round: its answer comes when the round resumes. */
  | { readonly kind: "deferred" }
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
  /** The record `id`, as a card reads it (`mcp_sampling_get`); undefined when none is kept. */
  readonly view: (id: string) => Effect.Effect<McpSamplingRecordView | undefined>;
};

export class McpSampling extends Context.Service<McpSampling, McpSamplingService>()(
  "@cloudpid/extensions/mcp/sampling/McpSampling",
) {}

export type McpSamplingOptions = {
  readonly storage: McpQuestionStorage;
  /** `value` with every Secret the Session holds replaced by its reference: what a record keeps, and the tools a model sees. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
  /** The Session's questions, which ask the owner of a server whose definition says `ask`; without them none is answered. */
  readonly questions?:
    | Pick<
        McpQuestionsService,
        "askSampling" | "samplingStanding" | "deferSampling" | "sampledCount" | "noteSampled"
      >
    | undefined;
};

/** A request prepared to run on a Role: what the sample needs of it. */
type Ready = {
  readonly kind: "ready";
  readonly role: RoleName;
  readonly model: Model<Api>;
  readonly context: ModelContext;
  readonly choice: "any" | "required" | "none" | undefined;
  readonly maxTokens: number;
  /** Whether the request offers the model tools. */
  readonly offered: boolean;
  readonly notes: ReadonlyArray<string>;
};

type Pace = {
  readonly active: Semaphore.Semaphore;
  readonly stamps: Array<number>;
};

/** Why a request is refused when its record cannot be kept, which a replaced Session's storage cannot do. */
const UNRECORDED_REASON = "cloudpid could not record the request";

/** Why a request is refused when the Spend limit stops it, with the Session's own words for it. */
const overLimitReason = (over: string): string => `out of budget: ${over}`;

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
  const asking = options.questions;
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
      const now = yield* Clock.currentTimeMillis;
      // A request run again after it was kept is the same one: its number, its record and when it was first asked.
      const wasKept = ask.resumed === undefined ? undefined : store.get(ask.resumed.id);
      const askedAt = wasKept?.askedAt ?? now;

      // The call's count runs on from the rounds an earlier instance had, which a restart in between would forget.
      const earlier = Math.max(counts.get(ask.callId) ?? 0, asking?.sampledCount(ask.callId) ?? 0);
      const sequence = ask.resumed?.sequence ?? earlier + 1;

      counts.set(ask.callId, Math.max(earlier, sequence));
      asking?.noteSampled(ask.callId, sequence);

      const id = ask.resumed?.id ?? `${ask.callId}:${sequence}`;
      const notes: Array<string> = [];

      let record: McpSamplingRecord =
        wasKept === undefined
          ? {
              id,
              server: ask.server,
              tool: ask.tool,
              origin: askOriginOf(ask),
              conversationId: ask.conversationId,
              callId: ask.callId,
              sequence,
              status: "running",
              by: "definition",
              notes,
              askedAt,
            }
          : { ...wasKept, status: "running", notes };

      /** Settle the record, redacted, and the request's outcome. */
      const end = (
        status: "refused" | "failed",
        code: number,
        message: string,
        why: McpSamplingWhy | undefined,
        by: McpSamplingRecord["by"] = "cloudpid",
      ): Effect.Effect<McpSamplingOutcome> =>
        Effect.gen(function* () {
          const settledAt = yield* Clock.currentTimeMillis;
          const { why: _earlier, ...rest } = record;

          const settled: Mutable<McpSamplingRecord> = {
            ...rest,
            status,
            reason: message,
            by,
            settledAt,
          };

          if (why !== undefined) settled.why = why;

          record = settled;
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
          id: settled.id,
          server: ask.server,
          status:
            settled.status === "running" || settled.status === "waiting"
              ? "failed"
              : settled.status,
          by: settled.by,
        };

        if (settled.grant !== undefined) detail.grant = settled.grant;

        if (settled.reason !== undefined) detail.reason = settled.reason;

        if (settled.why !== undefined) detail.why = settled.why;

        if (settled.role !== undefined) detail.role = settled.role;

        if (settled.model !== undefined) detail.model = settled.model;

        if (settled.tokens !== undefined) detail.tokens = settled.tokens;

        if (settled.cost !== undefined) detail.cost = settled.cost;

        return detail;
      };

      // What the owner decided of a request kept for later: a refusal is the request's end, whatever else is true of it.
      if (ask.resumed?.decision.action === "refuse") {
        const { reason, by, why } = ask.resumed.decision;

        return yield* end("refused", MCP_SAMPLING_REFUSED, reason, why, by);
      }

      if (sequence > MCP_SAMPLINGS_PER_CALL) {
        return yield* end(
          "refused",
          MCP_SAMPLING_REFUSED,
          "sampling limit for this call reached",
          "cap",
        );
      }

      const bound = binding;

      if (bound === undefined) {
        return yield* end(
          "refused",
          MCP_INTERNAL_ERROR,
          "the Session's models are not ready yet",
          "internal",
        );
      }

      const decoded = decodeSamplingParams(ask.params);

      if (Option.isNone(decoded)) {
        return yield* end(
          "refused",
          MCP_INVALID_PARAMS,
          "invalid sampling request: its parameters are malformed",
          "invalid",
        );
      }

      const params: SamplingParams = decoded.value;

      // A request kept for later keeps the record it was kept with: its messages are the ones the owner saw.
      if (wasKept === undefined)
        record = {
          ...record,
          ...(yield* summaryOf(params, taken.get(ask.callId), options.redact)),
        };

      const problem = pairingProblem(params.messages);

      if (problem !== undefined)
        return yield* end(
          "refused",
          MCP_INVALID_PARAMS,
          `invalid sampling messages: ${problem}`,
          "invalid",
        );

      const tooLarge = boundsProblem(params);

      if (tooLarge !== undefined)
        return yield* end(
          "refused",
          MCP_INVALID_PARAMS,
          `invalid sampling request: ${tooLarge}`,
          "invalid",
        );

      taken.set(
        ask.callId,
        Arr.map(params.messages, (message) => JSON.stringify(message)),
      );

      const over = yield* Effect.tryPromise(() => bound.overLimit()).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (over !== undefined) {
        return yield* end("refused", MCP_SAMPLING_REFUSED, overLimitReason(over), "budget");
      }

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

      if (params.includeContext !== undefined && params.includeContext !== "none") {
        notes.push("asked to include context; none given");
      }

      if (params.stopSequences !== undefined && params.stopSequences.length > 0) {
        notes.push("stopSequences were not passed");
      }

      const available = (each: RoleName) => modelOf(bound.models, roles, each) !== undefined;
      const first = lowestAvailable(chosen.role, available);
      const firstModel = first === undefined ? undefined : modelOf(bound.models, roles, first);

      if (first === undefined || firstModel === undefined) {
        return yield* end(
          "refused",
          MCP_INVALID_PARAMS,
          "no model is available for this request",
          "unservable",
        );
      }

      // What running the request on a Role makes of it: the messages as that model takes them, the tool choice its API
      // spells, the context and the most tokens, or the refusal when it cannot be served there.
      const prepare = (role: RoleName, model: Model<Api>) =>
        Effect.gen(function* () {
          const asNotes: Array<string> = [];
          const converted = toPiMessages(params.messages, model, askedAt);

          if (converted.kind === "refused") {
            return yield* end(
              "refused",
              MCP_INVALID_PARAMS,
              `unservable sampling request: ${converted.reason}`,
              "unservable",
            );
          }

          const offered = params.tools ?? [];
          const choice = toolChoiceFor(model.api, params.toolChoice?.mode);

          if (choice.note !== undefined) asNotes.push(choice.note);

          if (model.api === "anthropic-messages" && Arr.some(offered, flattens)) {
            asNotes.push("a tool's schema was flattened for the model: $defs or oneOf may be lost");
          }

          // Scrubbing covers messages and the system prompt; the server's tool definitions are redacted here.
          const tools: Array<Tool> = yield* options.redact(
            Arr.map(offered, (tool) => ({
              name: tool.name,
              description: tool.description ?? tool.title ?? tool.name,
              // SAFETY: the server's JSON Schema, an object, as `Tool["parameters"]` is.
              parameters: tool.inputSchema as Tool["parameters"],
            })),
          );

          const systemPrompt =
            params.systemPrompt === undefined
              ? undefined
              : yield* options.redact(params.systemPrompt);

          const context: Mutable<ModelContext> = { messages: converted.messages };

          if (systemPrompt !== undefined) context.systemPrompt = systemPrompt;

          if (tools.length > 0 && choice.value !== "none") context.tools = tools;

          const transcript = normalizeContext(context);

          if (estimateContextTokens(transcript).tokens >= model.contextWindow) {
            return yield* end(
              "refused",
              MCP_INVALID_PARAMS,
              "the request does not fit the model's context window",
              "unservable",
            );
          }

          const maxTokens = clampMaxTokensToContext(
            model,
            transcript,
            Math.min(params.maxTokens, SAMPLING_MAX_TOKENS, model.maxTokens),
          );

          return {
            kind: "ready",
            role,
            model,
            context,
            choice: choice.value,
            maxTokens,
            offered: offered.length > 0,
            notes: asNotes,
          } as const;
        });

      /** The record, and its notes, for the request run on `ready`'s Role. */
      const onRole = (ready: Ready) => {
        record = {
          ...record,
          role: ready.role,
          model: ready.model.id,
          notes: [...notes, ...ready.notes],
        };
      };

      let prepared = yield* prepare(first, firstModel);

      if (prepared.kind !== "ready") return prepared;

      onRole(prepared);

      // `ask`: the owner decides, unless they already did for this call or the Session (or the definition says `allow`). A
      // request kept for later has been decided (the owner's, or the definition's switch to `allow`), and that decision and
      // its Role stand though the definition reads `allow` by the resume (Always allow wrote it).
      if (ask.decision === "ask" || ask.resumed !== undefined) {
        // What the owner decided of a request kept for later is its answer, not a standing one.
        const standing =
          ask.resumed === undefined ? asking?.samplingStanding(ask.callId, ask.server) : undefined;

        if (standing?.action === "refuse") {
          record = { ...record, grant: standing.grant };

          return yield* end("refused", MCP_SAMPLING_REFUSED, standing.reason, undefined, "grant");
        }

        if (standing?.action === "allow") {
          record = { ...record, by: "grant", grant: standing.grant };
        } else {
          let decided: McpSamplingDecision;

          if (ask.resumed !== undefined) decided = ask.resumed.decision;
          else {
            if (asking === undefined) {
              return yield* end(
                "refused",
                MCP_SAMPLING_REFUSED,
                "cloudpid cannot ask the owner here",
                "internal",
              );
            }

            const roleOptions = Arr.filterMap(ROLE_NAMES, (each) => {
              const held = modelOf(bound.models, roles, each);

              return held === undefined
                ? Result.failVoid
                : Result.succeed({ role: each, model: held.id });
            });

            // Kept as waiting before the owner is asked, so a card nobody can answer is a record a new instance can settle.
            record = { ...record, status: "waiting" };

            if (!(yield* keep(record))) {
              return yield* end("refused", MCP_SAMPLING_REFUSED, UNRECORDED_REASON, "internal");
            }

            const shown = cardMessages(record.messages);

            const card: Mutable<McpSamplingCard> = {
              callId: ask.callId,
              conversationId: ask.conversationId,
              server: ask.server,
              tool: ask.tool,
              role: prepared.role,
              model: prepared.model.id,
              roles: roleOptions,
              messages: shown.messages,
              tools: Arr.map(record.tools ?? [], (name) => ({ name })),
              notes: record.notes,
            };

            if (ask.source !== undefined) card.source = ask.source;

            if (ask.prompt !== undefined) card.prompt = ask.prompt;

            if (ask.app === true) card.app = true;

            if (ask.task !== undefined) card.task = ask.task;

            if (record.systemPrompt !== undefined) card.systemPrompt = record.systemPrompt;

            if (shown.omitted > 0) card.omitted = shown.omitted;

            // A Modern server's request on a call that keeps its questions: stored with the call's round, answered when it
            // resumes (the record stays `waiting`, which the question's settling ends if the round never resumes).
            if (ask.defers === true) {
              const keptFor = yield* asking.deferSampling({
                id,
                key: ask.key,
                card,
                sequence,
                params: yield* options.redact(ask.params),
              });

              if (keptFor !== "deferred") {
                return yield* end(
                  "refused",
                  MCP_SAMPLING_REFUSED,
                  keptFor === "unrecorded" ? UNRECORDED_REASON : "the request cannot be kept",
                  "internal",
                );
              }

              return { kind: "deferred" } satisfies McpSamplingOutcome;
            }

            yield* ask.hold?.pause ?? Effect.void;

            // Stop withdraws the card: the wait is raced against the call's signal, and the one that loses is interrupted.
            decided = yield* asking
              .askSampling({ id, key: ask.key, card })
              .pipe(
                Effect.raceFirst(stoppedBy(ask.signal)),
                Effect.raceFirst(stoppedBy(ask.withdraw, MCP_APP_HIDDEN_REASON)),
                Effect.ensuring(ask.hold?.resume ?? Effect.void),
              );
          }

          record = { ...record, status: "running" };

          if (decided.action === "refuse") {
            return yield* end(
              "refused",
              MCP_SAMPLING_REFUSED,
              decided.reason,
              decided.why,
              decided.by,
            );
          }

          // No grant: the server's definition, switched to `allow` while the request waited, let it run.
          record =
            decided.grant === undefined
              ? { ...record, by: "definition" }
              : { ...record, by: "owner", grant: decided.grant };

          if (decided.role !== prepared.role) {
            const model = modelOf(bound.models, roles, decided.role);

            if (model === undefined) {
              return yield* end(
                "refused",
                MCP_INVALID_PARAMS,
                "no model is available for the Role chosen",
                "unservable",
              );
            }

            prepared = yield* prepare(decided.role, model);

            if (prepared.kind !== "ready") return prepared;

            onRole(prepared);
          }
        }

        // Over the limit while the owner decided: the gate checks again at the model, and the check here before the sample.
        const stillOver = yield* Effect.tryPromise(() => bound.overLimit()).pipe(
          Effect.orElseSucceed(() => undefined),
        );

        if (stillOver !== undefined) {
          return yield* end("refused", MCP_SAMPLING_REFUSED, overLimitReason(stillOver), "budget");
        }
      }

      const { model, context, maxTokens, choice, offered } = prepared;

      const kept = yield* keep(record);

      // A replaced Session, whose storage cannot take the record, cannot count the sample either: refused.
      if (!kept) {
        return yield* end("refused", MCP_SAMPLING_REFUSED, UNRECORDED_REASON, "internal");
      }

      const sampled = yield* pace(ask.server).pipe(
        Effect.andThen(
          paceOf(ask.server).active.withPermit(
            Effect.tryPromise(() =>
              run(bound, model, context, maxTokens, params, choice, ask.signal),
            ),
          ),
        ),
        Effect.result,
      );

      if (Result.isFailure(sampled)) {
        return yield* end("refused", MCP_INTERNAL_ERROR, "the model could not be reached", "model");
      }

      const { message, timedOut } = sampled.success;

      bound.usage({ conversationId: ask.conversationId, server: ask.server }, message.usage);

      record = {
        ...record,
        tokens: message.usage.totalTokens,
        cost: message.usage.cost.total,
      };

      const replied = replyOf(message, offered && choice !== "none");

      if (replied.kind === "failed") {
        const reason = timedOut ? "the sample took longer than 2 minutes" : replied.reason;

        return yield* end("failed", MCP_INTERNAL_ERROR, reason, "model");
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
      // Whatever goes wrong inside is a failure of the model seam, told to the server as one, inside the span so that it
      // too says what it ended as.
      Effect.catchCause((cause) =>
        Effect.logWarning("A Sampling request could not be answered", cause).pipe(
          Effect.as({
            kind: "refused",
            code: MCP_INTERNAL_ERROR,
            message: "cloudpid could not answer the sampling request",
            detail: { server: ask.server, status: "failed", by: "cloudpid", why: "internal" },
          } satisfies McpSamplingOutcome),
        ),
      ),
      // The span says what it ended as and who decided, never what was asked or answered.
      Effect.tap((outcome) =>
        Effect.annotateCurrentSpan(
          outcome.kind === "deferred"
            ? { "mcp.sampling.outcome": "deferred" }
            : spanAttributes(outcome.detail),
        ),
      ),
      Effect.withSpan("mcp.sampling.sample", {
        attributes: {
          "mcp.server": ask.server,
          "mcp.origin": askOriginOf(ask),
        },
      }),
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
    view: (id) =>
      Effect.sync(() => {
        const held = store.get(id);

        return held === undefined ? undefined : recordView(held);
      }),
  };
};

/** A span's attributes. */
type SpanAttributes = { readonly [key: string]: string | number };

/** What the span of a sample carries of how it ended: the Role and model, tokens and cost, the outcome and who decided. */
const spanAttributes = (detail: McpSamplingDetail) => {
  const attributes: Mutable<SpanAttributes> = {
    "mcp.sampling.outcome": detail.status,
    "mcp.sampling.by": detail.by,
  };

  if (detail.why !== undefined) attributes["mcp.sampling.why"] = detail.why;

  if (detail.role !== undefined) attributes["mcp.sampling.role"] = detail.role;

  if (detail.model !== undefined) attributes["mcp.sampling.model"] = detail.model;

  if (detail.tokens !== undefined) attributes["mcp.sampling.tokens"] = detail.tokens;

  if (detail.cost !== undefined) attributes["mcp.sampling.cost"] = detail.cost;

  return attributes;
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
