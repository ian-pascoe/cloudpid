// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live). What an App call's card says of a
// View that is not live, from the Session's state as the atoms hold it: an older generation's View is a collapsed row with
// Reopen, a record that was evicted or a tool that is no App's any more says so, and a `codemode` script's App calls are
// listed in a strip under its card. Rendered on the server: a place claims its call after it mounts, so what shows here is
// what each says before any View is mounted, which is all a collapsed card says.
// @effect-diagnostics preferEffectArray:off -- a transcript in native lists.
import type { McpAppEntry, McpAppTool, SessionView, TranscriptMessage } from "@cloudpid/protocol";
import { EMPTY_VIEW } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "vitest";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { ShownSession } from "../chat/conversation.ts";
import { ToolCallCard } from "../chat/parts.tsx";
import { appChoiceAtom } from "../session-layout-state.ts";
import { sessionStateAtom } from "../session/atoms.ts";
import { INITIAL_SESSION_STATE } from "../session/state.ts";
import { AppCall } from "./app-call.tsx";
import { AppPane } from "./app-pane.tsx";

const TOOL: McpAppTool = {
  name: "mcp__docs__page",
  server: "docs",
  tool: "page",
  uri: "ui://docs/page",
  visibility: ["model", "app"],
};

const assistant = (id: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  timestamp: 0,
  parts: calls.map((call) => ({
    type: "tool-call",
    id: call,
    name: "mcp__docs__page",
    arguments: {},
  })),
});

const entry = (callId: string, more: Partial<McpAppEntry> = {}): McpAppEntry => ({
  callId,
  server: "docs",
  tool: "page",
  state: "kept",
  at: 1,
  ...more,
});

/** A registry holding Session `s1` as it is with `messages`, App `tools` and App `entries` of its root conversation. */
const registryWith = (
  messages: TranscriptMessage[],
  entries: McpAppEntry[],
  tools: McpAppTool[] | null = [TOOL],
) => {
  const view: SessionView = { ...EMPTY_VIEW, messages };

  return AtomRegistry.make({
    initialValues: [
      Atom.initialValue(sessionStateAtom("s1"), {
        ...INITIAL_SESSION_STATE,
        view,
        mcpAppTools: tools,
        mcpApps: { "1": entries },
      }),
    ],
  });
};

const markup = (registry: AtomRegistry.AtomRegistry, node: React.ReactNode): string => {
  const html = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <ShownSession.Provider value="s1">{node}</ShownSession.Provider>
    </RegistryContext.Provider>,
  );

  registry.dispose();

  return html.replaceAll(/<[^>]*>/g, " ").replaceAll(/\s+/g, " ");
};

describe("an App call's card, before its View is mounted", () => {
  it("collapses an older generation's View to a row with Reopen", () => {
    const registry = registryWith(
      [assistant("1", "old"), assistant("2", "new")],
      [entry("old"), entry("new", { at: 2 })],
    );

    expect(markup(registry, <AppCall callId="old" toolName="mcp__docs__page" />)).toContain(
      "App · docs collapsed Reopen",
    );
  });

  it("leaves the newest generation's View to be mounted: no row", () => {
    const registry = registryWith(
      [assistant("1", "old"), assistant("2", "new")],
      [entry("old"), entry("new", { at: 2 })],
    );

    expect(markup(registry, <AppCall callId="new" toolName="mcp__docs__page" />)).toBe("");
  });

  it("is live again once the owner reopened it, on this device, and collapsed once they collapsed the newest", () => {
    const messages = [assistant("1", "old"), assistant("2", "new")];
    const entries = [entry("old"), entry("new", { at: 2 })];
    const reopened = registryWith(messages, entries);

    reopened.set(appChoiceAtom("s1", "old"), "open");
    expect(markup(reopened, <AppCall callId="old" toolName="mcp__docs__page" />)).toBe("");

    const collapsed = registryWith(messages, entries);

    collapsed.set(appChoiceAtom("s1", "new"), "collapsed");
    expect(markup(collapsed, <AppCall callId="new" toolName="mcp__docs__page" />)).toContain(
      "collapsed Reopen",
    );
  });

  it("says a record that was evicted is no longer kept, and a tool that is no App's any more is unavailable", () => {
    const evicted = registryWith([assistant("1", "a")], [entry("a", { state: "evicted" })]);

    expect(markup(evicted, <AppCall callId="a" toolName="mcp__docs__page" />)).toContain(
      "App data no longer kept",
    );

    const gone = registryWith([assistant("1", "a")], [entry("a")], []);

    expect(markup(gone, <AppCall callId="a" toolName="mcp__docs__page" />)).toContain(
      "App unavailable",
    );
  });

  it("adds nothing for a call that is no App's", () => {
    const registry = registryWith([assistant("1", "plain")], []);

    expect(markup(registry, <AppCall callId="plain" toolName="mcp__other__thing" />)).toBe("");
  });
});

describe("a codemode script's card", () => {
  const card = (registry: AtomRegistry.AtomRegistry) =>
    markup(
      registry,
      <ToolCallCard
        type="tool-call"
        toolCallId="script"
        toolName="codemode"
        args={{}}
        argsText="{}"
        result="done"
        artifact={{ nested: [] }}
        status={{ type: "complete" }}
        addResult={() => undefined}
        resume={() => undefined}
        respondToApproval={() => Promise.resolve()}
      />,
    );

  it("lists the App calls the script made in a strip, an older generation's collapsed with Reopen", () => {
    const registry = registryWith(
      [assistant("1", "script"), assistant("2", "later")],
      [
        entry("n1", { parentCall: "script" }),
        entry("n2", { parentCall: "script", at: 2 }),
        entry("later", { at: 3 }),
      ],
    );

    const html = card(registry);

    expect(html.match(/collapsed Reopen/g)).toHaveLength(2);
  });

  it("shows every call of a script as a row, the live one wherever it is, and counts the earlier rows of one that made very many", () => {
    // 30 calls to `docs`, and one to `maps` first: the last `docs` call and the `maps` call are live, in the newest message.
    const calls = Array.from({ length: 30 }, (_, n) =>
      entry(`n${n}`, { parentCall: "script", at: n + 2 }),
    );

    const registry = registryWith(
      [assistant("1", "script")],
      [entry("first", { parentCall: "script", server: "maps", at: 1 }), ...calls],
    );

    const html = card(registry);

    // 31 calls: the last 20 rows, and `first` which is live, with 10 earlier behind the button.
    expect(html).toContain("10 earlier");
    // Live Views mount after the claim, so a server render has the collapsed rows of the others: 19 of the last 20.
    expect(html.match(/collapsed Reopen/g)).toHaveLength(19);
  });

  it("keeps a row the owner reopened among the shown ones, however early it is", () => {
    const calls = Array.from({ length: 30 }, (_, n) =>
      entry(`n${n}`, { parentCall: "script", at: n + 1 }),
    );

    const registry = registryWith([assistant("1", "script")], calls);

    registry.set(appChoiceAtom("s1", "n0"), "open");

    // 20 last rows and the reopened one: 9 earlier remain; the reopened row is live (no row), the others collapsed.
    const html = card(registry);

    expect(html).toContain("9 earlier");
    expect(html.match(/collapsed Reopen/g)).toHaveLength(19);
  });

  it("shows no strip for a script that made no App call", () => {
    const registry = registryWith([assistant("1", "script")], []);

    expect(card(registry)).not.toContain("collapsed");
  });
});

describe("an App Pane that cannot mount its View", () => {
  const pane = (registry: AtomRegistry.AtomRegistry, callId: string) =>
    markup(registry, <AppPane argument={callId} close={() => undefined} />);

  it("says so when its call is not among the Session's App calls", () => {
    expect(pane(registryWith([], []), "gone")).toContain("This App is not in this Session.");
  });

  it("says its record is no longer kept, or that the App is unavailable, and mounts nothing", () => {
    const evicted = registryWith([assistant("1", "a")], [entry("a", { state: "evicted" })]);

    expect(pane(evicted, "a")).toContain("App data no longer kept");
    expect(pane(registryWith([assistant("1", "a")], [entry("a")], []), "a")).toContain(
      "App unavailable",
    );
  });
});
