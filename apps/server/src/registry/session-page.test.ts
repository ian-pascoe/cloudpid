import type { SessionRecord } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { pageSessions, type SessionsPage } from "./session-page.ts";

const session = (index: number, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id: `s-${String(index).padStart(3, "0")}`,
  title: `Task ${String(index)}`,
  titleSource: "owner",
  environment: "default",
  workspace: `w-${String(index)}`,
  status: "idle",
  createdAt: index,
  updatedAt: index,
  archivedAt: null,
  ...extra,
});

/** Newest first, as `listSessions` answers. */
const list = (count: number, extra: (index: number) => Partial<SessionRecord> = () => ({})) =>
  Arr.makeBy(count, (offset) => session(count - offset, extra(count - offset)));

const ids = (page: ReturnType<typeof pageSessions>): string[] =>
  "sessions" in page ? Arr.map(page.sessions, (each) => each.id) : [];

const isPage = (page: ReturnType<typeof pageSessions>): SessionsPage => {
  if (!("sessions" in page)) throw new Error("Refused");

  return page;
};

/** The cursor to the page after `page`. */
const next = (page: SessionsPage): string => {
  if (page.nextCursor === undefined) throw new Error("No next page");

  return page.nextCursor;
};

describe("pageSessions", () => {
  it("pages newest first, 20 by default, with a cursor to the rest", () => {
    const all = list(45);
    const first = isPage(pageSessions(all, {}));

    expect(first.sessions).toHaveLength(20);
    expect(first.sessions[0]?.id).toBe("s-045");
    expect(first.nextCursor).toBeDefined();

    const second = isPage(pageSessions(all, { cursor: next(first) }));
    const third = isPage(pageSessions(all, { cursor: next(second) }));

    expect(second.sessions[0]?.id).toBe("s-025");
    expect(third.sessions).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
    expect(
      Arr.map([...first.sessions, ...second.sessions, ...third.sessions], (each) => each.id),
    ).toEqual(ids({ sessions: all }));
  });

  it("holds the limit to 50, and to at least one", () => {
    expect(ids(pageSessions(list(80), { limit: 500 }))).toHaveLength(50);
    expect(ids(pageSessions(list(3), { limit: 0 }))).toHaveLength(1);
  });

  it("keeps a page that ends exactly at the end free of a cursor", () => {
    expect(isPage(pageSessions(list(20), {})).nextCursor).toBeUndefined();
  });

  it("filters by Environment, status, archive flag and title", () => {
    const all = list(8, (index) => ({
      environment: index % 2 === 0 ? "a" : "b",
      status: index % 3 === 0 ? "running" : "idle",
      archivedAt: index === 8 ? 5 : null,
      title: index === 6 ? "Fix the BUILD" : `Task ${String(index)}`,
    }));

    expect(ids(pageSessions(all, { environment: "a" }))).toEqual(["s-006", "s-004", "s-002"]);
    expect(ids(pageSessions(all, { status: "running" }))).toEqual(["s-006", "s-003"]);
    expect(ids(pageSessions(all, { archived: true }))).toEqual(["s-008"]);
    expect(ids(pageSessions(all, { archived: false }))).not.toContain("s-008");
    expect(ids(pageSessions(all, { query: "build" }))).toEqual(["s-006"]);
    expect(ids(pageSessions(all, { query: "  Task 7 " }))).toEqual(["s-007"]);
  });

  it("pages within a filter, whatever the filter hides", () => {
    const all = list(60, (index) => ({ environment: index % 2 === 0 ? "a" : "b" }));
    const first = isPage(pageSessions(all, { environment: "a", limit: 10 }));
    const second = isPage(pageSessions(all, { environment: "a", limit: 10, cursor: next(first) }));

    expect(Arr.map(second.sessions, (each) => each.environment)).toEqual(Arr.replicate("a", 10));
    expect(second.sessions[0]?.createdAt).toBeLessThan(first.sessions.at(-1)?.createdAt ?? 0);
  });

  it("refuses what is not a cursor", () => {
    for (const cursor of ["", "!!", "e30", btoa("nope")]) {
      expect(pageSessions(list(3), { cursor })).toEqual({ refused: "invalid_cursor" });
    }
  });
});
