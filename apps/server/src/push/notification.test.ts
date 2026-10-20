import { describe, expect, it } from "vitest";
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

  it("titles an untitled Session plainly and bounds a long title", () => {
    expect(describeEvent({ kind: "finished" }, { ...session, title: null }).title).toBe("Session");
    expect(
      describeEvent({ kind: "finished" }, { ...session, title: "t".repeat(300) }).title,
    ).toHaveLength(80);
  });
});
