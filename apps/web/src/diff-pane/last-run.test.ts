// @effect-diagnostics preferEffectArray:off -- tests of plain functions over values.
import type { ConversationId, LastRun, RunDiff, TranscriptMessage } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { RUN_SOURCE, runSourceOf, sourceOfValue, sourceOptions, sourceValue } from "./branch.ts";
import {
  notCapturedText,
  runAnswerId,
  runLabel,
  runStateText,
  runTotals,
  uncapturedRepos,
} from "./last-run.ts";
import { paneFilesOf } from "./pane-files.ts";

const START = "1".repeat(40);
const END = "2".repeat(40);

const run = (overrides: Partial<LastRun> = {}): LastRun => ({
  run: "run1abc",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  startedAt: 1,
  endedAt: 2,
  firstCall: "call_1",
  until: 9,
  repos: [{ repo: "app", start: START, end: END }],
  ...overrides,
});

const assistant = (id: number, parts: TranscriptMessage["parts"]): TranscriptMessage => ({
  id: String(id),
  role: "assistant",
  parts,
  timestamp: id,
});

const user = (id: number): TranscriptMessage => ({
  id: String(id),
  role: "user",
  parts: [{ type: "text", text: "go" }],
  timestamp: id,
});

const call = (id: string) => ({
  type: "tool-call" as const,
  id,
  name: "write",
  arguments: {},
});

const text = (value: string) => ({ type: "text" as const, text: value });

describe("the Last run in the source picker", () => {
  it("is listed once a Run has written, after the Changes, and round-trips through its value", () => {
    const sources = { repos: [{ repo: "app", head: { commit: START, branch: "main" } }] };

    expect(
      sourceOptions(sources, undefined, null)[0]?.options.map((option) => option.value),
    ).toEqual(["changes", "branch:app"]);
    expect(sourceOptions(sources, undefined, run())[0]?.options).toEqual([
      { value: "changes", label: "Changes" },
      { value: "run", label: runLabel(run()) },
      { value: "branch:app", label: "This branch (main)" },
    ]);
    expect(
      sourceOptions({ repos: [] }, undefined, run())[0]?.options.map((option) => option.value),
    ).toEqual(["changes", "run"]);
    expect(sourceOfValue(sourceValue(RUN_SOURCE))).toEqual({ kind: "run" });
  });

  it("is one entry beside several repos' groups", () => {
    const sources = {
      repos: [
        { repo: "a", head: { commit: START, branch: "main" } },
        { repo: "b", head: { commit: START, branch: "main" } },
      ],
    };

    expect(sourceOptions(sources, undefined, run())[0]).toEqual({
      label: null,
      options: [
        { value: "changes", label: "Changes (every repo)" },
        { value: "run", label: runLabel(run()) },
      ],
    });
  });
});

describe("a draft on the Last run's files", () => {
  it("is written against the repo's copies, ended or live, and a repo with no copy has none", () => {
    expect(runSourceOf(run(), "app")).toEqual({
      kind: "run",
      conversationId: 1,
      run: "run1abc",
      repo: "app",
      start: START,
      end: END,
    });
    expect(
      runSourceOf(
        run({ endedAt: null, until: null, repos: [{ repo: "app", start: START, end: null }] }),
        "app",
      ),
    ).toMatchObject({
      end: null,
    });
    expect(
      runSourceOf(
        run({ repos: [{ repo: "app", start: null, end: null, notCaptured: "too_many_files" }] }),
        "app",
      ),
    ).toBeUndefined();
    expect(runSourceOf(run(), "other")).toBeUndefined();
  });

  it("shows on files with the Run's source, and a Run's end in their signature", () => {
    const repos = [
      {
        repo: "app",
        head: { commit: START, branch: "main" },
        files: [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 0 }],
        more: 0,
        stale: false,
      },
    ];

    const [live] = paneFilesOf(
      repos,
      undefined,
      run({ endedAt: null, until: null, repos: [{ repo: "app", start: START, end: null }] }),
    );

    const [ended] = paneFilesOf(repos, undefined, run());
    const [plain] = paneFilesOf(repos);

    expect(ended?.run).toMatchObject({ run: "run1abc", end: END });
    expect(live?.signature).toContain("@run:run1abc:live");
    expect(ended?.signature).toContain(`@run:run1abc:${END}`);
    expect(plain?.run).toBeUndefined();
  });
});

describe("what the Pane says of the Last run", () => {
  it("labels the picker's entry with a fixed time of day, the end of the Run or the start of a live one", () => {
    expect(runLabel(run({ startedAt: 0, endedAt: 3_600_000 }))).toMatch(
      /^Last run · \d{1,2}[:.]\d{2}/,
    );
    expect(runLabel(run({ startedAt: 60_000, endedAt: null }))).not.toBe(
      runLabel(run({ startedAt: 60_000 + 7_200_000, endedAt: null })),
    );
  });

  it("says whether it is working or when it ended, and why a repo has no copy", () => {
    expect(runStateText(run({ endedAt: null }), () => "x")).toBe("Still working");
    expect(runStateText(run({ endedAt: 5 }), (at) => `at ${at}`)).toBe("Ended at 5");

    const missing = run({
      repos: [
        { repo: "a", start: null, end: null, notCaptured: "container_stopped" },
        { repo: "b", start: START, end: END },
        { repo: "c", start: null, end: null, notCaptured: "too_many_files" },
      ],
    });

    expect(uncapturedRepos(missing)).toEqual([
      { repo: "a", why: notCapturedText("container_stopped") },
      { repo: "c", why: notCapturedText("too_many_files") },
    ]);
    expect(notCapturedText("failed")).toBe("the copy failed");
  });
});

describe("Show changes", () => {
  const transcript = [
    user(1),
    assistant(2, [text("Before")]),
    user(3),
    assistant(4, [call("call_1")]),
    assistant(5, [call("call_2")]),
    assistant(6, [text("Done: I wrote it.")]),
    user(7),
    assistant(8, [text("Later answer")]),
  ];

  // The Run was seen to write at 4, when its first call began.
  const ran = (overrides: Partial<LastRun> = {}) => run({ startedAt: 4, ...overrides });

  it("sits under the last answer without a tool call that the Run made", () => {
    expect(runAnswerId(ran({ until: 6 }), transcript)).toBe(6);
  });

  it("is under the Run's own answer, never a later Run's or an earlier one, and nowhere before the Run has one", () => {
    expect(runAnswerId(ran({ until: 6 }), transcript)).toBe(6);
    expect(runAnswerId(ran({ until: 8 }), transcript)).toBe(8);
    expect(runAnswerId(ran({ until: 5 }), transcript)).toBeUndefined();
  });

  it("is under the same answer when a subagent made the first write, whose call is not in the thread", () => {
    expect(runAnswerId(ran({ firstCall: "call_of_a_subagent", until: 6 }), transcript)).toBe(6);
  });

  it("is nowhere while the Run is live, or when it changed no file", () => {
    expect(runAnswerId(ran({ endedAt: null, until: null }), transcript)).toBeUndefined();
    expect(runAnswerId(ran({ until: 6, empty: true }), transcript)).toBeUndefined();
    expect(runAnswerId(null, transcript)).toBeUndefined();
  });
});

describe("what Show changes sums up", () => {
  const repo = (name: string, files: RunDiff["repos"][number]["files"], more = 0) => ({
    repo: name,
    head: { commit: START, branch: "main" },
    files,
    more,
    stale: false,
  });

  const ended = (repos: RunDiff["repos"]): RunDiff => ({ run: "run1abc", live: false, repos });

  it("is the files and lines of every repo the Run changed, those past the cap counted too", () => {
    const diff = ended([
      repo("app", [
        { path: "a.ts", status: "modified", additions: 13, deletions: 0 },
        { path: "b.ts", status: "added", additions: 2, deletions: 1 },
      ]),
      repo("api", [{ path: "c.ts", status: "deleted", additions: 0, deletions: 4 }], 3),
    ]);

    expect(runTotals("run1abc", diff)).toEqual({
      files: 6,
      additions: 15,
      deletions: 5,
      approximate: false,
      stale: false,
    });
  });

  it("says ≈ when a file's counts are whole-file numbers", () => {
    const diff = ended([
      repo("app", [
        { path: "a.ts", status: "modified", additions: 40, deletions: 38, approximate: true },
      ]),
    ]);

    expect(runTotals("run1abc", diff)).toMatchObject({ files: 1, approximate: true });
  });

  it("is nothing for another Run's diff, a live one, or none", () => {
    const diff = ended([
      repo("app", [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }]),
    ]);

    expect(runTotals("run2def", diff)).toBeNull();
    expect(runTotals("run1abc", { ...diff, live: true })).toBeNull();
    expect(runTotals("run1abc", null)).toBeNull();
  });
});
