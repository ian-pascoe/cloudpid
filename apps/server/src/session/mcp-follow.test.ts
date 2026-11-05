import type { CursorState, WaitingRequest } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { cursorOf, endedBy, statusOf, type Snapshot, waitingMark } from "./mcp-follow.ts";
import type { FollowState } from "./mcp-reads.ts";

const state = (extra: Partial<FollowState> = {}): FollowState => ({
  conversationId: 1,
  activeBranch: 1,
  copying: false,
  idle: true,
  following: false,
  unsettled: false,
  newestEntry: 10,
  agents: {},
  ...extra,
});

const request = (since: number): WaitingRequest => ({
  kind: "approval",
  request_id: `r${String(since)}`,
  agent_id: "root",
  summary: "Change a setting",
  since,
  url: "/sessions/s?request=r",
});

const snapshot = (extra: Partial<FollowState> = {}, waiting: WaitingRequest[] = []): Snapshot => ({
  state: state(extra),
  waiting,
});

const cursor = (extra: Partial<CursorState> = {}): CursorState => ({
  c: 1,
  e: 10,
  w: 0,
  s: 0,
  ...extra,
});

describe("statusOf", () => {
  it("says what the Session is doing, a waiting request first", () => {
    expect(statusOf(snapshot())).toBe("idle");
    expect(statusOf(snapshot({ unsettled: true, idle: false }))).toBe("running");
    expect(statusOf(snapshot({ idle: false }))).toBe("background");
    expect(statusOf(snapshot({ unsettled: true, idle: false }, [request(5)]))).toBe(
      "waiting_for_owner",
    );
    expect(statusOf(snapshot({ copying: true }, [request(5)]))).toBe("importing");
  });
});

describe("cursorOf", () => {
  it("holds the conversation, the newest entry, the waiting mark and the newest settled input", () => {
    expect(
      cursorOf(snapshot({ newestSettled: { id: 7, status: "done" } }, [request(5), request(9)])),
    ).toEqual({ c: 1, e: 10, w: 9, s: 7 });
    expect(cursorOf(snapshot({ copying: true }))).toEqual({ c: 1, e: 10, w: 0, s: 0, i: true });
    expect(waitingMark([])).toBe(0);
  });
});

describe("endedBy with a cursor", () => {
  it("returns at once for a Run that ended after it, and not for one that ended before", () => {
    const ended = { newestSettled: { id: 8, status: "done" as const } };

    expect(endedBy(snapshot(ended), cursor({ s: 7 }))).toBe("run_ended");
    expect(endedBy(snapshot(ended), cursor({ s: 8 }))).toBeUndefined();
  });

  it("returns for a waiting request newer than the mark, never for one it has seen", () => {
    const busy = { unsettled: true, idle: false };

    expect(endedBy(snapshot(busy, [request(5)]), cursor({ w: 4 }))).toBe("owner_needed");
    expect(endedBy(snapshot(busy, [request(5)]), cursor({ w: 5 }))).toBeUndefined();
  });

  it("puts a Run that ended before a request that appeared", () => {
    expect(
      endedBy(
        snapshot({ newestSettled: { id: 8, status: "done" } }, [request(5)]),
        cursor({ s: 7 }),
      ),
    ).toBe("run_ended");
  });

  it("returns when an import that was going has ended", () => {
    expect(endedBy(snapshot(), cursor({ i: true }))).toBe("import_ended");
    expect(endedBy(snapshot({ copying: true }), cursor({ i: true }))).toBeUndefined();
  });

  it("keeps waiting on an idle Session with nothing new", () => {
    expect(
      endedBy(snapshot({ newestSettled: { id: 8, status: "done" } }), cursor({ s: 8 })),
    ).toBeUndefined();
  });
});

describe("endedBy without a cursor", () => {
  it("waits for a Run that is going with nothing waiting", () => {
    expect(endedBy(snapshot({ unsettled: true, idle: false }), undefined)).toBeUndefined();
  });

  it("returns at once for anything else", () => {
    expect(endedBy(snapshot({ unsettled: true, idle: false }, [request(5)]), undefined)).toBe(
      "owner_needed",
    );
    expect(endedBy(snapshot({ newestSettled: { id: 8, status: "done" } }), undefined)).toBe(
      "run_ended",
    );
    expect(endedBy(snapshot(), undefined)).toBe("timeout");
  });

  it("returns at once for an import that is going, which is no Run, and its cursor ends with the import", () => {
    const importing = snapshot({ copying: true });

    expect(endedBy(importing, undefined)).toBe("timeout");
    expect(cursorOf(importing).i).toBe(true);
    expect(endedBy(importing, cursorOf(importing))).toBeUndefined();
    expect(endedBy(snapshot(), cursorOf(importing))).toBe("import_ended");
  });
});
