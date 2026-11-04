// docs/architecture/mcp-apps.md → App messages and App context. The chips above the composer's input: each App message with where
// it came from, and Edit and Discard.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppMessageChips,
  chipSource,
  SHOWN_CHARS,
  withEditedMessage,
} from "./app-message-chips.tsx";
import type { AttachmentsState } from "./attachments-state.ts";

const state = (apps: AttachmentsState["apps"]): AttachmentsState => ({
  items: [],
  pages: [],
  resources: [],
  apps,
  fits: new Map(),
  fitted: "",
});

const render = (apps: AttachmentsState["apps"]) =>
  renderToStaticMarkup(
    <AppMessageChips state={state(apps)} onEdit={() => {}} onDiscard={() => {}} />,
  );

describe("the composer's App message chips", () => {
  it("shows nothing when the composer holds none", () => {
    expect(render([])).toBe("");
  });

  it("shows each message with the app it came from, above the input, with Edit and Discard", () => {
    const html = render([
      { callId: "c1", server: "docs", text: "Pick A" },
      { callId: "c2", server: "maps", text: "Zoom in" },
    ]);

    expect(html).toContain('aria-label="App messages"');
    expect(html).toContain("Pick A");
    expect(html).toContain("From the docs app");
    expect(html).toContain("From the maps app");
    expect(html).toContain('aria-label="Edit the message from the docs app"');
    expect(html).toContain('aria-label="Discard the message from the maps app"');
    expect(html.match(/>Edit</g)).toHaveLength(2);
    expect(html.match(/>Discard</g)).toHaveLength(2);
  });

  it("says only 'an app' for a call whose record was gone", () => {
    expect(chipSource({ callId: "c1", server: "", text: "x" })).toBe("From an app");
  });

  it("shows one cut line and keeps the whole text as its tooltip", () => {
    expect(render([{ callId: "c1", server: "docs", text: "a\n\n  b   c" }])).toContain(">a b c<");
    expect(render([{ callId: "c1", server: "docs", text: "x".repeat(500) }])).toContain(
      `>${"x".repeat(SHOWN_CHARS - 1)}…<`,
    );

    const long = "word ".repeat(100).trim();

    expect(render([{ callId: "c1", server: "docs", text: long }])).toContain(`title="${long}"`);
  });
});

describe("Edit", () => {
  it("puts the message's text in the input, after what is typed", () => {
    expect(withEditedMessage("", "Pick A")).toBe("Pick A");
    expect(withEditedMessage("  ", "Pick A")).toBe("Pick A");
    expect(withEditedMessage("Do this:", "Pick A")).toBe("Do this:\n\nPick A");
  });
});
