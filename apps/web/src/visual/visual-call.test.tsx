// docs/architecture/visuals.md → The frame (The card), The copy (Revisions, Bounds), Socket messages, Testing. What a
// `visual_show` call's card shows from the Session's state as the atoms hold it, rendered on the server (a place claims its
// call after it mounts, and the frame mounts near the viewport, so what shows here is each card's chrome): the open card's
// chrome and actions, a superseded Visual collapsed with Reopen, the owner's choice, the evicted card, the call's progress, a
// script's strip, and an ordinary card for a Session that keeps no Visuals.
// @effect-diagnostics preferEffectArray:off -- a transcript in native lists.
import type { SessionView, TranscriptMessage, VisualEntry } from "@cloudpid/protocol";
import { EMPTY_VIEW } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ShownSession } from "../chat/conversation.ts";
import { ToolCallCard } from "../chat/parts.tsx";
import { appChoiceAtom } from "../session-layout-state.ts";
import { sessionStateAtom } from "../session/atoms.ts";
import { INITIAL_SESSION_STATE } from "../session/state.ts";
import { VisualCall, VisualDetails, VisualStrip } from "./visual-call.tsx";

/** What a `visual_show` result's details say it showed. */
const SHOWN = {
  title: "Sales",
  summary: "Sales by month, as bars",
  source_path: "/workspace/.cloudpid/tmp/visuals/sales.html",
  bytes: 2048,
};

const assistant = (id: string, name: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  timestamp: 0,
  parts: calls.map((call) => ({ type: "tool-call", id: call, name, arguments: {} })),
});

const entry = (callId: string, more: Partial<VisualEntry> = {}): VisualEntry => ({
  callId,
  title: `Chart ${callId}`,
  summary: `Sales by month (${callId})`,
  source: { kind: "path", path: "/workspace/.cloudpid/tmp/visuals/sales.html" },
  state: "kept",
  bytes: 2048,
  at: 0,
  ...more,
});

/** A registry holding Session `s1` with `messages` and the Visuals of its root conversation. */
const registryWith = (
  messages: TranscriptMessage[],
  visuals: VisualEntry[],
  keepsVisuals = true,
) => {
  const view: SessionView = { ...EMPTY_VIEW, messages };

  return AtomRegistry.make({
    initialValues: [
      Atom.initialValue(sessionStateAtom("s1"), {
        ...INITIAL_SESSION_STATE,
        view,
        visuals: { "1": visuals },
        activeBranch: 1,
        keepsVisuals,
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

const card = (
  registry: AtomRegistry.AtomRegistry,
  toolCallId: string,
  toolName: string,
  result: string | undefined = "done",
) =>
  markup(
    registry,
    <ToolCallCard
      type="tool-call"
      toolCallId={toolCallId}
      toolName={toolName}
      args={{ title: "Sales" }}
      argsText=""
      result={result}
      artifact={{ nested: [] }}
      status={result === undefined ? { type: "running" } : { type: "complete" }}
      addResult={() => undefined}
      resume={() => undefined}
      respondToApproval={() => Promise.resolve()}
    />,
  );

describe("a visual_show call's card", () => {
  it('shows the Visual under the chrome "Visual · <title>", with Collapse, Copy HTML, Open file and Details', () => {
    const registry = registryWith([assistant("1", "visual_show", "a")], [entry("a")]);
    const html = markup(registry, <VisualCall callId="a" />);

    expect(html).toContain("Visual · Chart a Collapse Pop out Copy HTML Open file Details");
  });

  it("offers no Open file for an inline page", () => {
    const registry = registryWith(
      [assistant("1", "visual_show", "a")],
      [entry("a", { source: { kind: "inline" } })],
    );

    expect(markup(registry, <VisualCall callId="a" />)).not.toContain("Open file");
  });

  it("collapses a Visual a newer one of the same file supersedes, with Reopen, unless the owner reopened it", () => {
    const messages = [assistant("1", "visual_show", "a"), assistant("2", "visual_show", "b")];
    const entries = [entry("a"), entry("b", { at: 1 })];

    expect(markup(registryWith(messages, entries), <VisualCall callId="a" />)).toContain(
      "Visual · Chart a A newer version is below Reopen",
    );
    expect(markup(registryWith(messages, entries), <VisualCall callId="b" />)).toContain(
      "Collapse",
    );

    const reopened = registryWith(messages, entries);

    reopened.set(appChoiceAtom("s1", "a"), "open");
    expect(markup(reopened, <VisualCall callId="a" />)).toContain("Collapse");

    const collapsed = registryWith(messages, entries);

    collapsed.set(appChoiceAtom("s1", "b"), "collapsed");
    expect(markup(collapsed, <VisualCall callId="b" />)).toContain("Chart b collapsed Reopen");
  });

  it("shows an evicted Visual's title, summary, source, size and time, with Open file", () => {
    const registry = registryWith(
      [assistant("1", "visual_show", "a")],
      [entry("a", { state: "evicted" })],
    );

    expect(markup(registry, <VisualCall callId="a" />)).toContain(
      "Visual · Chart a no longer kept Open file Sales by month (a) /workspace/.cloudpid/tmp/visuals/sales.html · 2 KB · 1970-01-01 00:00 UTC",
    );
  });

  it("shows its progress while the call runs, and nothing for a call that left no Visual", () => {
    const registry = registryWith([assistant("1", "visual_show", "a")], []);

    expect(
      markup(registry, <VisualCall callId="a" progress={{ phase: "streaming", title: "Sales" }} />),
    ).toContain("Visual · Sales Preparing…");
    expect(markup(registryWith([], []), <VisualCall callId="a" />)).toBe("");
  });

  it("says a Visual is no longer kept when its call showed one and the Session's list of the thread's has come without it", () => {
    const registry = registryWith([assistant("1", "visual_show", "a")], []);

    expect(markup(registry, <VisualCall callId="a" shown={SHOWN} />)).toBe(
      " Visual · Sales no longer kept Sales by month, as bars /workspace/.cloudpid/tmp/visuals/sales.html · 2 KB ",
    );

    const inline = registryWith([assistant("1", "visual_show", "a")], []);

    expect(
      markup(inline, <VisualCall callId="a" shown={{ ...SHOWN, source_path: null, bytes: 70 }} />),
    ).toContain("Written inline by the call · 70 B");
  });

  it("waits for the list of the thread's Visuals before it says so, and says nothing of a call that showed none", () => {
    const view: SessionView = { ...EMPTY_VIEW, messages: [assistant("1", "visual_show", "a")] };

    const early = AtomRegistry.make({
      initialValues: [
        Atom.initialValue(sessionStateAtom("s1"), {
          ...INITIAL_SESSION_STATE,
          view,
          activeBranch: 1,
          keepsVisuals: true,
        }),
      ],
    });

    expect(markup(early, <VisualCall callId="a" shown={SHOWN} />)).toBe("");

    // A failed call shows none: its details say nothing of a Visual.
    expect(markup(registryWith([], []), <VisualCall callId="a" />)).toBe("");
  });

  it("shows the card of a call's result from its artifact, in the card a Session that keeps Visuals shows", () => {
    const registry = registryWith([assistant("1", "visual_show", "a")], []);

    expect(
      markup(
        registry,
        <ToolCallCard
          type="tool-call"
          toolCallId="a"
          toolName="visual_show"
          args={{ title: "Sales" }}
          argsText=""
          result="Shown"
          artifact={{ visual: SHOWN }}
          status={{ type: "complete" }}
          addResult={() => undefined}
          resume={() => undefined}
          respondToApproval={() => Promise.resolve()}
        />,
      ),
    ).toContain("Visual · Sales no longer kept");
  });

  it("is an ordinary card for a Session that keeps no Visuals", () => {
    const keeps = registryWith([assistant("1", "visual_show", "a")], [entry("a")]);

    expect(card(keeps, "a", "visual_show")).toContain("Visual · Chart a");

    const older = registryWith([assistant("1", "visual_show", "a")], [entry("a")], false);

    expect(card(older, "a", "visual_show")).not.toContain("Visual ·");
  });

  it("lists a codemode script's Visuals in a strip under its card", () => {
    const registry = registryWith(
      [assistant("1", "codemode", "script")],
      [entry("n1", { parentCall: "script" }), entry("n2", { parentCall: "script", at: 1 })],
    );

    const html = card(registry, "script", "codemode");

    expect(html).toContain("Visual · Chart n1 A newer version is below Reopen");
    expect(html).toContain("Visual · Chart n2 Collapse");
    expect(markup(registryWith([], []), <VisualStrip parentId="script" />)).toBe("");
  });

  it("says in Details where the page came from, its size and time, its warnings and origin, and that the agent wrote it", () => {
    const html = markup(
      registryWith([], []),
      <VisualDetails
        entry={entry("a")}
        origin="https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app"
        record={{
          callId: "a",
          conversation: "1",
          title: "Chart a",
          summary: "Sales by month (a)",
          source: { kind: "inline" },
          html: "",
          bytes: 0,
          warnings: [{ kind: "network", message: "A script calls fetch, which the frame blocks" }],
          at: 0,
        }}
      />,
    );

    expect(html).toContain("Written by the agent");
    expect(html).toContain("Summary: Sales by month (a)");
    expect(html).toContain("Source: /workspace/.cloudpid/tmp/visuals/sales.html");
    expect(html).toContain("Size: 2 KB");
    expect(html).toContain("Served from https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app");
    expect(html).toContain("A script calls fetch, which the frame blocks");
  });
});
