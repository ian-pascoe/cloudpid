// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live). What an App call's card says of a
// View that is not live, from the Session's state as the atoms hold it: an older generation's View is a collapsed row with
// Reopen, a record that was evicted or a tool that is no App's any more says so, and a `codemode` script's App calls are
// listed in a strip under its card. Rendered on the server: a place claims its call after it mounts, so what shows here is
// what each says before any View is mounted, which is all a collapsed card says.
// @effect-diagnostics preferEffectArray:off -- a transcript in native lists.
import type { McpAppEntry, McpAppTool, SessionView, TranscriptMessage } from "@cloudpid/protocol";
import { EMPTY_VIEW } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "vite-plus/test";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { ShownSession } from "../chat/conversation.ts";
import { ToolCallCard } from "../chat/parts.tsx";
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
});

describe("an App Pane that cannot mount its View", () => {
  const pane = (registry: AtomRegistry.AtomRegistry, callId: string) =>
    markup(registry, <AppPane argument={callId} close={() => undefined} />);

  it("says so when its call is not among the Session's App calls", () => {
    expect(pane(registryWith([], []), "gone")).toContain("This App is not in this Session.");
  });
});
