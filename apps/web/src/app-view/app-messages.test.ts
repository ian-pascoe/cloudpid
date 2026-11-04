// docs/architecture/mcp-apps.md → App messages and App context. The bridge's handlers for a View's `ui/message` and
// `ui/update-model-context`: what they take, what they hand on, and how they answer.
/* oxlint-disable anti-slop/no-unknown-parameters -- a View's params are whatever it sent */
// @effect-diagnostics preferEffectArray:off asyncFunction:off -- recorded calls in native lists, and promises a handler answers.
import { MAX_APP_MESSAGE_CHARS, MAX_MCP_APP_CONTEXT_INPUT } from "@cloudpid/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  speechHandlers,
  textOfBlocks,
  UI_MESSAGE,
  UI_UPDATE_MODEL_CONTEXT,
} from "./app-messages.ts";
import { RpcError } from "./bridge.ts";

const SIGNAL = { signal: new AbortController().signal };

describe("textOfBlocks", () => {
  it("joins the text blocks and leaves the others out", () => {
    expect(
      textOfBlocks([
        { type: "text", text: "a" },
        { type: "image" },
        { type: "text", text: "b" },
        { type: "resource_link" },
      ]),
    ).toBe("a\n\nb");
  });
});

describe("ui/message", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

  it("hands the text to the composer and answers {} once held, { isError: true } when refused", async () => {
    const message = vi.fn<(text: string) => Promise<"held" | "refused">>();

    message.mockResolvedValueOnce("held").mockResolvedValueOnce("refused");

    const handler = speechHandlers({ message })[UI_MESSAGE];

    await expect(handler?.(user("Pick A"), SIGNAL)).resolves.toEqual({});
    await expect(handler?.(user("Pick B"), SIGNAL)).resolves.toEqual({ isError: true });
    expect(message.mock.calls).toEqual([["Pick A"], ["Pick B"]]);
  });

  it("cuts the text to what the Session takes with a send", async () => {
    const message = vi.fn<(text: string) => Promise<"held" | "refused">>(() =>
      Promise.resolve("held"),
    );

    await speechHandlers({ message })[UI_MESSAGE]?.(
      user("x".repeat(MAX_APP_MESSAGE_CHARS + 50)),
      SIGNAL,
    );

    expect(message.mock.calls[0]?.[0]).toHaveLength(MAX_APP_MESSAGE_CHARS);
  });

  it("answers -32602 to a role that is not user, no content, or no text, and holds nothing", async () => {
    const message = vi.fn<(text: string) => Promise<"held" | "refused">>(() =>
      Promise.resolve("held"),
    );

    const handler = speechHandlers({ message })[UI_MESSAGE];

    for (const params of [
      { role: "assistant", content: [{ type: "text", text: "x" }] },
      { role: "user" },
      { role: "user", content: [{ type: "image", data: "x" }] },
      { role: "user", content: [{ type: "text", text: "  " }] },
      "text",
      undefined,
    ]) {
      await expect(handler?.(params, SIGNAL)).rejects.toMatchObject({
        constructor: RpcError,
        code: -32_602,
      });
    }

    expect(message).not.toHaveBeenCalled();
  });

  it("has no handler when the frame has no composer for it", () => {
    expect(speechHandlers({})[UI_MESSAGE]).toBeUndefined();
    expect(speechHandlers({})[UI_UPDATE_MODEL_CONTEXT]).toBeUndefined();
  });
});

describe("ui/update-model-context", () => {
  it("hands the text of the content to the Session and answers {} once held", async () => {
    const context = vi.fn<(text: string) => Promise<{ held: boolean; message?: string }>>(() =>
      Promise.resolve({ held: true }),
    );

    await expect(
      speechHandlers({ context })[UI_UPDATE_MODEL_CONTEXT]?.(
        {
          content: [
            { type: "text", text: "Row 3 is selected" },
            { type: "image", data: "x" },
          ],
          structuredContent: { row: 3 },
        },
        SIGNAL,
      ),
    ).resolves.toEqual({});

    expect(context).toHaveBeenCalledWith("Row 3 is selected");
  });

  it("sends an empty text for an update with no content, which clears what is pending, and cuts a long one", async () => {
    const context = vi.fn<(text: string) => Promise<{ held: boolean }>>(() =>
      Promise.resolve({ held: true }),
    );

    const handler = speechHandlers({ context })[UI_UPDATE_MODEL_CONTEXT];

    await handler?.({}, SIGNAL);
    await handler?.(
      { content: [{ type: "text", text: "y".repeat(MAX_MCP_APP_CONTEXT_INPUT + 9) }] },
      SIGNAL,
    );

    expect(context.mock.calls[0]).toEqual([""]);
    expect(context.mock.calls[1]?.[0]).toHaveLength(MAX_MCP_APP_CONTEXT_INPUT);
  });

  it("answers the Session's refusal as -32000 with its message", async () => {
    const context = vi.fn(() =>
      Promise.resolve({ held: false, message: "Too many contexts wait" }),
    );

    await expect(
      speechHandlers({ context })[UI_UPDATE_MODEL_CONTEXT]?.({ content: [] }, SIGNAL),
    ).rejects.toMatchObject({ code: -32_000, message: "Too many contexts wait" });
  });

  it("answers -32602 to content that is not a list of blocks", async () => {
    const context = vi.fn(() => Promise.resolve({ held: true }));

    await expect(
      speechHandlers({ context })[UI_UPDATE_MODEL_CONTEXT]?.({ content: "text" }, SIGNAL),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(context).not.toHaveBeenCalled();
  });
});
