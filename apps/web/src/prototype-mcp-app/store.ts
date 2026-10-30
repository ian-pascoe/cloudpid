/* oxlint-disable -- PROTOTYPE: throwaway code, never merged */
// @effect-diagnostics *:off
/**
 * PROTOTYPE (throwaway, never merged): in-memory state for the MCP App rendering prototype of
 * https://github.com/ian-pascoe/cloudpid/issues/384. Nothing here is persisted or talks to a server; the "MCP servers"
 * are stubs answering after a short delay.
 */
import { useSyncExternalStore } from "react";

export type AppKind = "seats" | "chart";

export interface AppToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly text: string;
}

export interface ToolEntry {
  readonly kind: "tool";
  readonly id: string;
  readonly tool: string;
  readonly server: string;
  readonly title: string;
  readonly app: AppKind;
  readonly args: Record<string, unknown>;
  readonly result?: { readonly text: string; readonly structured: unknown } | undefined;
  /** Calls the View made itself (`tools/call` from the View), app-only tools included. */
  readonly appCalls: readonly AppToolCall[];
}

export type Entry =
  | {
      readonly kind: "owner";
      readonly id: string;
      readonly text: string;
      readonly via?: string | undefined;
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | ToolEntry;

export interface LogLine {
  readonly id: number;
  readonly dir: "view→host" | "host→view" | "host";
  readonly callId?: string | undefined;
  readonly text: string;
}

export type MessageMode = "send" | "draft";

export interface State {
  readonly transcript: readonly Entry[];
  /** `ui/update-model-context`: the latest per View (it overwrites), keyed by call ID. */
  readonly modelContext: Readonly<
    Record<string, { readonly server: string; readonly text: string }>
  >;
  readonly log: readonly LogLine[];
  /** Bumped by "Reload page": every View remounts, as on a client that connects later. */
  readonly epoch: number;
  /** Open App Panes (`app:<callId>`), in tab order, and the one shown. */
  readonly panes: readonly string[];
  readonly shownPane?: string | undefined;
  readonly phone: boolean;
  readonly messageMode: MessageMode;
  readonly draft?: { readonly text: string; readonly via: string } | undefined;
  /** Variant C: older Views the owner reopened live. */
  readonly reopened: readonly string[];
}

let nextLog = 1;
let nextEntry = 100;

const seatsOf = (flight: string) => {
  let seed = [...flight].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const rows: { id: string; taken: boolean }[] = [];
  for (let row = 10; row <= 15; row++)
    for (const letter of ["A", "B", "C", "D", "E", "F"]) {
      seed = (seed * 9301 + 49297) % 233280;
      rows.push({ id: `${row}${letter}`, taken: seed / 233280 < 0.55 });
    }
  return rows;
};

const seriesOf = (range: string) => {
  const days = range === "30d" ? 30 : 7;
  return Array.from({ length: days }, (_, day) => ({
    day: day + 1,
    value: Math.round(40 + 30 * Math.sin(day / 2) + ((day * 37) % 23)),
  }));
};

const resultOf = (app: AppKind, args: Record<string, unknown>) => {
  if (app === "seats") {
    const flight = String(args.flight ?? "UA 917");
    const seats = seatsOf(flight);
    const free = seats.filter((seat) => !seat.taken).length;
    return {
      text: `Seat map for ${flight} shown to the owner in an app. ${free} of ${seats.length} seats free.`,
      structured: { flight, seats },
    };
  }

  const range = String(args.range ?? "7d");
  const series = seriesOf(range);
  return {
    text: `Signups chart (${range}) shown to the owner in an app. Total ${series.reduce((sum, point) => sum + point.value, 0)}.`,
    structured: { range, series },
  };
};

const initial: State = {
  transcript: [
    {
      kind: "owner",
      id: "e1",
      text: "Find me a window seat on UA 917 tomorrow, and show this week's signups.",
    },
    {
      kind: "assistant",
      id: "e2",
      text: "Here's the seat map for UA 917. Pick a seat and I'll book it.",
    },
    {
      kind: "tool",
      id: "call_seats_1",
      tool: "mcp__flights__show_seat_map",
      server: "flights",
      title: "Seat map",
      app: "seats",
      args: { flight: "UA 917" },
      result: resultOf("seats", { flight: "UA 917" }),
      appCalls: [],
    },
    { kind: "assistant", id: "e3", text: "And this week's signups:" },
    {
      kind: "tool",
      id: "call_chart_1",
      tool: "mcp__metrics__show_signups",
      server: "metrics",
      title: "Signups",
      app: "chart",
      args: { range: "7d" },
      result: resultOf("chart", { range: "7d" }),
      appCalls: [],
    },
  ],
  modelContext: {},
  log: [],
  epoch: 0,
  panes: [],
  phone: false,
  messageMode: "send",
  reopened: [],
};

let state: State = initial;
const listeners = new Set<() => void>();

export const getState = (): State => state;

export const setState = (update: (current: State) => State): void => {
  state = update(state);
  for (const listener of listeners) listener();
};

export const useStore = (): State =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );

export const log = (dir: LogLine["dir"], text: string, callId?: string): void =>
  setState((current) => ({
    ...current,
    log: [{ id: nextLog++, dir, text, callId }, ...current.log].slice(0, 80),
  }));

export const toolEntry = (id: string): ToolEntry | undefined => {
  const entry = state.transcript.find((found) => found.id === id);
  return entry?.kind === "tool" ? entry : undefined;
};

const patchTool = (id: string, patch: (entry: ToolEntry) => ToolEntry) =>
  setState((current) => ({
    ...current,
    transcript: current.transcript.map((entry) =>
      entry.kind === "tool" && entry.id === id ? patch(entry) : entry,
    ),
  }));

/** A View's own `tools/call`: answered by the stub server, recorded on the card, never shown to the model. */
export const callAppTool = async (
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; structuredContent: unknown }> => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const entry = toolEntry(callId);
  let text = "ok";
  let structured: unknown = {};
  if (name === "reserve_seat") {
    text = `Seat ${String(args.seat)} held for 15 minutes on ${String(entry?.args.flight)}.`;
    structured = { held: args.seat };
  } else if (name === "get_metrics") {
    const range = String(args.range ?? "7d");
    structured = { range, series: seriesOf(range) };
    text = `Signups for ${range}.`;
  }
  patchTool(callId, (found) => ({ ...found, appCalls: [...found.appCalls, { name, args, text }] }));
  return { content: [{ type: "text", text }], structuredContent: structured };
};

export const setModelContext = (callId: string, server: string, text: string): void =>
  setState((current) => ({
    ...current,
    modelContext: { ...current.modelContext, [callId]: { server, text } },
  }));

const agentReplies = (text: string) => {
  setTimeout(
    () =>
      setState((current) => ({
        ...current,
        transcript: [
          ...current.transcript,
          {
            kind: "assistant",
            id: `e${nextEntry++}`,
            text: `(stub agent) Read: "${text}". On it.`,
          },
        ],
      })),
    900,
  );
};

/** An owner message, typed or sent by a View (`via`): a turn starts on it. */
export const sendOwnerMessage = (text: string, via?: string): void => {
  setState((current) => ({
    ...current,
    draft: undefined,
    transcript: [...current.transcript, { kind: "owner", id: `e${nextEntry++}`, text, via }],
  }));
  agentReplies(text);
};

/** `ui/message` from a View: sent at once, or put in the composer for the owner to send, by the toggle. */
export const viewMessage = (server: string, text: string): void => {
  if (state.messageMode === "send") {
    sendOwnerMessage(text, `${server} app`);
    log("host", `ui/message from the ${server} View sent as an owner message; a turn starts`);
  } else {
    setState((current) => ({ ...current, draft: { text, via: `${server} app` } }));
    log("host", `ui/message from the ${server} View put in the composer; the owner sends it`);
  }
};

/** The agent calls another app tool: it streams (input first), and its result arrives later. */
export const agentCallsApp = (): void => {
  const count = state.transcript.filter((entry) => entry.kind === "tool").length;
  const id = `call_${count + 1}`;
  const app: AppKind = count % 2 === 0 ? "seats" : "chart";
  const args = app === "seats" ? { flight: "UA 1180" } : { range: "30d" };
  setState((current) => ({
    ...current,
    transcript: [
      ...current.transcript,
      {
        kind: "assistant",
        id: `e${nextEntry++}`,
        text: app === "seats" ? "Here's the return flight too:" : "Here's the month:",
      },
      {
        kind: "tool",
        id,
        tool: app === "seats" ? "mcp__flights__show_seat_map" : "mcp__metrics__show_signups",
        server: app === "seats" ? "flights" : "metrics",
        title: app === "seats" ? "Seat map" : "Signups",
        app,
        args,
        appCalls: [],
      },
    ],
  }));
  setTimeout(() => patchTool(id, (entry) => ({ ...entry, result: resultOf(app, args) })), 1500);
};

export const openPane = (callId: string): void =>
  setState((current) => ({
    ...current,
    panes: current.panes.includes(`app:${callId}`)
      ? current.panes
      : [...current.panes, `app:${callId}`],
    shownPane: `app:${callId}`,
  }));

export const closePane = (key: string): void =>
  setState((current) => {
    const panes = current.panes.filter((pane) => pane !== key);
    return {
      ...current,
      panes,
      shownPane: current.shownPane === key ? panes.at(-1) : current.shownPane,
    };
  });

export const reset = (): void => {
  state = initial;
  for (const listener of listeners) listener();
};
