import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AgentChange, agentChangeViaLabel, ForkKind, SessionRecord } from "./registry.ts";
import { userEntryData, USER_ENTRY_KIND } from "./user-entry.ts";

/** `SessionRecord` as a bundle from before the MCP marks decodes it: a Session's origin is a Fork or Clone's alone. */
const OldSessionRecord = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  titleSource: Schema.NullOr(Schema.Literals(["owner", "generated"])),
  environment: Schema.String,
  workspace: Schema.String,
  status: Schema.Literals(["idle", "running"]),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  archivedAt: Schema.NullOr(Schema.Finite),
  origin: Schema.optionalKey(Schema.Struct({ session: Schema.String, kind: ForkKind })),
});

const record = {
  id: "s-1",
  title: null,
  titleSource: null,
  environment: "default",
  workspace: "w",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
} as const;

const decodeOld = (input: Schema.Json) =>
  Effect.runSync(Schema.decodeUnknownEffect(OldSessionRecord)(input));

const decodeNew = (input: Schema.Json) =>
  Effect.runSync(Schema.decodeUnknownEffect(SessionRecord)(input));

describe("SessionRecord", () => {
  it("keeps `origin` to Forks and Clones, and carries the endpoint's marks apart from it", () => {
    const started = {
      ...record,
      marks: { kind: "mcp", auth: "oauth", client: { name: "claude-code" } },
    };

    const forked = { ...record, origin: { session: "s-0", kind: "fork" } };

    expect(decodeNew(started)).toEqual(started);
    expect(decodeNew(forked)).toEqual(forked);
  });

  it("is still read, whole, by a bundle that does not know the marks", () => {
    const started = { ...record, marks: { kind: "import", auth: "service_token" } };
    const forked = { ...record, id: "s-2", origin: { session: "s-0", kind: "clone" } };

    expect(decodeOld(started)).toEqual(record);
    expect(decodeOld(forked)).toEqual(forked);
    // A list of both decodes as a list.
    expect(
      Effect.runSync(Schema.decodeUnknownEffect(Schema.Array(OldSessionRecord))([started, forked])),
    ).toHaveLength(2);
  });

  it("reads a mark with a way in or a kind this version does not know", () => {
    expect(decodeNew({ ...record, marks: { kind: "later", auth: "later" } }).marks).toEqual({
      kind: "unknown",
      auth: "unknown",
    });
  });
});

describe("an Agent change's `via`", () => {
  const change = {
    id: 41,
    scope: "default",
    at: 1,
    actor: "agent",
    session: null,
    conversation: null,
    tool: "environment_variable_set",
    reason: "Needed",
    field: "variables.API_URL",
    before: null,
    after: "https://example.test",
    reverts: null,
    revertedBy: null,
  } as const;

  const decode = (input: Schema.Json) =>
    Effect.runSync(Schema.decodeUnknownEffect(AgentChange)(input));

  it("is kept without the client id", () => {
    const via = { client: { name: "pi", version: "1.5.0" }, auth: "oauth" };

    expect(decode({ ...change, via: { ...via, clientId: "abc" } }).via).toEqual(via);
  });

  it("is absent on a change from before it, and on one whose via cannot be read", () => {
    expect(decode(change)).toEqual(change);
    expect(decode({ ...change, via: "nope" })).toEqual(change);
  });

  it("reads an auth it does not know as unknown", () => {
    expect(decode({ ...change, via: { auth: "later" } }).via).toEqual({ auth: "unknown" });
  });

  it("is worded as the byline and the notice say it", () => {
    expect(agentChangeViaLabel({ client: { name: "pi" } })).toBe("Changed over MCP · pi");
    expect(agentChangeViaLabel({})).toBe("Changed over MCP");
  });
});

describe("a user entry's `via`", () => {
  const entry = (via: Schema.Json) => ({
    kind: USER_ENTRY_KIND,
    data: { display: "hi", skills: [], via },
  });

  it("reads an auth it does not know as unknown, and a mark it cannot read as none, leaving the entry", () => {
    expect(userEntryData(entry({ auth: "later" }))?.via).toEqual({ auth: "unknown" });
    expect(userEntryData(entry({ nonsense: true }))).toEqual({ display: "hi", skills: [] });
    expect(userEntryData(entry("nope"))?.display).toBe("hi");
  });
});
