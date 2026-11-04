// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What a prompt send's `prompts/get` does with the questions its server asks (`docs/architecture/mcp-server-requests.md`
// → Questions, Elicitation requests, Sampling requests; `docs/architecture/mcp-in-a-session.md` → Getting a prompt at
// send): the hooks the Session passes with the get to the host (`onInput`, `onInputEnded`, `onInputComplete`) and the
// `ctx.answers` that say the get may be asked. Every question is live in both eras: a form, or a Sampling request, waits
// on its card for the owner for at most `MCP_PROMPT_QUESTION_WAIT_MS` and tells them nothing (they are at the composer),
// the get's own clock stands still meanwhile (`pause`, `resume`), and Stop withdraws the card (`signal`). A Modern
// server's round is answered on the spot too, never kept for later: the get has no resume (`noDeferral` in the core).
import { declaresSampling, samplingOf } from "@cloudpid/config";
import {
  type McpAnswers,
  type McpHostRequestHooks,
  MCP_PROMPT_QUESTION_WAIT_MS,
  plainLine,
} from "@cloudpid/mcp/types";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { elicitingHooks } from "./elicit.ts";
import { samplingHooks, wordsOf } from "./sample.ts";
import { type McpSamplingService, SAMPLING_SAMPLE_MS } from "./sampling.ts";
import type { McpQuestionsService } from "./questions.ts";
import type { McpBuildServer } from "./tools.ts";

/** The longest a prompt's title is, as the card says it, in characters. */
const TITLE_LENGTH = 120;

/** One prompt send's get, as the Session knows it. */
export type PromptAsk = {
  /** The configured name of the server the prompt is got from. */
  readonly server: string;
  /** The get's own ID, unique within the Session: what its questions are kept under, and withdrawn by. */
  readonly callId: string;
  /** The prompt's Slash command: what a client from before the prompt origin reads as the tool. */
  readonly command: string;
  /** The title the card says ("getting prompt <title>"): the prompt's title, else its name. */
  readonly title: string;
  readonly conversationId: ConversationId;
  /** Aborts when Stop does: a question waiting then is withdrawn. */
  readonly signal: AbortSignal | undefined;
  /** The get's own clock: stopped while a question waits, and started again. */
  readonly hold: PromptHold;
};

/** What stops and starts a get's own clock. */
export type PromptHold = {
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
};

/** What the Session gives to the get, and what it takes back. */
export type PromptAsking = {
  /** What the get says it can answer (`ctx.answers`). */
  readonly answers: McpAnswers;
  /** The hooks the get's host request carries. */
  readonly hooks: Pick<McpHostRequestHooks, "onInput" | "onInputEnded" | "onInputComplete">;
  /** The get is over, however it ended: every question it still waits on is withdrawn, and its counts are forgotten. */
  readonly settle: () => Promise<void>;
  /**
   * What the send is refused with when a Modern server's Sampling request was refused: that ends the get locally, the
   * server told nothing (an `InputResponse` has no error form), in words that carry nothing the server wrote. Absent while
   * none was.
   */
  readonly sunk: () => string | undefined;
};

/**
 * What a get says it can answer: a form, for as long as the owner has to answer it and a little more, so the Session's own
 * end of the wait comes first; and a Sampling request, which may run (`SAMPLING_SAMPLE_MS`) after the owner has said yes.
 * Neither is kept for later (no `defer`, no `pages`): a prompt send has no resume.
 */
const answersOf = (samples: boolean): McpAnswers =>
  samples
    ? {
        elicitation: true,
        sampling: true,
        inputWaitMs: MCP_PROMPT_QUESTION_WAIT_MS + SAMPLING_SAMPLE_MS + 15_000,
      }
    : { elicitation: true, inputWaitMs: MCP_PROMPT_QUESTION_WAIT_MS + 15_000 };

/** The hooks of a prompt send whose Session can show questions, or none without them. */
export const promptAsking = (
  deps: {
    readonly questions: McpQuestionsService | undefined;
    readonly sampling: McpSamplingService | undefined;
    /** Whether the host lists `sampling`: without it no server is told it may sample. */
    readonly hostSamples: boolean;
  },
  /** The server the prompt is got from, as the tools were last built. */
  server: McpBuildServer,
  ask: PromptAsk,
): PromptAsking | undefined => {
  const { questions, sampling } = deps;

  if (questions === undefined) return undefined;

  const title = plainLine(ask.title, TITLE_LENGTH);
  const { hold } = ask;

  const asking = elicitingHooks({
    questions,
    server: server.name,
    // The prompt's Slash command stands for the tool: a client from before `prompt` shows "during <command>".
    tool: ask.command,
    prompt: title,
    callId: ask.callId,
    conversationId: ask.conversationId,
    signal: ask.signal,
    source: server.source,
    ...hold,
  });

  // A server whose definition says `off` (or a stdio one) is declared no sampling, so none is asked.
  const sampler =
    sampling !== undefined && deps.hostSamples && declaresSampling(server.server)
      ? samplingHooks({
          sampling,
          server: server.name,
          // The prompt's Slash command stands for the tool, as above.
          tool: ask.command,
          prompt: title,
          callId: ask.callId,
          conversationId: ask.conversationId,
          signal: ask.signal,
          decision: samplingOf(server.server) === "allow" ? "allow" : "ask",
          source: server.source,
          hold,
        })
      : undefined;

  const hooks: Mutable<PromptAsking["hooks"]> = {
    onInput: asking.onInput,
    onInputEnded: asking.onInputEnded,
    onInputComplete: asking.onInputComplete,
  };

  if (sampler !== undefined) {
    // A request goes to the hook of its kind. The get's clock stands still for the whole of a sample too, not only for the
    // owner's card: the model may take its 2 minutes after the owner has said yes.
    hooks.onInput = async (input) => {
      if (input.kind !== "sampling") return asking.onInput(input);

      await Effect.runPromise(hold.pause);

      try {
        return await sampler.onInput(input);
      } finally {
        await Effect.runPromise(hold.resume);
      }
    };

    hooks.onInputEnded = async (key) => {
      sampler.onInputEnded(key);
      await asking.onInputEnded(key);
    };
  }

  return {
    answers: answersOf(sampler !== undefined),
    hooks,
    settle: async () => {
      await Effect.runPromise(questions.settleCall(ask.callId));
      await sampler?.settle();
    },
    sunk: () => {
      const detail = sampler?.sunk();

      return detail === undefined
        ? undefined
        : `${detail.server} asked for a model reply, which was ${wordsOf(detail)}`;
    },
  };
};
