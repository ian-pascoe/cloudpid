// The host's list of the Legacy questions that wait on a call (`waiting-questions.ts`, #569): ended once when a set
// change gives a reason, and an answer that arrives after that is not sent on.
// @effect-diagnostics asyncFunction:off newPromise:off
import type { McpHostRequestHooks, McpInputAnswer } from "@cloudpid/mcp/types";
import { describe, expect, it, vi } from "vite-plus/test";
import { END_TOLD_WITHIN_MS, waitingQuestions } from "./waiting-questions.ts";

type Answer = typeof McpInputAnswer.Encoded;

const FORM = {
  key: "q1",
  kind: "elicitation" as const,
  mode: "live" as const,
  params: { message: "?" },
};

/** A call that waits on `FORM` until `answer(...)`, and the notices its caller got. */
const waiting = () => {
  const questions = waitingQuestions();
  const ended: Array<readonly [string, string | undefined]> = [];
  let answer: (given: Answer) => void = () => undefined;

  const hooks: McpHostRequestHooks = {
    onInput: () => new Promise<Answer>((resolve) => (answer = resolve)),
    onInputEnded: (key, reason) => {
      ended.push([key, reason]);
    },
  };

  const withWaiting = questions.watchInput({ name: "docs", conn: "c1" }, hooks);
  const result = withWaiting.onInput?.(FORM);

  return { questions, ended, result, answer: (given: Answer) => answer(given) };
};

const ACCEPT: Answer = { kind: "answered", result: { action: "accept", content: { name: "Ada" } } };

describe("waitingQuestions", () => {
  it("tells the caller once, with the reason, and only for a server it has one for", async () => {
    const { questions, ended, result, answer } = waiting();

    questions.endWhere(() => undefined);
    expect(ended).toEqual([]);

    questions.endWhere((server) => (server.conn === "c1" ? "docs was changed" : undefined));
    questions.endWhere(() => "docs was removed");
    await Promise.resolve();
    expect(ended).toEqual([["q1", "docs was changed"]]);

    answer({ kind: "answered", result: { action: "cancel" } });
    expect(await result).toEqual({ kind: "answered", result: { action: "cancel" } });
  });

  it("does not send on an answer that came after the question was ended", async () => {
    const { questions, ended, result, answer } = waiting();

    questions.endWhere(() => "docs was changed");
    answer(ACCEPT);

    expect(await result).toEqual({ kind: "answered", result: { action: "cancel" } });
    // The caller is told again, before the server is answered: its record of the answer may have come after the first word.
    expect(ended).toEqual([
      ["q1", "docs was changed"],
      ["q1", "docs was changed"],
    ]);
  });

  it("does not hold an answer back for a caller that never hears the second word", async () => {
    vi.useFakeTimers();

    try {
      const questions = waitingQuestions();
      let heard = 0;
      let answer: (given: Answer) => void = () => undefined;

      const hooks: McpHostRequestHooks = {
        onInput: () => new Promise<Answer>((resolve) => (answer = resolve)),
        // The first word is heard; the second never returns, as a Session that was evicted does not.
        onInputEnded: () => {
          heard += 1;

          return heard === 1 ? undefined : new Promise<void>(() => undefined);
        },
      };

      const result = questions.watchInput({ name: "docs", conn: "c1" }, hooks).onInput?.(FORM);

      questions.endWhere(() => "docs was changed");
      answer(ACCEPT);

      let settled = false;

      void result?.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(END_TOLD_WITHIN_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({ kind: "answered", result: { action: "cancel" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an answer on when nothing ended the question, and forgets the question once answered", async () => {
    const { questions, ended, result, answer } = waiting();

    answer(ACCEPT);
    expect(await result).toEqual(ACCEPT);

    questions.endWhere(() => "docs was changed");
    await Promise.resolve();
    expect(ended).toEqual([]);
  });

  it("leaves the hooks of a caller that cannot be told, or cannot answer, as they are", () => {
    const questions = waitingQuestions();
    const bare: McpHostRequestHooks = { onInput: () => Promise.resolve(ACCEPT) };

    expect(questions.watchInput({ name: "docs", conn: "c1" }, bare)).toBe(bare);
    expect(questions.watchInput({ name: "docs", conn: "c1" }, {})).toEqual({});
  });
});
