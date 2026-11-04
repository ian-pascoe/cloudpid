// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What an App View's `tools/call` does with the questions its server asks (`docs/architecture/mcp-apps.md` → Server requests
// from an App View's calls; `docs/architecture/mcp-server-requests.md` → Questions, Elicitation requests, Sampling
// requests): the hooks the Session passes with the call to the host (`onInput`, `onInputEnded`, `onInputComplete`) and the
// `ctx.answers` that say the call may be asked. A prompt send's rules (`./prompt-asking.ts`), with the View's own:
//
// - **Live in both eras, never kept for later:** a form or a Sampling request waits on its card in the conversation's
//   waiting area (never inside the View) for at most `MCP_PROMPT_QUESTION_WAIT_MS`, tells the owner nothing (they are at the
//   View), and the call's clock stands still meanwhile (`hold`).
// - **Teardown withdraws every card:** `signal` aborts when the View is torn down, cancels the request or its socket goes.
// - **The page hidden withdraws a Sampling card that is waiting, and only that:** a hidden tab cannot show the owner what
//   asked for a model, so the request is refused (`view.hidden`, `SamplingCall.withdraw`); a sample the owner has approved
//   runs on, a request that needs no card (`allow`) is not refused, and a form stays, since the owner may answer it from
//   any tab.
// - **No pages:** a live caller declares no `url` but a prompt send's get does (`liveAnswers`); a View's call is asked forms
//   and Sampling only.
// - **One waiting elicitation per View:** another one the View's calls ask meanwhile is answered `cancel` and noted in the
//   View's audit log (`view.takeSlot`).
import { declaresSampling, samplingOf } from "@cloudpid/config";
import type { McpAnswers, McpHostRequestHooks } from "@cloudpid/mcp/types";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import type { McpElicitationDetail, McpSamplingDetail } from "./details.ts";
import { type ClockHold, elicitingHooks, notAcceptedWords } from "./elicit.ts";
import { liveAnswers } from "./prompt-asking.ts";
import type { McpQuestionsService } from "./questions.ts";
import { refusedWords, samplingHooks } from "./sample.ts";
import type { McpSamplingService } from "./sampling.ts";
import type { McpBuildServer } from "./tools.ts";

/** What the Session knows of the View that makes a call: its page's visibility and its one elicitation slot. */
export type McpAppView = {
  /**
   * A signal that aborts when the View's page is hidden, already aborted when it is hidden now. Asked for at each request
   * the server makes, since the page may be shown again between two.
   */
  readonly hidden: () => AbortSignal;
  /**
   * Take the View's one elicitation slot: the function that gives it back, or `undefined` when a question of this View
   * is waiting already. Shared by every call of the View.
   */
  readonly takeSlot: () => (() => void) | undefined;
};

/** One App View's call, as the Session knows it. */
export type AppAsk = {
  /** The configured name of the server the call is to. */
  readonly server: string;
  /**
   * The model-facing name of the tool the View calls, the inventory's own (`mcp__<server>__<tool>`): what the question's
   * `tool` says, which a client from before the app origin reads.
   */
  readonly tool: string;
  /** The call's own ID, unique within the Session: what its questions are kept under and withdrawn by. */
  readonly callId: string;
  /** The conversation the View's call was made in: whose waiting area its card is in. */
  readonly conversationId: ConversationId;
  /** Aborts when the View is torn down, cancels the request or its socket goes: a question waiting then is withdrawn. */
  readonly signal: AbortSignal;
  /** The call's own clock: stopped while a question waits, and started again. */
  readonly hold: ClockHold;
  readonly view: McpAppView;
};

/** What the Session gives to the call, and what it takes back. */
export type AppAsking = {
  /** What the call says it can answer (`ctx.answers`). */
  readonly answers: McpAnswers;
  /** The hooks the call's host request carries. */
  readonly hooks: Pick<McpHostRequestHooks, "onInput" | "onInputEnded" | "onInputComplete">;
  /** The call is over, however it ended: every question it still waits on is withdrawn, and its counts are forgotten. */
  readonly settle: () => Promise<void>;
  /**
   * The words a Modern server's Sampling request that was refused ends the call with, when one was: the server is told
   * nothing (an `InputResponse` has no error form), and carries none of what it wrote.
   */
  readonly sunk: () => string | undefined;
  /** What the call's questions came to, one line each for the View's audit log: never a value, nothing the server wrote. */
  readonly notes: () => ReadonlyArray<string>;
};

/** The line the audit log keeps of an elicitation. */
const elicitationNote = (detail: McpElicitationDetail): string =>
  detail.action === "accept"
    ? `${detail.mode === "url" ? "page" : "form"} answered`
    : (notAcceptedWords(detail, "You") ?? "request for input ended");

/** The line the audit log keeps of a Sampling request. */
const samplingNote = (detail: McpSamplingDetail): string =>
  detail.status === "answered" ? "model reply given" : refusedWords(detail);

/** Why an elicitation was turned away: the View has one waiting. */
const SLOT_TAKEN = "cloudpid cancelled a request for input: the App already has one waiting";

/** The hooks of a View's call whose Session can show questions, or none without them. */
export const appAsking = (
  deps: {
    readonly questions: McpQuestionsService | undefined;
    readonly sampling: McpSamplingService | undefined;
    /** Whether the host lists `sampling`: without it no server is told it may sample. */
    readonly hostSamples: boolean;
  },
  /** The server the call is to, as the tools were last built. */
  server: McpBuildServer,
  ask: AppAsk,
): AppAsking | undefined => {
  const { questions, sampling } = deps;

  if (questions === undefined) return undefined;

  const { hold } = ask;
  const turnedAway: Array<string> = [];

  const asking = elicitingHooks({
    questions,
    server: server.name,
    tool: ask.tool,
    app: true,
    callId: ask.callId,
    conversationId: ask.conversationId,
    signal: ask.signal,
    source: server.source,
    hold,
  });

  // A server whose definition says `off` (or a stdio one) is declared no sampling, so none is asked.
  const sampler =
    sampling !== undefined && deps.hostSamples && declaresSampling(server.server)
      ? samplingHooks({
          sampling,
          server: server.name,
          tool: ask.tool,
          app: true,
          callId: ask.callId,
          conversationId: ask.conversationId,
          signal: ask.signal,
          decision: samplingOf(server.server) === "allow" ? "allow" : "ask",
          source: server.source,
          hold,
          withdraw: () => ask.view.hidden(),
        })
      : undefined;

  const hooks: Mutable<AppAsking["hooks"]> = {
    onInput: async (input) => {
      if (input.kind === "elicitation") {
        const release = ask.view.takeSlot();

        if (release === undefined) {
          turnedAway.push(SLOT_TAKEN);

          return { kind: "answered", result: { action: "cancel" } };
        }

        try {
          return await asking.onInput(input);
        } finally {
          release();
        }
      }

      if (sampler === undefined) return asking.onInput(input);

      // The call's clock stands still for the whole of a sample too, not only for the owner's card: the model may take its
      // 2 minutes after the owner has said yes.
      await Effect.runPromise(hold.pause);

      try {
        return await sampler.onInput(input);
      } finally {
        await Effect.runPromise(hold.resume);
      }
    },
    onInputEnded: async (key) => {
      sampler?.onInputEnded(key);
      await asking.onInputEnded(key);
    },
    onInputComplete: asking.onInputComplete,
  };

  return {
    answers: liveAnswers(sampler !== undefined, false),
    hooks,
    settle: async () => {
      await Effect.runPromise(questions.settleCall(ask.callId));
      await sampler?.settle();
    },
    sunk: () => {
      const detail = sampler?.sunk();

      return detail === undefined ? undefined : refusedWords(detail);
    },
    notes: () => [
      ...turnedAway,
      ...Arr.map(asking.asked, elicitationNote),
      ...Arr.map(sampler?.asked ?? [], samplingNote),
    ],
  };
};
