// @effect-diagnostics preferEffectRecord:off -- assertions over the arguments of one prompt.

import type { McpPromptData, McpPromptEntry } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";
import {
  chipProblem,
  chipStanding,
  chipText,
  gettingText,
  needsForm,
  offeredPrompt,
  promptLane,
  refOf,
  refusalFields,
  refusalOutcome,
  restoredChip,
  startingValues,
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

describe("what a refused send of an MCP prompt does", () => {
  it("reopens the form for arguments, offers a sign-in for a server that needs one, and retries a failed get", () => {
    expect(
      refusalOutcome({ message: "The argument pr is required", code: "MCP_PROMPT_ARGUMENTS" }),
    ).toEqual({
      message: "The argument pr is required",
      reopenForm: true,
      retry: false,
      signIn: undefined,
      refreshCatalog: true,
    });
    expect(
      refusalOutcome({ message: "Sign in", code: "MCP_SIGN_IN_REQUIRED", server: "docs" }),
    ).toMatchObject({ reopenForm: false, retry: true, signIn: "docs" });
    expect(refusalOutcome({ message: "Too big", code: "MCP_PROMPT_TOO_LARGE" })).toMatchObject({
      retry: false,
      refreshCatalog: false,
    });
    expect(refusalOutcome({ message: "down", code: "MCP_PROMPT_FAILED" })).toMatchObject({
      retry: true,
      refreshCatalog: true,
      reopenForm: false,
    });
  });

  it("treats a refusal with no code, or one it does not know, as a failed get: the chip comes back and may be retried", () => {
    for (const code of [undefined, "A_CODE_FROM_A_NEWER_SESSION"]) {
      expect(refusalOutcome({ message: "Excess property", code })).toMatchObject({
        message: "Excess property",
        reopenForm: false,
        retry: true,
        signIn: undefined,
      });
    }
  });

  it("reads the code and server of a failure that carries them", () => {
    expect(
      refusalFields(Cause.fail({ message: "m", code: "MCP_PROMPT_FAILED", server: "docs" })),
    ).toEqual({ code: "MCP_PROMPT_FAILED", server: "docs" });
    expect(refusalFields(Cause.fail(new Error("closed")))).toEqual({});
  });
});
