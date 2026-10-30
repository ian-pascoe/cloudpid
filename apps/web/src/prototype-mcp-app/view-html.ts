/* oxlint-disable -- PROTOTYPE: throwaway code, never merged */
// @effect-diagnostics *:off
/**
 * PROTOTYPE (throwaway): the HTML of a stub MCP App View, as a server would serve it from a `ui://` resource. It speaks
 * the MCP Apps JSON-RPC over `postMessage`: `ui/initialize`, then takes `tool-input` and `tool-result`, and sends
 * `tools/call`, `ui/message`, `ui/update-model-context`, `ui/request-display-mode` and `size-changed`.
 *
 * In the prototype it loads as `srcdoc` in an opaque-origin iframe; the real host uses the double-iframe sandbox on its
 * own hostname (https://github.com/ian-pascoe/cloudpid/issues/375).
 */
import type { AppKind } from "./store.ts";

const SCRIPT = String.raw`
let nextId = 1;
const pending = new Map();
const request = (method, params) => {
  const id = nextId++;
  parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve) => pending.set(id, resolve));
};
const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");

let host = null;
let input = null;
let result = null;
let local = { selected: null, held: null, range: null, series: null, mounted: new Date().toLocaleTimeString() };

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error);
    pending.delete(message.id);
    return;
  }
  if (message.method === "ui/notifications/tool-input") { input = message.params.arguments; render(); }
  if (message.method === "ui/notifications/tool-result") { result = message.params; render(); }
  if (message.method === "ui/notifications/host-context-changed") { host = { ...host, ...message.params }; render(); }
  if (message.method === "ui/resource-teardown") { parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*"); }
});

const app = document.getElementById("app");
const h = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};

const toolbar = () => h("div", { class: "bar" },
  h("span", { class: "muted" }, "mode: " + (host?.displayMode ?? "?") + " · mounted " + local.mounted),
  h("button", { onclick: async () => {
    const want = host?.displayMode === "fullscreen" ? "inline" : "fullscreen";
    const answer = await request("ui/request-display-mode", { mode: want });
    host = { ...host, displayMode: answer.mode };
    render();
  } }, host?.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"),
);

const seats = () => {
  const data = result?.structuredContent;
  if (!data) return h("p", { class: "muted" }, "Waiting for the result… (input: " + JSON.stringify(input) + ")");
  return h("div", {},
    h("h3", {}, "✈ " + data.flight + " · pick a seat"),
    h("div", { class: "grid" }, data.seats.map((seat) => h("button", {
      class: "seat" + (seat.taken ? " taken" : "") + (local.selected === seat.id ? " picked" : "") + (local.held === seat.id ? " held" : ""),
      disabled: seat.taken,
      onclick: () => {
        local.selected = seat.id;
        const window_ = /[AF]$/.test(seat.id);
        request("ui/update-model-context", { content: [{ type: "text", text: "The owner is looking at seat " + seat.id + " on " + data.flight + (window_ ? " (window)." : " (not a window).") }] });
        render();
      },
    }, seat.id))),
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: !local.selected, onclick: async () => {
        const answer = await request("tools/call", { name: "reserve_seat", arguments: { seat: local.selected } });
        local.held = answer.structuredContent.held;
        render();
      } }, "Hold seat (app-only tool)"),
      h("button", { disabled: !local.selected, onclick: () => request("ui/message", { role: "user", content: [{ type: "text", text: "Book seat " + local.selected + " on " + data.flight + " for me." }] }) }, "Ask the agent to book it"),
    ),
    local.held ? h("p", { class: "ok" }, "Held " + local.held + " for 15 minutes.") : null,
  );
};

const chart = () => {
  const data = result?.structuredContent;
  if (!data) return h("p", { class: "muted" }, "Waiting for the result… (input: " + JSON.stringify(input) + ")");
  const range = local.range ?? data.range;
  const series = local.series ?? data.series;
  const max = Math.max(...series.map((point) => point.value));
  return h("div", {},
    h("h3", {}, "📈 Signups · " + range),
    h("div", { class: "row" }, ["7d", "30d"].map((option) => h("button", {
      class: option === range ? "primary" : "",
      onclick: async () => {
        const answer = await request("tools/call", { name: "get_metrics", arguments: { range: option } });
        local.range = answer.structuredContent.range;
        local.series = answer.structuredContent.series;
        request("ui/update-model-context", { content: [{ type: "text", text: "The owner is viewing signups for " + local.range + "." }] });
        render();
      },
    }, option))),
    h("div", { class: "bars" }, series.map((point) => h("div", { class: "barrow" },
      h("span", { class: "muted" }, "d" + point.day),
      h("div", { class: "fill", style: "width:" + Math.round((point.value / max) * 100) + "%" }),
      h("span", {}, String(point.value)),
    ))),
    h("button", { onclick: () => request("ui/message", { role: "user", content: [{ type: "text", text: "Why did signups dip around day " + series.reduce((low, point) => point.value < low.value ? point : low).day + "?" }] }) }, "Ask the agent about the dip"),
  );
};

const render = () => {
  document.documentElement.dataset.theme = host?.theme ?? "light";
  app.replaceChildren(toolbar(), KIND === "seats" ? seats() : chart());
};

new ResizeObserver(() => notify("ui/notifications/size-changed", { height: Math.ceil(app.getBoundingClientRect().height) })).observe(app);

(async () => {
  render();
  host = (await request("ui/initialize", { appInfo: { name: KIND + "-view" }, protocolVersion: "2026-01-26" })).hostContext;
  notify("ui/notifications/initialized", {});
  render();
})();
`;

const STYLE = `
:root { --bg: #fff; --fg: #1d2330; --muted: #6b7385; --line: #dfe3ea; --accent: #2f5bd3; --taken: #eceff3; font: 13px system-ui, sans-serif; }
[data-theme=dark] { --bg: #23272f; --fg: #eef0f4; --muted: #9aa3b5; --line: #3a404c; --accent: #7fa0ff; --taken: #2d323b; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
#app { padding: 12px; display: flow-root; }
h3 { margin: 4px 0 10px; font-size: 14px; }
.muted { color: var(--muted); font-size: 11px; }
.bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; max-width: 320px; }
button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.seat.taken { background: var(--taken); }
.seat.picked { outline: 2px solid var(--accent); }
.seat.held { background: var(--accent); color: var(--bg); }
.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.row { display: flex; gap: 6px; margin: 10px 0; flex-wrap: wrap; }
.ok { color: #2e9e5b; }
.bars { display: grid; gap: 2px; margin: 8px 0; }
.barrow { display: grid; grid-template-columns: 28px 1fr 32px; gap: 6px; align-items: center; }
.fill { height: 10px; background: var(--accent); border-radius: 3px; }
`;

export const viewHtml = (kind: AppKind): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div id="app"></div><script>const KIND = ${JSON.stringify(kind)};${SCRIPT}</script></body></html>`;
