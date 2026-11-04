// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- pi-durable's Promise-based tool seam.
// A call's rounds of questions kept for later (a Modern call's, or a Legacy server's `-32042` pages) (`docs/architecture/mcp-server-requests.md` → The waiting-question
// record, Phased replay): how `send` (`./exchange.ts`) stores a round and marks it, finds one on a rerun, and waits for
// the owner's answers to build the round's resume. The markers are pi-durable memos: `mcp.wait.<r>` once round _r_ is
// stored, and only then are its cards shown; `mcp.resumed.<r>` before its resume leaves, so it leaves at most once.
import type {
  McpHostRequest,
  McpHostRequestContext,
  McpHostResourceRequest,
  McpTaskInputResponses,
} from "@cloudpid/mcp/types";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";
import type { McpElicitationDetail } from "./details.ts";
import { mutableContent } from "./elicit.ts";
import { type McpDeferredRound, McpRoundState, type McpQuestionsService } from "./questions.ts";

/** The marker written once round `round`'s questions are stored: a rerun that finds it waits for them again. */
const waitMarker = (round: number) => `mcp.wait.${round}`;

/** The marker written before round `round`'s resume leaves: a rerun that finds it never sends the resume again. */
const resumedMarker = (round: number) => `mcp.resumed.${round}`;

/** Where a call's rounds are kept and marked: its questions, and its task's memos. */
export type Rounds = {
  readonly questions: McpQuestionsService;
  readonly api: ToolExecutionApi;
  readonly context: Context;
};

/**
 * The round a rerun of the call finds waiting: stored, its questions marked stored (`mcp.wait.<r>`) and its resume not
 * yet on its way (`mcp.resumed.<r>`); its cards are shown again. Anything else is a call that may have run.
 */
export const waitingRound = async ({
  questions,
  api,
  context,
}: Rounds): Promise<McpDeferredRound | undefined> => {
  const round = await Effect.runPromise(questions.deferredRound(api.callId));

  if (round === undefined) return undefined;

  const waited = await api.memo<boolean>(waitMarker(round.round), context);
  const resumed = await api.memo<boolean>(resumedMarker(round.round), context);

  if (waited === undefined || resumed !== undefined) return undefined;

  const shown = await Effect.runPromise(questions.showRound(api.callId).pipe(Effect.result));

  return Result.isSuccess(shown) ? round : undefined;
};

/**
 * Store `round` whole, mark it (`mcp.wait.<r>`), then show its cards. `false`: the storage could not take it (a
 * replaced Session), and the call is to end as one that may have run.
 */
export const storeRound = async (
  { questions, api, context }: Rounds,
  round: McpDeferredRound,
): Promise<boolean> => {
  const stored = await Effect.runPromise(questions.commitRound(round).pipe(Effect.result));

  if (Result.isFailure(stored)) return false;

  await api.memo(waitMarker(round.round), true, context);

  const shown = await Effect.runPromise(questions.showRound(round.callId).pipe(Effect.result));

  return Result.isSuccess(shown);
};

/**
 * How the wait for a round's answers ended: the request to send, Stop, the round gone before it was answered, or (for a
 * read's pages, which are sent again as the read was) an answer that is not an `accept`, which ends the read with the
 * server's own error.
 */
export type Resumed =
  | { readonly kind: "resume"; readonly request: McpHostRequest | McpHostResourceRequest }
  | { readonly kind: "refused" }
  | { readonly kind: "stopped" }
  | { readonly kind: "withdrawn" };

/**
 * Wait until the owner has answered every question of `round`, then build its resume: the answers are noted in
 * `asked`, never a value; `mcp.resumed.<r>` is written before the resume can leave, and the round's sealed answers go.
 */
export const resumeOf = async (
  rounds: Rounds,
  round: McpDeferredRound,
  call: {
    readonly server: string;
    readonly ctx: McpHostRequestContext;
    readonly asked: Array<McpElicitationDetail> | undefined;
    /** The read the round's pages are for: it has no state to resend, so it is sent again as it was. */
    readonly read?: McpHostResourceRequest | undefined;
  },
): Promise<Resumed> => {
  const { questions, api, context } = rounds;

  const answered = await Effect.runPromise(
    questions.awaitRound(api.callId),
    context.abortSignal === undefined ? undefined : { signal: context.abortSignal },
  ).catch(() => "stopped" as const);

  if (answered === "stopped") return { kind: "stopped" };

  if (answered === undefined) return { kind: "withdrawn" };

  const answers: Mutable<McpTaskInputResponses> = {};

  for (const { key, outcome, fields, page } of answered) {
    const detail: Mutable<McpElicitationDetail> = {
      server: call.server,
      mode: page === undefined ? "form" : "url",
      action: outcome.action,
      by: outcome.by,
      fields: [...fields],
    };

    if (page !== undefined) detail.host = page.host;

    if (outcome.action !== "accept" && outcome.reason !== undefined) {
      detail.reason = outcome.reason;
    }

    call.asked?.push(detail);
    answers[key] =
      outcome.action === "accept"
        ? { action: "accept", content: mutableContent(outcome.content) }
        : { action: outcome.action };
  }

  // Durable before the resume leaves, so a restart never sends it again; the sealed answers go once it is.
  await api.memo(resumedMarker(round.round), true, context);
  await Effect.runPromise(questions.endRound(api.callId));

  // A read's round keeps no state: the read is sent again as it was, once every page is accepted.
  return McpRoundState.$match(round.state, {
    Read: (): Resumed =>
      call.read !== undefined &&
      Arr.every(Record.values(answers), (each) => each["action"] === "accept")
        ? { kind: "resume", request: call.read }
        : { kind: "refused" },
    Resend: ({ state }): Resumed => ({
      kind: "resume",
      request: {
        op: "resend",
        server: call.server,
        params: { tool: round.tool, conn: round.conn, resend: state, answers },
        ctx: call.ctx,
      },
    }),
    Resume: ({ state }): Resumed => ({
      kind: "resume",
      request: {
        op: "resume",
        server: call.server,
        params: { tool: round.tool, conn: round.conn, resume: state, answers },
        ctx: call.ctx,
      },
    }),
  });
};
