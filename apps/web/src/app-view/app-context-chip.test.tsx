// docs/architecture/mcp-apps.md → App messages and App context: the chip of the last context a View told the model.
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppContextChip, contextLine } from "./app-context-chip.tsx";
import { speechOf } from "./app-call.tsx";

describe("the context chip", () => {
  it("shows nothing for a View that told the model nothing", () => {
    expect(renderToStaticMarkup(<AppContextChip context={undefined} />)).toBe("");
  });

  it("shows the last context as a line, pending until a turn took it", () => {
    const html = renderToStaticMarkup(
      <AppContextChip context={{ hash: "h", text: "Row 3\n is selected", at: 1 }} />,
    );

    expect(html).toContain("Row 3 is selected");
    expect(html).toContain("Pending");

    expect(
      renderToStaticMarkup(
        <AppContextChip context={{ hash: "h", text: "Row 3", at: 1, delivered: true }} />,
      ),
    ).toContain("Sent to the model");
  });

  it("cuts a long context to a line", () => {
    expect(contextLine("x".repeat(400))).toHaveLength(120);
    expect(contextLine("x".repeat(400)).endsWith("…")).toBe(true);
  });
});

describe("what a card lets its View say", () => {
  const client = (takes: { appMessages: boolean; appContext: boolean }) => ({
    takes: () => takes,
    appContext: () => Effect.die("not used"),
  });

  it("offers a message and a context only as far as the Session on the connection takes them", () => {
    const hold = () => Promise.resolve("held" as const);

    expect(speechOf(undefined, "c1", "docs", hold)).toEqual({});
    expect(
      Object.keys(speechOf(client({ appMessages: false, appContext: false }), "c1", "docs", hold)),
    ).toEqual([]);
    expect(
      Object.keys(speechOf(client({ appMessages: true, appContext: false }), "c1", "docs", hold)),
    ).toEqual(["message"]);
    expect(
      Object.keys(speechOf(client({ appMessages: true, appContext: true }), "c1", "docs", hold)),
    ).toEqual(["message", "context"]);
  });

  it("holds a message under the call and the server of its record", async () => {
    const held: unknown[] = [];

    const speech = speechOf(
      client({ appMessages: true, appContext: false }),
      "c1",
      "docs",
      (chip) => {
        held.push(chip);

        return Promise.resolve("held");
      },
    );

    await expect(speech.message?.("Pick A")).resolves.toBe("held");
    expect(held).toEqual([{ callId: "c1", server: "docs", text: "Pick A" }]);
  });
});
