// The Session object's RPC for the MCP endpoint (`docs/architecture/mcp-endpoint.md` → The `api` target, Following a
// Run, Transcripts, Starting, sending and stopping): `status`, `waitForChange`, `transcriptPage`, `submit` and `stop`.
// Every answer is an `ApiResult`, so a refusal travels as a value; what the host failed at is `unavailable`. Waiting
// requests, the transcript and the answers are redacted here, before they leave the object.
import { Approvals } from "@cloudpid/extensions/approvals";
import { BrowserHandoffs } from "@cloudpid/extensions/browser";
import { Secrets } from "@cloudpid/extensions/secrets";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  type CursorState,
  decodeCursor,
  encodeCursor,
  MAX_LAST_ANSWER_CHARS,
  MAX_LATEST_ACTIVITY,
  MAX_MCP_INPUT_BYTES,
  MAX_SESSION_WAITS,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_WAIT_ANSWER_CHARS,
  middleCut,
  pageTranscript,
  projectEntries,
  redactGithubTokens,
  renderTranscript,
  type RunOutcome,
  runOutcome,
  type SessionStatusReport,
  STOP_WAIT_MS,
  type StopRequest,
  type StopResult,
  type SubmitRequest,
  type SubmitResult,
  transcriptChars,
  type TranscriptEntry,
  type TranscriptPage,
  type TranscriptRequest,
  type WaitOutcome,
  type WaitRequest,
  type WaitingRequest,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Types from "effect/Types";
import * as Record from "effect/Record";
import { CONVERSATION_MISSING, SessionError } from "./errors.ts";
import { type Prompt, SessionHost } from "./host.ts";
import { cursorOf, endedBy, statusOf, type Snapshot, waitingMark } from "./mcp-follow.ts";
import type { FollowState, SettledInput } from "./mcp-reads.ts";

/** What the object tells a caller about itself, for `status`. `after` is the cursor the caller holds, if any. */
export type StatusRequest = { readonly after?: string };

/** The Session's RPC for the MCP endpoint. Never fails: a failure is the value's. */
export type SessionMcpService = {
  readonly status: (request?: StatusRequest) => Effect.Effect<ApiResult<SessionStatusReport>>;
  readonly waitForChange: (request: WaitRequest) => Effect.Effect<ApiResult<WaitOutcome>>;
  readonly transcriptPage: (request: TranscriptRequest) => Effect.Effect<ApiResult<TranscriptPage>>;
  readonly submit: (request: SubmitRequest) => Effect.Effect<ApiResult<SubmitResult>>;
  readonly stop: (request: StopRequest) => Effect.Effect<ApiResult<StopResult>>;
};

export class SessionMcp extends Context.Service<SessionMcp, SessionMcpService>()(
  "@cloudpid/server/session/mcp/SessionMcp",
) {}

export type SessionMcpOptions = {
  /** The Session's id: the page a waiting request's `url` opens. */
  readonly session: string | undefined;
  /** The object's synchronous key-value storage. */
  readonly kv: {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
  };
  /** Whether the owner archived the Session: it takes no input then. */
  readonly archived: Effect.Effect<boolean, SessionError>;
  /** How often a wait looks again, in milliseconds. */
  readonly pollMs?: number;
  /** How long a stop waits for the Session to go idle, in milliseconds. */
  readonly stopWaitMs?: number;
};

/** How often a wait looks at the Session again. */
export const WAIT_POLL_MS = 500;

/** Where the time each waiting request was first seen is kept (a request has no time of its own), and the newest. */
const SEEN_KEY = "mcp-waiting-seen";
const LAST_SEEN_KEY = "mcp-waiting-last";

/** The most entries a wait reads to summarize the activity since a cursor. */
const ACTIVITY_ENTRIES = 300;

/** How many entries a transcript read renders at a time: each can hold megabytes of tool result. */
const RENDER_BATCH = 25;

/** The longest a one-line summary of activity is. */
const ACTIVITY_LINE_CHARS = 120;

/** A text redactor. */
type Redactor = (text: string) => string;

/** The seam every text leaves through: the redactor, and whether the Secrets it redacts could be read at all. */
type Seam = { readonly redact: Redactor; readonly readable: boolean };

/** Where the delivery of each recent request id is kept, so a repeated send reports its first one. */
const DELIVERIES_KEY = "mcp-deliveries";

/** How many request ids' deliveries are kept. */
const DELIVERIES_KEPT = 64;

/** One request waiting for the owner, before its time is known. */
type Waiting = Omit<WaitingRequest, "since">;

const oneLine = (text: string, max: number): string =>
  middleCut(text.replace(/\s+/g, " ").trim(), max);

/** The one-line summary of a message for `activity.latest`: its last line, or none for a message that shows nothing. */
const activityLine = (entry: TranscriptEntry): string | undefined => {
  if (entry.role === "tool") return undefined;

  const body = Arr.filter(entry.text.split("\n").slice(1), (line) => line.trim() !== "");
  const last = body.at(-1) ?? entry.text;

  const line = oneLine(last, ACTIVITY_LINE_CHARS);

  return line.startsWith("→") || line.startsWith("·") ? line : `${entry.role}: ${line}`;
};

/** How a send was delivered: to a Run that started, joined the running one, or waits for the next. */
const deliveryOf = (
  whenBusy: Prompt["whenBusy"],
  earlier: { readonly queued: boolean } | undefined,
  busy: boolean,
): SubmitResult["delivery"] => {
  if (earlier !== undefined) return earlier.queued ? "queued" : "started";

  if (!busy) return "started";

  return whenBusy === "steer" ? "steered" : "queued";
};

/** An agent's id for conversation `conversation`: `root` for a Session branch. */
const agentIdOf = (state: FollowState, conversation: number): string =>
  state.agents[String(conversation)] ?? "root";

const sessionMcp = (options: SessionMcpOptions) =>
  Effect.gen(function* () {
    const host = yield* SessionHost;
    const secrets = yield* Secrets;
    const approvals = yield* Approvals;
    const handoffs = yield* BrowserHandoffs;
    const pollMs = options.pollMs ?? WAIT_POLL_MS;
    const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;

    /** Waits in progress, which the Session object is kept resident for. */
    let waits = 0;

    const unavailable = (error: SessionError | { readonly message: string }) =>
      apiFailure("unavailable", error.message);

    /** The held Secrets, refreshed, as a redactor with the GitHub token pass: the endpoint's single seam. */
    const redactor: Effect.Effect<Seam> = secrets.readable.pipe(
      Effect.map((readable) => ({
        readable,
        redact: (text: string) => redactGithubTokens(secrets.redact(text)),
      })),
    );

    /** The requests waiting for the owner, each with the time it was first seen (kept, so a wake does not renew it). */
    const waiting = ({ redact, readable }: Seam, state: FollowState) =>
      Effect.gen(function* () {
        const asks = yield* secrets.pending;
        const approved = yield* approvals.pending;
        const handed = yield* handoffs.pending;

        const found: Array<{ readonly key: string; readonly request: Waiting }> = [
          ...Arr.map(approved, (ask) => ({
            key: `approval:${ask.id}`,
            request: {
              kind: "approval" as const,
              request_id: ask.id,
              agent_id: agentIdOf(state, ask.conversationId),
              summary: readable ? redact(`${ask.change} (${ask.target})`) : "Approval request",
              url: "",
            },
          })),
          ...Arr.map(asks, (ask) => ({
            key: `secret:${ask.id}`,
            request: {
              kind: "secret" as const,
              request_id: ask.id,
              agent_id: agentIdOf(state, ask.conversationId),
              summary: readable
                ? redact(`Secret request: ${Arr.join(ask.names, ", ")}`)
                : "Secret request",
              url: "",
            },
          })),
          ...Arr.map(handed, (handoff) => ({
            key: `browser_handoff:${handoff.id}`,
            request: {
              kind: "browser_handoff" as const,
              request_id: handoff.id,
              agent_id: agentIdOf(state, handoff.conversationId),
              summary: "Browser handoff: the agent needs you to act in the browser",
              url: "",
            },
          })),
        ];

        const now = yield* Clock.currentTimeMillis;
        const seen = options.kv.get<Record<string, number>>(SEEN_KEY) ?? {};
        const kept: Record<string, number> = {};
        let last = options.kv.get<number>(LAST_SEEN_KEY) ?? 0;

        const stamped = Arr.map(found, ({ key, request }): WaitingRequest => {
          let since = seen[key];

          if (since === undefined) {
            // Strictly after every time given before, so a request seen later is always newer than a mark.
            since = Math.max(now, last + 1);
            last = since;
          }

          kept[key] = since;

          return {
            ...request,
            since,
            url: `/sessions/${options.session ?? ""}?request=${request.request_id}`,
          };
        });

        if (!Record.isEmptyRecord(seen) || !Record.isEmptyRecord(kept)) {
          options.kv.put(SEEN_KEY, kept);
          options.kv.put(LAST_SEEN_KEY, last);
        }

        return Arr.sort(
          stamped,
          Order.mapInput(Order.Number, (request: WaitingRequest) => request.since),
        );
      });

    /** What the Session is now, for `conversation` (the cursor's, or the active branch). */
    const snapshot = (seam: Seam, conversation?: number) =>
      host
        .follow(conversation)
        .pipe(
          Effect.flatMap((state) =>
            waiting(seam, state).pipe(Effect.map((list): Snapshot => ({ state, waiting: list }))),
          ),
        );

    const readCursor = (cursor: string | undefined) =>
      cursor === undefined ? undefined : Option.getOrUndefined(decodeCursor(cursor));

    const invalidCursor = apiFailure("invalid_cursor", "That cursor is not one of this Session's.");

    /** The answer of the Run that settled, redacted and cut to `max` characters. */
    const answerOf = (settled: SettledInput | undefined, redact: Redactor, max: number) => {
      if (settled?.status !== "done" || settled.answer === undefined || settled.answer === "") {
        return undefined;
      }

      const text = redact(settled.answer);

      return { text: middleCut(text, max), truncated: text.length > max };
    };

    /** What happened since the cursor: entries, tool calls and the latest few one-liners, redacted. */
    const activity = (state: FollowState, cursor: CursorState | undefined, seam: Seam) =>
      Effect.gen(function* () {
        const forward = cursor !== undefined && cursor.c === state.conversationId;

        const records = yield* host.entries(
          forward
            ? {
                conversationId: state.conversationId,
                order: "ascending",
                minEntryId: cursor.e + 1,
                limit: ACTIVITY_ENTRIES,
              }
            : { conversationId: state.conversationId, order: "descending", limit: 100 },
        );

        const messages = projectEntries(forward ? records : Arr.reverse(records));
        // The lines are text of the Session: with the Secrets unreadable they are left out, the counts stay.
        const rendered = seam.readable ? renderTranscript(messages, { redact: seam.redact }) : [];

        const calls = Arr.reduce(
          messages,
          0,
          (sum, message) =>
            sum + Arr.filter(message.parts, (part) => part.type === "tool-call").length,
        );

        return {
          entries: messages.length,
          tool_calls: calls,
          latest: Arr.takeRight(
            Arr.flatMap(rendered, (entry) => {
              const line = activityLine(entry);

              return line === undefined ? [] : [line];
            }),
            MAX_LATEST_ACTIVITY,
          ),
        };
      });

    /** The outcome of the Run that settled: a failed one's message is redacted, or left out when it cannot be. */
    const outcomeOf = (
      settled: SettledInput | undefined,
      { redact, readable }: Seam,
    ): RunOutcome | undefined => {
      if (settled === undefined) return undefined;

      const outcome =
        settled.status === "done"
          ? runOutcome({ status: "done" })
          : runOutcome({ status: "unanswered", reason: settled.reason, detail: settled.detail });

      if (outcome.message === undefined) return outcome;

      const { message, ...rest } = outcome;

      return readable ? { ...rest, message: redact(message) } : rest;
    };

    /**
     * Every failure of the host is `unavailable`, as the Session may heal; except a conversation it does not have,
     * which only a cursor of another Session names: that is `invalid_cursor`, which no retry mends.
     */
    const guarded = <A>(effect: Effect.Effect<ApiResult<A>, SessionError>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            error.operation === CONVERSATION_MISSING ? invalidCursor : unavailable(error),
          ),
        ),
      );

    /** What a settled Run says: its outcome, its answer cut to `max`, and a failure's message; text only if readable. */
    const settledReport = (settled: SettledInput | undefined, seam: Seam, max: number) => {
      const outcome = outcomeOf(settled, seam);

      return {
        outcome,
        answer: seam.readable ? answerOf(settled, seam.redact, max) : undefined,
        error: outcome?.result === "failed" ? outcome.message : undefined,
      };
    };

    const status: SessionMcpService["status"] = (request = {}) =>
      guarded(
        Effect.gen(function* () {
          const cursor = readCursor(request.after);

          if (request.after !== undefined && cursor === undefined) return invalidCursor;

          const seam = yield* redactor;
          const now = yield* snapshot(seam);
          const current = statusOf(now);
          const settled = now.state.newestSettled;

          const report: Types.Mutable<SessionStatusReport> = {
            status: current,
            waiting: now.waiting,
            cursor: encodeCursor(cursorOf(now)),
          };

          if (now.state.model !== undefined) report.model = now.state.model;

          if (now.state.thinking !== undefined) report.thinking = now.state.thinking;

          // What the last Run came to is told while no Run is going.
          if (current !== "running") {
            const { outcome, answer } = settledReport(settled, seam, MAX_LAST_ANSWER_CHARS);

            if (outcome !== undefined) report.outcome = outcome;

            if (answer !== undefined) report.last_answer = answer;
          }

          // The waiting summaries, the outcome's message and the last answer were left out or made generic.
          if (!seam.readable) report.text_withheld = "secrets_unavailable";

          if (cursor !== undefined && cursor.c !== now.state.activeBranch) {
            report.branch_changed = true;
          }

          return apiOk(report);
        }),
      );

    const waitForChange: SessionMcpService["waitForChange"] = ({ after, deadline }) =>
      guarded(
        Effect.gen(function* () {
          const cursor = readCursor(after);

          if (after !== undefined && cursor === undefined) return invalidCursor;

          if (waits >= MAX_SESSION_WAITS) {
            return apiFailure(
              "too_many_waits",
              `This Session already has ${String(MAX_SESSION_WAITS)} waits open: wait again shortly.`,
            );
          }

          waits += 1;

          return yield* Effect.gen(function* () {
            const seam = yield* redactor;
            let now = yield* snapshot(seam, cursor?.c);
            let ended = endedBy(now, cursor);

            while (ended === undefined && (yield* Clock.currentTimeMillis) < deadline) {
              const left = deadline - (yield* Clock.currentTimeMillis);

              yield* Effect.sleep(Duration.millis(Math.max(1, Math.min(pollMs, left))));
              now = yield* snapshot(seam, cursor?.c);
              ended = endedBy(now, cursor);
            }

            const reason = ended ?? "timeout";

            const result: Types.Mutable<WaitOutcome> = {
              status: statusOf(now),
              ended_by: reason,
              waiting: now.waiting,
              activity: yield* activity(now.state, cursor, seam),
              cursor: encodeCursor(cursorOf(now)),
            };

            if (cursor !== undefined && cursor.c !== now.state.activeBranch) {
              result.branch_changed = true;
            }

            if (reason === "run_ended") {
              const settled = now.state.newestSettled;

              const { outcome, answer, error } = settledReport(
                settled,
                seam,
                MAX_WAIT_ANSWER_CHARS,
              );

              if (outcome !== undefined) result.outcome = outcome;

              if (error !== undefined) result.error = error;

              if (answer !== undefined) result.answer = answer;
            }

            // However the wait ended, the activity lines, waiting summaries and Run text are left out or generic.
            if (!seam.readable) result.text_withheld = "secrets_unavailable";

            return apiOk(result);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                waits -= 1;
              }),
            ),
          );
        }),
      );

    /** The conversation a transcript read is of: an agent's, the cursor's, or the active branch's. */
    const transcriptConversation = (
      request: TranscriptRequest,
      cursor: CursorState | undefined,
      state: FollowState,
    ): number | undefined => {
      if (request.agent_id === undefined) return cursor?.c ?? state.conversationId;

      if (request.agent_id === "root") return state.activeBranch;

      const found = Arr.findFirst(
        Record.keys(state.agents),
        (key) => state.agents[key] === request.agent_id,
      );

      return Option.isSome(found) ? Number(found.value) : undefined;
    };

    const transcriptPage: SessionMcpService["transcriptPage"] = (request) =>
      guarded(
        Effect.gen(function* () {
          const before = readCursor(request.before);
          const after = readCursor(request.after);

          if (
            (request.before !== undefined && before === undefined) ||
            (request.after !== undefined && after === undefined)
          ) {
            return invalidCursor;
          }

          const seam = yield* redactor;

          if (!seam.readable) {
            return apiFailure(
              "unavailable",
              "The Secrets to redact the transcript of could not be read: try again shortly.",
              { retryable: true },
            );
          }

          const { redact } = seam;
          const head = yield* host.follow();
          const conversation = transcriptConversation(request, after ?? before, head);

          if (conversation === undefined) {
            return apiFailure("not_found", `No agent "${request.agent_id ?? ""}" in this Session.`);
          }

          const state =
            conversation === head.conversationId ? head : yield* host.follow(conversation);

          const detail = request.detail ?? "summary";
          const maxChars = transcriptChars(request.max_chars);
          const forward = after !== undefined;
          const gathered: TranscriptEntry[] = [];
          let chars = 0;
          let exhausted = false;
          let edge = forward ? after.e : before?.e;

          // Render a few entries at a time and stop once a page is full: megabytes of tool results never accumulate.
          while (!exhausted && chars <= maxChars && gathered.length <= MAX_TRANSCRIPT_ENTRIES) {
            const records = yield* host.entries(
              forward
                ? {
                    conversationId: conversation,
                    order: "ascending",
                    minEntryId: (edge ?? 0) + 1,
                    limit: RENDER_BATCH,
                  }
                : {
                    conversationId: conversation,
                    order: "descending",
                    maxEntryId: edge === undefined ? undefined : edge - 1,
                    limit: RENDER_BATCH,
                  },
            );

            if (records.length < RENDER_BATCH) exhausted = true;

            const newest = records.at(forward ? -1 : 0)?.id;
            const oldest = records.at(forward ? 0 : -1)?.id;

            if (newest === undefined || oldest === undefined) break;

            edge = forward ? newest : oldest;

            const rendered = renderTranscript(
              projectEntries(forward ? records : Arr.reverse(records)),
              { detail, redact },
            );

            for (const entry of forward ? rendered : Arr.reverse(rendered)) {
              gathered.push(entry);
              chars += entry.text.length;
            }
          }

          const window = pageTranscript(forward ? gathered : Arr.reverse(gathered), {
            before: before?.e,
            after: after?.e,
            maxChars,
          });

          const marks = {
            w: waitingMark(yield* waiting(seam, head)),
            s: state.newestSettled?.id ?? 0,
          };

          const first = window.entries[0]?.entry_id;
          const last = window.entries.at(-1)?.entry_id;
          const hasOlder = window.hasOlder || (!forward && !exhausted);
          // A page of older entries has the ones it was cut before after it.
          const hasNewer = window.hasNewer || before !== undefined || (forward && !exhausted);

          const page: Types.Mutable<TranscriptPage> = {
            entries: window.entries,
            // At the end of the transcript the cursor is its newest entry, even one that renders to nothing.
            newer: encodeCursor({
              c: conversation,
              e: hasNewer ? (last ?? after?.e ?? 0) : Math.max(last ?? 0, state.newestEntry),
              ...marks,
            }),
          };

          if (request.agent_id !== undefined) page.agent_id = request.agent_id;

          if (hasOlder && first !== undefined) {
            page.older = encodeCursor({ c: conversation, e: first, ...marks });
          }

          if (request.agent_id === undefined && conversation !== head.activeBranch) {
            page.branch_changed = true;
          }

          return apiOk(page);
        }),
      );

    /** The cursor of a send: waiting from it ends with this input's Run, never an earlier one's. */
    const submitCursor = (state: FollowState, submission: number, mark: number): string =>
      encodeCursor({
        c: state.conversationId,
        e: state.newestEntry,
        w: mark,
        s: Math.max(0, submission - 1),
      });

    /** How a send was delivered: a repeat of a request id reports its first send's delivery, kept for the latest few. */
    const delivered = (
      requestId: string | undefined,
      whenBusy: Prompt["whenBusy"],
      earlier: { readonly queued: boolean } | undefined,
      busy: boolean,
    ): SubmitResult["delivery"] => {
      if (requestId === undefined) return deliveryOf(whenBusy, earlier, busy);

      const known = options.kv.get<Record<string, SubmitResult["delivery"]>>(DELIVERIES_KEY) ?? {};
      const first = known[requestId];

      if (first !== undefined) return first;

      const delivery = deliveryOf(whenBusy, earlier, busy);

      // Without a record, an admitted request id was sent before this was kept: say what the host knows.
      if (earlier === undefined) {
        const next = Arr.takeRight(
          [...Record.toEntries(known), [requestId, delivery] as const],
          DELIVERIES_KEPT,
        );

        options.kv.put(DELIVERIES_KEY, Record.fromEntries(next));
      }

      return delivery;
    };

    const submit: SessionMcpService["submit"] = (request) =>
      guarded(
        Effect.gen(function* () {
          if (new TextEncoder().encode(request.input).length > MAX_MCP_INPUT_BYTES) {
            return apiFailure(
              "input_too_large",
              `Input is over ${String(MAX_MCP_INPUT_BYTES)} bytes: send less text, or put it in a file in the Workspace.`,
            );
          }

          if (yield* options.archived) {
            return apiFailure(
              "session_archived",
              "This Session is archived: unarchive it in cloudpid first.",
            );
          }

          const seam = yield* redactor;
          const before = yield* host.follow();

          if (before.copying) {
            return apiFailure(
              "session_importing",
              "This Session is still importing: wait for it to finish.",
            );
          }

          const earlier =
            request.requestId === undefined ? undefined : yield* host.admitted(request.requestId);

          if (earlier === undefined && request.whenBusy === "reject" && before.unsettled) {
            return apiFailure(
              "session_busy",
              "The Run is busy: send with when_busy queue or steer, or wait.",
            );
          }

          const prompt: Types.Mutable<Prompt> = { input: request.input, via: request.via };

          if (request.whenBusy !== undefined) prompt.whenBusy = request.whenBusy;

          if (request.requestId !== undefined) prompt.requestId = request.requestId;

          const id = earlier?.id ?? (yield* host.submit(prompt));
          const after = yield* host.follow();
          const mark = waitingMark(yield* waiting(seam, after));

          const delivery = delivered(
            request.requestId,
            request.whenBusy,
            earlier,
            before.unsettled,
          );

          return apiOk<SubmitResult>({ delivery, cursor: submitCursor(after, id, mark) });
        }).pipe(
          Effect.catchTag("SessionError", (error) =>
            // The Session's own refusal of this input (too large to store, say) is the caller's to fix.
            Effect.succeed(
              error.operation === "submit"
                ? apiFailure("invalid_argument", error.message)
                : unavailable(error),
            ),
          ),
        ),
      );

    const stop: SessionMcpService["stop"] = (request) =>
      guarded(
        Effect.gen(function* () {
          const before = yield* host.follow();
          const seam = yield* redactor;

          // Stopping what is not running is a no-op that leaves no notice, so the call is idempotent: with only
          // subagents working, a plain stop has no Run to stop (it leaves them), and `subagents` is what stops them.
          if (before.idle || (request.subagents !== true && !before.unsettled)) {
            return apiOk<StopResult>({ status: statusOf(yield* snapshot(seam)) });
          }

          yield* host.note(`Stopped from ${request.via.client?.name ?? "a client"} (MCP)`);

          const stopped = yield* host
            .abort({ subagents: request.subagents === true })
            .pipe(Effect.timeoutOption(Duration.millis(stopWaitMs)));

          const result: Types.Mutable<StopResult> = { status: statusOf(yield* snapshot(seam)) };

          if (Option.isNone(stopped)) result.stopping = true;

          return apiOk(result);
        }),
      );

    return { status, waitForChange, transcriptPage, submit, stop } satisfies SessionMcpService;
  });

/** The Session's `SessionMcp`; build it once per instance, over the host, the Secrets and the waiting requests. */
export const sessionMcpLayer = (options: SessionMcpOptions) =>
  Layer.effect(SessionMcp, sessionMcp(options));
