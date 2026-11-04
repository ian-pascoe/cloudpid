// @effect-diagnostics preferEffectRecord:off -- assertions over the arguments of one prompt.

import { type McpPromptData, type McpPromptEntry, mcpPromptCallId } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";
import {
  awaitedLine,
  chipProblem,
  chipStanding,
  chipText,
  gettingText,
  needsForm,
  offeredPrompt,
  promptLane,
  promptWaitingFor,
  refOf,
  refusalOfCause,
  refusalOutcome,
  restoredChip,
  sendGate,
  startingValues,
  sendingRows,
  withPrompt,
} from "./mcp-prompt-state.ts";

const REVIEW: McpPromptEntry = {
  command: "/mcp__docs__review",
  server: "docs",
  source: "owner",
  name: "review",
  title: "Review PR",
  description: "Review a pull request",
  arguments: [
    { name: "pr", required: true },
    { name: "focus", required: false },
  ],
  completions: false,
};

const { title: _title, ...untitled } = REVIEW;

const chip = (values: Record<string, string>) => ({ prompt: REVIEW, values });

describe("the MCP prompt chip", () => {
  it("sends the declared arguments only, in declared order, cleaned, with an empty optional one left out", () => {
    expect(refOf(chip({ gone: "dropped", focus: "", pr: "7\u0000" }))).toEqual({
      server: "docs",
      name: "review",
      arguments: { pr: "7" },
    });
    expect(refOf({ prompt: { ...REVIEW, arguments: [] }, values: {} })).toEqual({
      server: "docs",
      name: "review",
    });
  });

  it("says what is missing before it is sent", () => {
    expect(chipProblem(chip({ pr: "" }))).toBe("The argument pr is required");
    expect(chipProblem(chip({ pr: "7" }))).toBeUndefined();
  });

  it("is a label, then the arguments with a value, each on one line and cut", () => {
    expect(chipText(chip({ pr: "7", focus: "" }))).toBe("docs · Review PR · pr: 7");
    expect(chipText(chip({ pr: "line one\nline two", focus: "x".repeat(60) }))).toBe(
      `docs · Review PR · pr: line one line two · focus: ${"x".repeat(39)}…`,
    );
    expect(chipText({ prompt: { ...untitled }, values: {} })).toBe("docs · review");
  });

  it("needs a form only for a prompt with arguments, and starts it with each declared value empty", () => {
    expect(needsForm(REVIEW)).toBe(true);
    expect(needsForm({ ...REVIEW, arguments: [] })).toBe(false);
    expect(startingValues(REVIEW, { focus: "tests", gone: "x" })).toEqual({
      pr: "",
      focus: "tests",
    });
  });

  it("makes a message of the prompt: its ref, a lane that says it is being got, and the label with what was typed", () => {
    const sent = withPrompt(
      { input: "focus on tests", display: "focus on tests" },
      chip({ pr: "7" }),
    );

    expect(sent).toEqual({
      input: "focus on tests",
      display: "docs · Review PR · focus on tests",
      mcpPrompt: { server: "docs", name: "review", arguments: { pr: "7" } },
      getting: "Getting Review PR from docs…",
    });
    expect(promptLane(chip({}), "")).toBe("docs · Review PR");
    expect(gettingText(chip({}))).toBe("Getting Review PR from docs…");
  });
});

describe("the lane row of a prompt being got", () => {
  const rows = [
    { id: "r1", text: "Getting Review PR from docs…" },
    { id: "r2", text: "Getting Summarize from wiki…" },
    { id: "r3", text: "a plain message" },
  ];

  const asked = (requestId: string, prompt: string | undefined = "Review PR", server = "docs") => ({
    callId: mcpPromptCallId(requestId),
    server,
    prompt,
  });

  it("says it waits for the owner's answer while the send's get asks one", () => {
    expect(sendingRows(rows, [asked("r1")])).toEqual([
      { id: "r1", text: "Getting Review PR from docs · waiting for your answer", awaited: true },
      { ...rows[1], awaited: false },
      { ...rows[2], awaited: false },
    ]);
  });

  it("is left as it is when nothing is asked, or another send's get is", () => {
    const plain = Arr.map(rows, (row) => ({ ...row, awaited: false }));

    expect(sendingRows(rows, [])).toEqual(plain);
    expect(sendingRows(rows, [asked("other")])).toEqual(plain);
    // A question of a tool's call carries no prompt.
    expect(sendingRows(rows, [{ callId: mcpPromptCallId("r1"), server: "docs" }])).toEqual(plain);
  });

  it("finds a row whose title the card cleaned or cut", () => {
    const long = "A very long title ".repeat(20);
    const spaced = "Review   the\n  PR";
    const cut = long.slice(0, 119).trimEnd() + "…";

    const titled = [
      { id: "long", text: `Getting ${long} from docs…` },
      { id: "spaced", text: `Getting ${spaced} from docs…` },
    ];

    expect(sendingRows(titled, [asked("long", cut), asked("spaced", "Review the PR")])).toEqual([
      { id: "long", text: awaitedLine(cut, "docs"), awaited: true },
      { id: "spaced", text: awaitedLine("Review the PR", "docs"), awaited: true },
    ]);
  });

  it("marks only the send that waits when two sends are of the same prompt", () => {
    const twice = [
      { id: "first", text: "Getting Review PR from docs…" },
      { id: "second", text: "Getting Review PR from docs…" },
    ];

    expect(sendingRows(twice, [asked("second")])).toEqual([
      { id: "first", text: "Getting Review PR from docs…", awaited: false },
      { id: "second", text: awaitedLine("Review PR", "docs"), awaited: true },
    ]);
  });
});

describe("the chip Branch gives back", () => {
  const data: McpPromptData = {
    server: "docs",
    command: "/mcp__docs__review",
    name: "review",
    title: "Review PR (old title)",
    arguments: { pr: "7", token: "[redacted]" },
    parts: [],
    resources: [],
  };

  it("is the catalog's prompt with the arguments as they were kept, when it is still offered", () => {
    expect(restoredChip(data, { prompts: [REVIEW] })).toEqual({
      prompt: REVIEW,
      values: { pr: "7", token: "[redacted]" },
    });
  });

  it("is the prompt as the message knew it when the catalog does not offer it, and the chip then cannot be sent", () => {
    const restored = restoredChip(data, { prompts: [] });

    expect(restored.prompt).toMatchObject({
      server: "docs",
      name: "review",
      title: "Review PR (old title)",
    });
    expect(chipStanding(restored, { prompts: [] })).toEqual({
      kind: "gone",
      message: "docs no longer offers Review PR (old title)",
    });
    expect(chipStanding(restored, {})).toMatchObject({ kind: "gone" });
  });

  it("is taken to be offered while the catalog is not known, and is judged by the live definition once it is", () => {
    const restored = restoredChip(data, null);

    // Not known yet: the Session decides.
    expect(chipStanding(restored, null)).toMatchObject({ kind: "ready" });
    // Known: the live definition declares `pr` as required and the values have it, so it is ready, with that definition.
    expect(chipStanding(restored, { prompts: [REVIEW] })).toEqual({
      kind: "ready",
      prompt: REVIEW,
    });
    // The prompt now requires an argument the message never had.
    expect(
      chipStanding(restored, {
        prompts: [{ ...REVIEW, arguments: [{ name: "branch", required: true }] }],
      }),
    ).toMatchObject({ kind: "arguments", message: "The argument branch is required" });
  });

  it("finds a prompt by its server and name", () => {
    expect(offeredPrompt({ prompts: [REVIEW] }, { server: "docs", name: "review" })).toBe(REVIEW);
    expect(offeredPrompt({ prompts: [REVIEW] }, { server: "docs", name: "other" })).toBeUndefined();
    expect(offeredPrompt(null, { server: "docs", name: "review" })).toBeUndefined();
  });
});

describe("what holds a message back while an MCP prompt is in the composer", () => {
  const ready = { kind: "ready", prompt: REVIEW } as const;

  it("is its open form, whatever else is true: nothing is sent until Done or Cancel", () => {
    const form = { prompt: REVIEW, values: {} };

    expect(promptWaitingFor({ form, chip: null, standing: null, reviewing: false })).toMatch(
      /Fill in the prompt's arguments/,
    );
    expect(
      promptWaitingFor({ form, chip: chip({ pr: "1" }), standing: ready, reviewing: false }),
    ).toMatch(/Fill in the prompt's arguments/);
  });

  it("is a Review the prompt cannot go with, a prompt the catalog dropped, or arguments it now needs", () => {
    const held = { form: null, chip: chip({ pr: "1" }) } as const;

    expect(promptWaitingFor({ ...held, standing: ready, reviewing: true })).toMatch(/Review/);
    expect(
      promptWaitingFor({
        ...held,
        standing: { kind: "gone", message: "docs no longer offers Review PR" },
        reviewing: false,
      }),
    ).toBe("docs no longer offers Review PR");
    expect(
      promptWaitingFor({
        ...held,
        standing: { kind: "arguments", message: "The argument branch is required", prompt: REVIEW },
        reviewing: false,
      }),
    ).toBe("The argument branch is required");
  });

  it("is nothing for a chip that can be sent, or no chip", () => {
    expect(
      promptWaitingFor({ form: null, chip: chip({ pr: "1" }), standing: ready, reviewing: false }),
    ).toBeNull();
    expect(
      promptWaitingFor({ form: null, chip: null, standing: null, reviewing: true }),
    ).toBeNull();
  });
});

describe("what a send does about an MCP prompt in the composer", () => {
  const ready = { kind: "ready", prompt: REVIEW } as const;

  it("goes ahead for no chip, or one that can be sent", () => {
    expect(sendGate({ form: null, chip: null, standing: null, reviewing: false })).toEqual({
      send: true,
    });
    expect(
      sendGate({ form: null, chip: chip({ pr: "1" }), standing: ready, reviewing: false }),
    ).toEqual({ send: true });
  });

  it("is held back, with the reason, while the form is open or the prompt cannot go with a Review", () => {
    expect(
      sendGate({
        form: { prompt: REVIEW, values: {} },
        chip: null,
        standing: null,
        reviewing: false,
      }),
    ).toMatchObject({ send: false, note: expect.stringMatching(/Fill in/) });
    expect(
      sendGate({ form: null, chip: chip({ pr: "1" }), standing: ready, reviewing: true }),
    ).toEqual({ send: false, note: expect.stringMatching(/Review/) });
  });

  it("is held back for a prompt the catalog dropped, with no form to open", () => {
    expect(
      sendGate({
        form: null,
        chip: chip({ pr: "1" }),
        standing: { kind: "gone", message: "docs no longer offers Review PR" },
        reviewing: false,
      }),
    ).toEqual({ send: false, note: "docs no longer offers Review PR" });
  });

  it("opens the form, with what is missing above it, for arguments the catalog now needs", () => {
    const prompt = {
      ...REVIEW,
      arguments: [...REVIEW.arguments, { name: "branch", required: true }],
    };

    expect(
      sendGate({
        form: null,
        chip: chip({ pr: "1" }),
        standing: { kind: "arguments", message: "The argument branch is required", prompt },
        reviewing: false,
      }),
    ).toEqual({
      send: false,
      note: "The argument branch is required",
      form: {
        prompt,
        values: { pr: "1", focus: "", branch: "" },
        problem: "The argument branch is required",
      },
    });
  });
});

describe("what a refused send of an MCP prompt does", () => {
  it("reopens the form for arguments, offers a sign-in for a server that needs one, and retries a failed get", () => {
    expect(refusalOutcome("The argument pr is required", { code: "MCP_PROMPT_ARGUMENTS" })).toEqual(
      {
        message: "The argument pr is required",
        reopenForm: true,
        retry: false,
        signIn: undefined,
        refreshCatalog: true,
      },
    );
    expect(
      refusalOutcome("Sign in", { code: "MCP_SIGN_IN_REQUIRED", server: "docs" }),
    ).toMatchObject({ reopenForm: false, retry: true, signIn: "docs", refreshCatalog: false });
    expect(refusalOutcome("Too big", { code: "MCP_PROMPT_TOO_LARGE" })).toMatchObject({
      retry: false,
      refreshCatalog: false,
    });
    expect(refusalOutcome("down", { code: "MCP_PROMPT_FAILED" })).toMatchObject({
      retry: true,
      refreshCatalog: true,
      reopenForm: false,
    });
  });

  it("treats a refusal with no code, or one it does not know, as a failed get: the chip comes back, the catalog is asked for again, and the owner may retry", () => {
    for (const refusal of [undefined, {}, { code: "A_CODE_FROM_A_NEWER_SESSION" }]) {
      expect(refusalOutcome("Excess property", refusal)).toEqual({
        message: "Excess property",
        reopenForm: false,
        retry: true,
        signIn: undefined,
        refreshCatalog: true,
      });
    }
  });

  it("reads the refusal of a failure that carries one", () => {
    expect(
      refusalOfCause(
        Cause.fail({ message: "m", refusal: { code: "MCP_PROMPT_FAILED", server: "docs" } }),
      ),
    ).toEqual({ code: "MCP_PROMPT_FAILED", server: "docs" });
    expect(refusalOfCause(Cause.fail(new Error("closed")))).toBeUndefined();
  });
});
