// The Settings' Agent changes (docs/architecture/agent-changes.md), over an in-memory document table and Agent changes:
// applied as the owner's save is, recorded with the values before and after, and reverted unless changed since.
import { DEFAULT_OFFERED_TOOLS, DEFAULT_SETTINGS } from "@cloudpid/config";
import { type AgentChange, MAX_AGENT_CHANGES, SETTINGS_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, type AgentChanges, asRecorded } from "./agent-changes.ts";
import {
  changeSettings,
  type SettingsFieldChange,
  revertSettingsChange,
} from "./settings-changes.ts";
import { type DocumentStore, readSettings, SETTINGS_DOCUMENT } from "./settings.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "settings_model_set",
  reason: "The task is small",
};

/** An in-memory document table, as the Registry store's. */
const documents = (initial: Record<string, string> = {}) => {
  const text = new Map(Record.toEntries(initial));
  const writes: string[] = [];

  const store: DocumentStore = {
    getDocument: (name) => text.get(name) ?? null,
    putDocument: (name, body) => {
      writes.push(body);
      text.set(name, body);
    },
  };

  return { store, text, writes };
};

/**
 * Agent changes in memory: a revert marks the change it reverts, a dismissed change leaves the list, and a scope keeps
 * its newest `MAX_AGENT_CHANGES`.
 */
const memoryChanges = (): AgentChanges => {
  const rows: AgentChange[] = [];
  const dismissed = new Set<number>();

  const withReverts = (row: AgentChange): AgentChange => ({
    ...row,
    revertedBy: Option.getOrNull(
      Option.map(
        Arr.findFirst(rows, (other) => other.reverts === row.id),
        (revert) => revert.id,
      ),
    ),
  });

  return {
    record: (change) => {
      const recorded = asRecorded(change, rows.length + 1);

      rows.push(recorded);

      return recorded;
    },
    list: (scope) =>
      Arr.take(
        Arr.reverse(
          Arr.map(
            Arr.filter(rows, (row) => row.scope === scope && !dismissed.has(row.id)),
            withReverts,
          ),
        ),
        MAX_AGENT_CHANGES,
      ),
    get: (scope, id) =>
      Option.getOrNull(
        Option.map(
          Arr.findFirst(rows, (row) => row.scope === scope && row.id === id),
          withReverts,
        ),
      ),
    dismiss: (scope, id) => {
      const known = Arr.some(rows, (row) => row.scope === scope && row.id === id);

      if (known) dismissed.add(id);

      return known;
    },
  };
};

const inRegistry = (initial: Record<string, string> = {}) => {
  const docs = documents(initial);
  const changes = memoryChanges();
  const storage = { transactionSync: <A>(body: () => A) => body() };

  return {
    ...docs,
    changes,
    change: (list: ReadonlyArray<SettingsFieldChange>, at = 1_000) =>
      changeSettings(storage, docs.store, changes, { changes: list, author }, at),
    revert: (id: number, at = 2_000) =>
      revertSettingsChange(storage, docs.store, changes, { id }, at),
    saved: () => readSettings(docs.store),
  };
};

const set = (field: string, value: SettingsFieldChange["value"]): SettingsFieldChange => ({
  field,
  value,
});

describe("an Agent change to the Settings", () => {
  it("saves the setting as the owner's save does, keeping only what differs from the defaults", () => {
    const registry = inRegistry();
    const outcome = registry.change([set("model", "anthropic/claude-sonnet-5-5")]);

    expect(outcome).toMatchObject({ status: "changed" });
    expect(registry.saved()).toMatchObject({
      settings: { model: "anthropic/claude-sonnet-5-5" },
      overrides: { model: "anthropic/claude-sonnet-5-5" },
    });
    expect(JSON.parse(registry.text.get(SETTINGS_DOCUMENT) ?? "")).toEqual({
      model: "anthropic/claude-sonnet-5-5",
    });
  });

  it("records who changed it, why, and the values before and after, in the Settings' scope", () => {
    const registry = inRegistry();

    registry.change([set("thinkingLevel", "low")]);

    expect(registry.changes.list(SETTINGS_SCOPE)).toEqual([
      {
        id: 1,
        scope: SETTINGS_SCOPE,
        at: 1_000,
        actor: "agent",
        session: "s-1",
        conversation: 1,
        tool: "settings_model_set",
        reason: "The task is small",
        field: "thinkingLevel",
        before: "high",
        after: "low",
        reverts: null,
        revertedBy: null,
      },
    ]);
  });

  it("keeps the other overrides as they were", () => {
    const registry = inRegistry({
      [SETTINGS_DOCUMENT]: '{"compaction":{"enabled":false},"thinkingLevel":"low"}',
    });

    registry.change([set("model", "anthropic/claude-haiku-5-5")]);

    expect(registry.saved().overrides).toEqual({
      model: "anthropic/claude-haiku-5-5",
      compaction: { enabled: false },
      thinkingLevel: "low",
    });
  });

  it("makes several fields one write, and records each field that changed", () => {
    const registry = inRegistry();

    const outcome = registry.change([
      set("model", "anthropic/claude-haiku-5-5"),
      set("thinkingLevel", "high"),
      set("thinkingLevel", "high"),
    ]);

    expect(outcome.status).toBe("changed");
    expect(registry.writes).toHaveLength(1);

    // `thinkingLevel` already had the value: only the model is a change.
    expect(Arr.map(registry.changes.list(SETTINGS_SCOPE), (change) => change.field)).toEqual([
      "model",
    ]);

    if (outcome.status === "changed") {
      expect(Arr.map(outcome.changes, (change) => change.field)).toEqual(["model"]);
    }
  });

  it("says nothing changed, and records and writes nothing, for a value the setting has", () => {
    const registry = inRegistry();

    expect(registry.change([set("thinkingLevel", "high")])).toEqual({ status: "unchanged" });
    expect(registry.changes.list(SETTINGS_SCOPE)).toEqual([]);
    expect(registry.writes).toEqual([]);
  });

  it("refuses a value the settings do not take, as the owner's save does, and saves and records nothing", () => {
    const registry = inRegistry();

    const outcome = registry.change([
      set("model", "anthropic/claude-gpt-9"),
      set("compaction.reserveTokens", -1),
    ]);

    expect(outcome.status).toBe("rejected");

    if (outcome.status === "rejected") {
      expect(outcome.message).toContain("model:");
      expect(outcome.message).toContain("compaction.reserveTokens:");
    }

    expect(registry.changes.list(SETTINGS_SCOPE)).toEqual([]);
    expect(registry.writes).toEqual([]);
  });

  it("refuses a field that is not a setting", () => {
    const registry = inRegistry();

    expect(registry.change([set("bogus", 1)])).toEqual({
      status: "rejected",
      message: "bogus: not a setting",
    });
    expect(registry.change([set("extensions.web", 1)])).toEqual({
      status: "rejected",
      message: "extensions.web: not a setting",
    });
  });

  it("sets and takes away one option of an extension", () => {
    const registry = inRegistry();

    registry.change([set("extensions.web.searchProvider", "exa")]);
    expect(registry.saved().settings.extensions).toEqual({ web: { searchProvider: "exa" } });

    registry.change([set("extensions.web.searchProvider", null)], 1_500);
    expect(registry.saved().settings.extensions).toEqual({});
    expect(registry.saved().overrides).toEqual({});

    expect(
      Arr.map(registry.changes.list(SETTINGS_SCOPE), (change) => [change.before, change.after]),
    ).toEqual([
      ["exa", null],
      [null, "exa"],
    ]);
  });

  it("changes the offered tools as a list", () => {
    const registry = inRegistry();

    registry.change([set("tools.offered", [...DEFAULT_OFFERED_TOOLS, "web_fetch"])]);

    expect(registry.saved().settings.tools.offered).toEqual([
      ...DEFAULT_OFFERED_TOOLS,
      "web_fetch",
    ]);
    expect(registry.changes.list(SETTINGS_SCOPE)[0]).toMatchObject({
      field: "tools.offered",
      before: DEFAULT_OFFERED_TOOLS,
      after: [...DEFAULT_OFFERED_TOOLS, "web_fetch"],
    });
  });

  it("forgets saved overrides that no longer apply, saying which, since the write keeps what resolves", () => {
    const registry = inRegistry({
      [SETTINGS_DOCUMENT]:
        '{"roles":{"large":{"model":"anthropic/retired-model"}},"thinkingLevel":"low"}',
    });

    const outcome = registry.change([set("model", "anthropic/claude-haiku-5-5")]);

    expect(outcome).toMatchObject({ status: "changed" });

    if (outcome.status === "changed") {
      expect(outcome.dropped).toContain("roles.large.model");
    }

    expect(registry.saved()).toEqual({
      settings: expect.objectContaining({ thinkingLevel: "low" }),
      overrides: { model: "anthropic/claude-haiku-5-5", thinkingLevel: "low" },
    });
  });

  it("does not pretend to have anything to forget when the overrides all apply", () => {
    const outcome = inRegistry().change([set("model", "anthropic/claude-haiku-5-5")]);

    expect(outcome).toMatchObject({ status: "changed" });
    expect(outcome).not.toHaveProperty("dropped");
  });
});

describe("the owner's revert of a Settings change", () => {
  it("writes the value before back and records that as the owner's change", () => {
    const registry = inRegistry();

    registry.change([set("model", "anthropic/claude-haiku-5-5")]);

    const outcome = registry.revert(1);

    expect(outcome).toMatchObject({
      status: "reverted",
      change: {
        id: 2,
        scope: SETTINGS_SCOPE,
        actor: "owner",
        session: null,
        tool: null,
        field: "model",
        before: "anthropic/claude-haiku-5-5",
        after: DEFAULT_SETTINGS.model,
        reverts: 1,
      },
    });
    // The default again: nothing is kept, so it follows later default changes.
    expect(registry.saved().overrides).toEqual({});
    expect(registry.changes.get(SETTINGS_SCOPE, 1)?.revertedBy).toBe(2);
  });

  it("takes an option away that the change added", () => {
    const registry = inRegistry();

    registry.change([set("extensions.web.searchProvider", "exa")]);
    registry.revert(1);

    expect(registry.saved().overrides).toEqual({});
  });

  it("is refused, saying what the setting is now, when it has changed since", () => {
    const registry = inRegistry();

    registry.change([set("model", "anthropic/claude-haiku-5-5")]);
    registry.change([set("model", "anthropic/claude-sonnet-5-5")], 1_500);

    expect(registry.revert(1)).toEqual({
      status: "changed-since",
      field: "model",
      current: "anthropic/claude-sonnet-5-5",
    });
    expect(registry.saved().settings.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("is refused for a revert, and for a change reverted already", () => {
    const registry = inRegistry();

    registry.change([set("thinkingLevel", "low")]);
    registry.revert(1);

    expect(registry.revert(2)).toMatchObject({ status: "refused" });
    expect(registry.revert(1)).toMatchObject({ status: "refused" });
  });

  it("says a change that is not there is missing, and reverts one of the Settings only", () => {
    const registry = inRegistry();

    registry.changes.record({
      scope: "default",
      at: 1,
      actor: "agent",
      session: "s-1",
      conversation: 1,
      tool: "environment_variable_set",
      reason: "r",
      field: "variables.A",
      before: null,
      after: "1",
      reverts: null,
    });

    expect(registry.revert(9)).toEqual({ status: "missing" });
    // Change 1 is an Environment's.
    expect(registry.revert(1)).toEqual({ status: "missing" });
  });
});

describe("a change to a Limit the owner approved", () => {
  const approved: AgentChangeAuthor = {
    session: "s-1",
    conversation: 1,
    tool: "settings_spend_limit_set",
    reason: "The refactor needs more requests",
    approved: true,
  };

  const raise = (registry: ReturnType<typeof inRegistry>, expected: SettingsFieldChange["value"]) =>
    changeSettings(
      { transactionSync: (body) => body() },
      registry.store,
      registry.changes,
      {
        changes: [{ field: "spendLimit.perSession", value: 10, expected: { value: expected } }],
        author: approved,
      },
      1_000,
    );

  it("is made while the setting has the value the owner saw, and recorded as approved", () => {
    const registry = inRegistry({ [SETTINGS_DOCUMENT]: '{"spendLimit":{"perSession":5}}' });

    expect(raise(registry, 5)).toMatchObject({
      status: "changed",
      changes: [{ field: "spendLimit.perSession", before: 5, after: 10, approved: true }],
    });
    expect(registry.saved().settings.spendLimit.perSession).toBe(10);
  });

  it("is not made when the owner changed the setting since they were asked", () => {
    const registry = inRegistry({ [SETTINGS_DOCUMENT]: '{"spendLimit":{"perSession":7}}' });

    expect(raise(registry, 5)).toEqual({
      status: "changed-since",
      field: "spendLimit.perSession",
      current: 7,
    });
    expect(registry.saved().settings.spendLimit.perSession).toBe(7);
    expect(registry.changes.list(SETTINGS_SCOPE)).toEqual([]);
  });
});
