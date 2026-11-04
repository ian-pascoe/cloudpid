// The argument form's completions (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): asked on focus and
// 120 ms after typing stops, a newer keystroke cancelling the older request, answers cached for the form's life, the last
// answer narrowed while the next is awaited, and nothing asked again of a server that cannot answer.
// @effect-diagnostics globalTimers:off asyncFunction:off newPromise:off preferEffectArray:off
import { MCP_COMPLETE_DEBOUNCE_MS, type McpCompletion } from "@cloudpid/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompleteFn,
  type CompletionAsk,
  completionContext,
  createCompleter,
  suggestionNote,
} from "./argument-completion.ts";

const ok = (values: readonly string[], more: Partial<McpCompletion> = {}): McpCompletion => ({
  status: "ok",
  values,
  hasMore: false,
  ...more,
});

/** A server that answers each request when the test says so, and notes which were cancelled. */
const server = () => {
  const asked: Array<{
    ask: CompletionAsk;
    signal: AbortSignal;
    answer: (completion: McpCompletion) => void;
  }> = [];

  const complete: CompleteFn = (ask, signal) =>
    new Promise<McpCompletion>((resolve, reject) => {
      asked.push({ ask, signal, answer: resolve });
      signal.addEventListener("abort", () => {
        reject(new Error("cancelled"));
      });
    });

  return { asked, complete };
};

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("completionContext", () => {
  it("carries the other fields' non-empty values, never the field's own, and none over the bound", () => {
    expect(
      completionContext(
        { owner: "ian", repo: "cl", empty: "  ", long: "x".repeat(1001), other: "a" },
        "repo",
      ),
    ).toEqual({ owner: "ian", other: "a" });
  });
});

describe("a form's completions", () => {
  it("asks on focus at once, with the other fields as context", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "", { owner: "ian", repo: "" });

    expect(asked.map((each) => each.ask)).toEqual([
      { field: "repo", argument: { name: "repo", value: "" }, context: { owner: "ian" } },
    ]);
    expect(completer.state("repo").status).toBe("loading");

    asked[0]?.answer(ok(["claude", "cloud"], { total: 2 }));
    await flush();

    expect(completer.state("repo")).toMatchObject({ status: "ok", values: ["claude", "cloud"] });
    expect(completer.suggestions("repo", "")).toEqual(["claude", "cloud"]);
  });

  it("asks once typing has stopped for the debounce, and only for the last value", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.edit("repo", "c", { repo: "c" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS - 20);
    completer.edit("repo", "cl", { repo: "cl" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS - 20);

    expect(asked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20);

    expect(asked.map((each) => each.ask.argument.value)).toEqual(["cl"]);
  });

  it("cancels the older request when a newer keystroke comes, and reads nothing of its late answer", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.edit("repo", "c", { repo: "c" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    const [older] = asked;

    expect(older?.signal.aborted).toBe(false);

    // The next keystroke cancels it at once, before the newer request is even sent.
    completer.edit("repo", "cl", { repo: "cl" });

    expect(older?.signal.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    expect(asked.map((each) => each.ask.argument.value)).toEqual(["c", "cl"]);

    // The older answer arrives late, after the newer request was made: it is not shown.
    older?.answer(ok(["stale"]));
    asked[1]?.answer(ok(["cloud"]));
    await flush();

    expect(completer.state("repo").values).toEqual(["cloud"]);
  });

  it("has one request in flight for each field: another field's is not cancelled", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("owner", "i", { owner: "i" });
    completer.focus("repo", "c", { repo: "c" });

    expect(asked.map((each) => each.signal.aborted)).toEqual([false, false]);

    completer.focus("repo", "cl", { repo: "cl" });

    expect(asked.map((each) => each.signal.aborted)).toEqual([false, true, false]);
  });

  it("keeps answers for the form's life by value and context: the same ask is not sent again, another context is", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "cl", { owner: "ian", repo: "cl" });
    asked[0]?.answer(ok(["cloud"]));
    await flush();

    completer.focus("repo", "c", { owner: "ian", repo: "c" });
    asked[1]?.answer(ok(["claude"]));
    await flush();

    // Back to a value asked before, with the same context: from the cache, and nothing in flight is left.
    completer.focus("repo", "cl", { owner: "ian", repo: "cl" });

    expect(asked).toHaveLength(2);
    expect(completer.state("repo")).toMatchObject({ status: "ok", values: ["cloud"] });

    completer.edit("repo", "cl", { owner: "ian", repo: "cl" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    expect(asked).toHaveLength(2);

    // The same value with another owner is another question.
    completer.focus("repo", "cl", { owner: "acme", repo: "cl" });

    expect(asked).toHaveLength(3);
  });

  it("answers a cached value at once and cancels the request still out for the older one", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "a", { repo: "a" });
    asked[0]?.answer(ok(["alpha"]));
    await flush();

    completer.edit("repo", "ab", { repo: "ab" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    const [, out] = asked;

    expect(out?.signal.aborted).toBe(false);

    completer.edit("repo", "a", { repo: "a" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    expect(out?.signal.aborted).toBe(true);
    expect(asked).toHaveLength(2);
    expect(completer.state("repo")).toMatchObject({ status: "ok", values: ["alpha"] });
  });

  it("narrows the last answer to what is typed while the next is awaited, and shows the server's own for its value", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "", { repo: "" });
    asked[0]?.answer(ok(["claude", "cloud", "docs"]));
    await flush();

    completer.edit("repo", "clo", { repo: "clo" });

    expect(completer.suggestions("repo", "clo")).toEqual(["cloud"]);
    expect(completer.suggestions("repo", "")).toEqual(["claude", "cloud", "docs"]);
  });

  it("says to keep typing when the server has more than it sent", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "", { repo: "" });
    asked[0]?.answer(ok(["a"], { total: 120, hasMore: true }));
    await flush();

    expect(suggestionNote(completer.state("repo"), "docs")).toEqual({
      kind: "text",
      text: "120 suggestions: keep typing",
    });
  });

  it("asks nothing more of a server that cannot answer, and says why under the field", async () => {
    for (const [status, note] of [
      ["unsupported", undefined],
      ["not_running", { kind: "text", text: "Suggestions once docs is running" }],
      ["sign_in", { kind: "sign_in", text: "Sign in to docs for suggestions" }],
    ] as const) {
      const { asked, complete } = server();
      const completer = createCompleter({ scope: "docs", complete });

      completer.focus("repo", "", { repo: "" });
      asked[0]?.answer({ status, values: [], hasMore: false });
      await flush();

      completer.focus("owner", "", { owner: "" });
      completer.edit("repo", "x", { repo: "x" });
      await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

      expect(asked).toHaveLength(1);
      expect(completer.state("owner").status).toBe(status);
      expect(suggestionNote(completer.state("repo"), "docs")).toEqual(note);
    }
  });

  it("says suggestions are unavailable after a failure, and asks the next value as usual: never the same again", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "c", { repo: "c" });
    asked[0]?.answer({ status: "failed", values: [], hasMore: false });
    await flush();

    expect(suggestionNote(completer.state("repo"), "docs")).toEqual({
      kind: "text",
      text: "Suggestions unavailable",
    });

    completer.edit("repo", "cl", { repo: "cl" });
    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);

    expect(asked).toHaveLength(2);
    expect(suggestionNote(completer.state("repo"), "docs")).toEqual({
      kind: "text",
      text: "Loading suggestions…",
    });
  });

  it("reads a request that rejects as failed, and a status it does not know as failed", async () => {
    const completer = createCompleter({
      scope: "docs",
      complete: () => Promise.reject(new Error("socket down")),
    });

    completer.focus("repo", "", { repo: "" });
    await flush();

    expect(completer.state("repo").status).toBe("failed");

    const { asked, complete } = server();
    const next = createCompleter({ scope: "docs", complete });

    next.focus("repo", "", { repo: "" });
    asked[0]?.answer({ status: "something_new", values: ["x"], hasMore: false });
    await flush();

    expect(next.state("repo").status).toBe("failed");
  });

  it("cancels everything when the form closes, and tells nobody after", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });
    const told = vi.fn();

    completer.subscribe(told);
    completer.focus("repo", "c", { repo: "c" });
    completer.edit("owner", "i", { owner: "i" });
    told.mockClear();
    completer.close();

    expect(asked[0]?.signal.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(MCP_COMPLETE_DEBOUNCE_MS);
    asked[0]?.answer(ok(["late"]));
    await flush();

    expect(asked).toHaveLength(1);
    expect(told).not.toHaveBeenCalled();
  });

  it("asks nothing for a value over the bound", async () => {
    const { asked, complete } = server();
    const completer = createCompleter({ scope: "docs", complete });

    completer.focus("repo", "x".repeat(1001), { repo: "x" });

    expect(asked).toHaveLength(0);
  });
});
