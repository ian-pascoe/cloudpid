import { describe, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES } from "./webpush.ts";
import { describeEvent } from "./notification.ts";

const session = { id: "0190f3a0-1111-7000-8000-000000000001", title: "Fix the build" };

describe("describeEvent", () => {
  it("says a Run finished, linking to the Session's page", () => {
    expect(describeEvent({ kind: "finished" }, session)).toEqual({
      title: "Fix the build",
      body: "Run finished",
      url: "/sessions/0190f3a0-1111-7000-8000-000000000001",
      tag: "0190f3a0-1111-7000-8000-000000000001:finished",
    });
  });

  it("says why a Run failed, on one line cut to fit a lock screen", () => {
    const { body } = describeEvent(
      { kind: "failed", reason: `overloaded\n${"x".repeat(400)}` },
      session,
    );

    expect(body.startsWith("Run failed: overloaded xxx")).toBe(true);
    expect(body).toHaveLength(140);
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toContain("\n");
  });

  it("says a Run failed when there is no reason", () => {
    expect(describeEvent({ kind: "failed" }, session).body).toBe("Run failed");
    expect(describeEvent({ kind: "failed", reason: "  " }, session).body).toBe("Run failed");
  });

  it("names the Secrets a request asks for, never a value", () => {
    expect(
      describeEvent(
        { kind: "input", names: ["GH_TOKEN", "NPM_TOKEN"], reason: "to publish" },
        session,
      ),
    ).toMatchObject({
      body: "Needs input: GH_TOKEN, NPM_TOKEN (to publish)",
      tag: "0190f3a0-1111-7000-8000-000000000001:input",
    });
  });

  it("names the change an Approval request waits on", () => {
    expect(
      describeEvent(
        {
          kind: "input",
          names: [],
          approval: "Spend limit per Session: $5 → $10",
          reason: "the refactor needs more requests",
        },
        session,
      ),
    ).toMatchObject({
      body: "Approval needed: Spend limit per Session: $5 → $10 (the refactor needs more requests)",
      tag: "0190f3a0-1111-7000-8000-000000000001:input",
    });
  });

  it("carries a notice a caller words, to the page it names", () => {
    expect(
      describeEvent(
        {
          kind: "notice",
          title: "Browser needs you",
          body: "Sign in to continue",
          url: "https://live.example/x",
        },
        session,
      ),
    ).toMatchObject({
      title: "Browser needs you",
      body: "Sign in to continue",
      url: "https://live.example/x",
    });
    expect(describeEvent({ kind: "notice", body: "Hi" }, session)).toMatchObject({
      title: "Fix the build",
      url: "/sessions/0190f3a0-1111-7000-8000-000000000001",
    });
  });

  it("opens the Session's page with a notice's query, such as a Browser Handoff's Live View Pane", () => {
    expect(
      describeEvent({ kind: "notice", body: "Needs you", url: "?pane=live-view:7" }, session).url,
    ).toBe("/sessions/0190f3a0-1111-7000-8000-000000000001?pane=live-view:7");
  });

  it("opens the Session's page when a notice's link is too long or not a plain URL", () => {
    const page = "/sessions/0190f3a0-1111-7000-8000-000000000001";

    for (const url of [
      `https://live.example/${"a".repeat(1100)}`,
      "https://live.example/é",
      "https://a b",
    ]) {
      expect(describeEvent({ kind: "notice", body: "Hi", url }, session).url).toBe(page);
    }

    expect(
      describeEvent(
        { kind: "notice", body: "Hi", url: `https://live.example/${"a".repeat(900)}` },
        session,
      ).url,
    ).toHaveLength(921);
  });

  it("keeps the worst case under one push message", () => {
    const awful = describeEvent(
      {
        kind: "notice",
        title: "𝒯".repeat(500),
        body: "𝒯".repeat(500),
        url: `https://live.example/${'"'.repeat(1000)}`,
      },
      { id: "0190f3a0-1111-7000-8000-000000000001", title: "t" },
    );

    expect(new TextEncoder().encode(JSON.stringify(awful)).length).toBeLessThan(MAX_PAYLOAD_BYTES);

    const query = describeEvent(
      {
        kind: "notice",
        title: "𝒯".repeat(500),
        body: "𝒯".repeat(500),
        url: `?${"a".repeat(1023)}`,
      },
      { id: "0190f3a0-1111-7000-8000-000000000001", title: "t" },
    );

    expect(new TextEncoder().encode(JSON.stringify(query)).length).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it("titles an untitled Session plainly and bounds a long title", () => {
    expect(describeEvent({ kind: "finished" }, { ...session, title: null }).title).toBe("Session");
    expect(
      describeEvent({ kind: "finished" }, { ...session, title: "t".repeat(300) }).title,
    ).toHaveLength(80);
  });
});
