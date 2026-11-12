// docs/architecture/mcp-apps.md → App messages and App context: the chip of the last context a View told the model.
// @effect-diagnostics asyncFunction:off preferEffectRecord:off -- promises a speech handler answers, and the keys of the speech a card offers.
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { AppContextChip, SHOWN_CHARS } from "./app-context-chip.tsx";
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
    expect(
      renderToStaticMarkup(
        <AppContextChip context={{ hash: "h", text: "x".repeat(400), at: 1 }} />,
      ),
    ).toContain(`>${"x".repeat(SHOWN_CHARS - 1)}…<`);
  });
});

describe("what a card lets its View say", () => {
  const client = (takes: { appMessages: boolean; appContext: boolean }) => ({
    takes: () => takes,
    appContext: () => Effect.die("not used"),
  });

  const nowhere = () => undefined;

  it("offers a message and a context only as far as the Session on the connection takes them", () => {
    const hold = () => Promise.resolve("held" as const);

    expect(speechOf(undefined, "c1", "docs", hold, nowhere)).toEqual({});
    expect(
      Object.keys(
        speechOf(client({ appMessages: false, appContext: false }), "c1", "docs", hold, nowhere),
      ),
    ).toEqual([]);
    expect(
      Object.keys(
        speechOf(client({ appMessages: true, appContext: false }), "c1", "docs", hold, nowhere),
      ),
    ).toEqual(["message"]);
    expect(
      Object.keys(
        speechOf(client({ appMessages: true, appContext: true }), "c1", "docs", hold, nowhere),
      ),
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
      nowhere,
    );

    await expect(speech.message?.("Pick A")).resolves.toBe("held");
    expect(held).toEqual([{ callId: "c1", server: "docs", text: "Pick A" }]);
  });

  it("sends a context with the conversation its View is shown in when it is sent, not when the card rendered", async () => {
    const asked: unknown[] = [];
    let shown: number | undefined = 1;

    const speech = speechOf(
      {
        takes: () => ({ appMessages: false, appContext: true }),
        appContext: (callId, text, conversationId) => {
          asked.push([callId, text, conversationId]);

          return Effect.succeed({ status: "held" as const });
        },
      },
      "c1",
      "docs",
      () => Promise.resolve("held"),
      () => shown,
    );

    await speech.context?.("one");
    shown = 7;
    await speech.context?.("two");
    expect(asked).toEqual([
      ["c1", "one", 1],
      ["c1", "two", 7],
    ]);
  });
});
