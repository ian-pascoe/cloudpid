// @effect-diagnostics nodeBuiltinImport:off -- runs on node, on the owner's machine.
import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotOf } from "./session.ts";
import { type DiskSession, makeSession } from "./stub.fixture.ts";

const sessions: Array<DiskSession> = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.cleanup();
});

const sessionOnDisk = () => {
  const session = makeSession();

  sessions.push(session);

  return session.manager;
};

describe("the Session as the import sends it", () => {
  it("is the header and the active branch, byte-identical to the file pi wrote", () => {
    const manager = sessionOnDisk();
    const file = manager.getSessionFile();
    const snapshot = snapshotOf(manager);

    expect(file).toBeDefined();
    expect(snapshot.file).toBe(file);
    expect(snapshot.text).toBe(readFileSync(file ?? "", "utf8"));
    expect(snapshot.name).toBe("Flaky test");
    expect(snapshot.entries).toBe(3);
    expect(snapshot.firstMessage).toBe("Fix the flaky test ✓ 日本語 🎉");
  });

  it("leaves out the entries of a branch that is not the active one", () => {
    const manager = sessionOnDisk();
    const [first] = manager.getEntries();

    manager.branch(first?.id ?? "");
    manager.appendMessage({ role: "user", content: "another way", timestamp: 3 });

    const snapshot = snapshotOf(manager);
    const lines = snapshot.text.trimEnd().split("\n");

    // The header, the first message, and the new one.
    expect(lines).toHaveLength(3);
    expect(snapshot.text).toContain("another way");
    expect(snapshot.text).not.toContain("On it.");
    // The file keeps every branch; the import takes one.
    expect(readFileSync(manager.getSessionFile() ?? "", "utf8")).toContain("On it.");
  });

  it("has no file for a Session pi keeps in memory", () => {
    expect(snapshotOf(SessionManager.inMemory("/tmp")).file).toBeUndefined();
  });

  it("finds the last cloudpid-import marker on the branch", () => {
    const manager = sessionOnDisk();

    manager.appendCustomEntry("cloudpid-import", {
      session: "a",
      url: "https://x.test/sessions/a",
      branch: "one",
      environment: "Default",
    });
    manager.appendCustomEntry("cloudpid-import", {
      session: "b",
      url: "https://x.test/sessions/b",
      branch: "two",
      environment: "Default",
    });
    manager.appendCustomEntry("other", { url: "https://x.test/nope" });

    expect(snapshotOf(manager).marker).toEqual({ url: "https://x.test/sessions/b", branch: "two" });
  });
});
