// Visuals on the Session socket and in the Session (`docs/architecture/visuals.md` → Tools, The copy, Socket messages, Fork
// and Clone, The frame, Network and isolation, Guidance): the record the Session keeps for each `visual_show`, its bounds, the `visuals` and
// `visual_page` messages, the fixed list of hosts a page may load from and the CSP that holds it, the pinned libraries the
// tool's description names, and the shim the web client injects into a page at mount. Records are additive-only, with
// fallback members and no format `v`, as App records are: a member a later build adds is a key an older reader passes over,
// and a `state` or `status` this build does not know reads as the fallback it names.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over small values.
import type { JsonValue } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import { buildCsp, NO_OWN_HOSTS } from "./csp.ts";
import { ConversationId } from "./conversation-id.ts";
import { VISUAL_THEMES, visualStyleVariables, type VisualTheme } from "./style-variables.ts";

const MiB = 1024 * 1024;

/** The tool that shows a Visual: the one name the extension defines it by and the client knows its card by. */
export const VISUAL_SHOW = "visual_show";

/** The tool that checks a Visual before it is shown (`docs/architecture/visuals.md` → The check). */
export const VISUAL_CHECK = "visual_check";

/** A bound in bytes as messages say it: `2 MiB`, `1 MiB`, `512 KiB`. */
export const visualSizeText = (bytes: number): string =>
  bytes >= MiB ? `${Number((bytes / MiB).toFixed(1))} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

/** The most one Visual's page may weigh after inlining, in UTF-8 bytes (`docs/architecture/visuals.md` → The copy: Bounds). */
export const MAX_VISUAL_BYTES = 2 * MiB;

/** The most the Visuals of one Session may weigh in all, in a bound of their own apart from App records'. */
export const MAX_VISUALS_BYTES = 32 * MiB;

/** The most Visuals a Session keeps, and the most stubs (what an evicted Visual leaves). */
export const MAX_VISUALS = 1000;
export const MAX_VISUAL_STUBS = 2000;

/** The longest `title` and `summary` of a Visual, in characters. */
export const MAX_VISUAL_TITLE = 200;
export const MAX_VISUAL_SUMMARY = 300;

/** The most one local asset a `path` page inlines may weigh, in bytes. */
export const MAX_VISUAL_ASSET_BYTES = MiB;

/** The longest `callId` a `visual_page` may carry. */
export const MAX_VISUAL_KEY = 512;

/** Where the agent writes a page it will revise (`docs/architecture/visuals.md` → The copy: The scratch path). */
export const VISUAL_SCRATCH_DIRECTORY = "/workspace/.cloudpid/tmp/visuals";

/** The frame's height bounds, in CSS pixels (`docs/architecture/visuals.md` → The frame: Height). */
export const VISUAL_MIN_HEIGHT = 160;
export const VISUAL_MAX_HEIGHT = 20_000;

/** The height a frame gives a page that reports `reported` px: between `VISUAL_MIN_HEIGHT` and `VISUAL_MAX_HEIGHT`. */
export const fitHeight = (reported: number): number =>
  Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.ceil(reported)));

/** How many consecutive host resizes a page's height may follow by growing before the frame's height is frozen. */
export const VISUAL_GROWTH_RESIZES = 3;

/**
 * The width of the thread's column, which a Visual's frame is on a desktop (`max-w-3xl`, 768 px, less `px-4`), and about a
 * phone's (`docs/architecture/visuals.md` → Guidance: Layout). A web test holds the first to the layout.
 */
export const VISUAL_THREAD_WIDTH = 736;
export const VISUAL_PHONE_WIDTH = 360;

// ---------------------------------------------------------------------------------------------------------------------
// Network and isolation

/** The hosts a Visual's page may load resources from, fixed by cloudpid (ADR-0045): no Setting, Repo or agent sets them. */
export const VISUAL_HOSTS = [
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const;

/**
 * The policy a Visual's frame is sent through the proxy's `?csp=` (`docs/architecture/visuals.md` → Network and isolation): the
 * list as resource domains, and nothing else, so `connect-src`, `form-action` and `frame-src` are `'none'` and there is no
 * `blob:` or eval (the sandbox's `buildCsp`).
 */
export const VISUAL_CSP = {
  resourceDomains: VISUAL_HOSTS.map((host) => `https://${host}`),
} as const;

/**
 * The flags of a Visual's frame, as the header's `sandbox` directive says them: what `visual_check` adds to the policy of the
 * page it renders at the top level, where there is no frame to give them. Without it a pop-up (a new target the check's
 * `Fetch` does not see) reaches the network (`docs/architecture/risks-and-spikes.md`, #657).
 */
export const VISUAL_SANDBOX_DIRECTIVE = "sandbox allow-scripts allow-same-origin";

/**
 * The `Content-Security-Policy` header of a Visual the check renders (`docs/architecture/visuals.md` → The check): the policy
 * the sandbox gives a frame (`buildCsp`, the same function, over `VISUAL_CSP`) and the frame's flags. `frame-ancestors` is
 * `'none'`: the page is the top-level document, framed by no one. The list names none of cloudpid's hosts, so nothing is
 * dropped as its own.
 */
export const visualCheckPolicy = (): string =>
  `${buildCsp(JSON.stringify(VISUAL_CSP), "'none'", NO_OWN_HOSTS)}; ${VISUAL_SANDBOX_DIRECTIVE}`;

/** Whether `host` (a URL's host name) is one of the list's. */
export const isVisualHost = (host: string): boolean => {
  const lower = host.toLowerCase();

  return VISUAL_HOSTS.some((each) => each === lower);
};

// ---------------------------------------------------------------------------------------------------------------------
// Libraries

const CDNJS = "https://cdnjs.cloudflare.com/ajax/libs";

/**
 * One pinned library the description names: its files (exact versions, never "latest"), and how it is loaded when that is
 * not a plain `<script src>` (`docs/architecture/visuals.md` → Guidance: Libraries). Bumped only by a deliberate deploy.
 */
export type VisualLibrary = {
  readonly name: string;
  readonly files: ReadonlyArray<string>;
  readonly note?: string;
};

export const VISUAL_LIBRARIES: ReadonlyArray<VisualLibrary> = [
  {
    name: "Mermaid",
    files: [`${CDNJS}/mermaid/11.17.2/mermaid.esm.min.mjs`],
    note: 'an ES module (`import mermaid from …` in a `<script type="module">`); its chunks load from the same directory',
  },
  { name: "Chart.js", files: [`${CDNJS}/Chart.js/4.6.1/chart.umd.min.js`] },
  { name: "ECharts", files: [`${CDNJS}/echarts/6.1.0/echarts.min.js`] },
  { name: "D3", files: [`${CDNJS}/d3/7.9.2/d3.min.js`] },
  { name: "Cytoscape", files: [`${CDNJS}/cytoscape/3.34.4/cytoscape.umd.min.js`] },
  {
    name: "KaTeX",
    files: [`${CDNJS}/KaTeX/0.19.1/katex.min.js`, `${CDNJS}/KaTeX/0.19.1/katex.min.css`],
  },
  { name: "highlight.js", files: [`${CDNJS}/highlight.js/11.11.2/highlight.min.js`] },
  {
    name: "three.js",
    files: [`${CDNJS}/three.js/0.187.0/three.module.min.js`],
    note: 'through an import map (`{"imports":{"three":"…/three.module.min.js"}}`); it loads `three.core.js` beside it',
  },
];

/** What fails under the policy, named in the description so no check is spent finding it. */
export const VISUAL_KNOWN_FAILURES: ReadonlyArray<string> = [
  "Vega, Vega-Lite and vega-embed (they need eval)",
  "D3's csvParse and tsvParse (embed JSON, or parse in the page's own code)",
  "the full Plotly build (use plotly-strict.min.js, with no map traces)",
  "map tiles (no live maps)",
  "Chart.js's ESM build (it imports a chunk cdnjs does not serve)",
  '"latest" (every URL names a version)',
];

// ---------------------------------------------------------------------------------------------------------------------
// Records

/**
 * Something `visual_show` noticed of a page and showed it all the same (`docs/architecture/visuals.md` → Tools: Warns): `kind`
 * is one of `VISUAL_WARNING_KINDS` (a string, so one a later build adds still reads) and `message` says it to the agent.
 */
export const VisualWarning = Schema.Struct({ kind: Schema.String, message: Schema.String });

export type VisualWarning = typeof VisualWarning.Type;

/** The kinds of warning a show gives, which telemetry counts (never their text). */
export const VISUAL_WARNING_KINDS = [
  "asset_missing",
  "asset_too_large",
  "module_graph",
  "host_not_listed",
  "network",
  "frame_or_form",
  "touch",
  "secrets_replaced",
  "wrapped",
] as const;

export type VisualWarningKind = (typeof VISUAL_WARNING_KINDS)[number];

/** Where a Visual's page came from: a file of the calling conversation's Workspace (its absolute path), or the call itself. */
export const VisualSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("path"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("inline") }),
  // A kind a later build adds: read as inline (no file to open).
  Schema.Struct({ kind: Schema.String }),
]);

export type VisualSource = typeof VisualSource.Type;

/** The file a source names, or none for an inline page. */
export const sourcePathOf = (source: VisualSource): string | undefined =>
  source.kind === "path" && "path" in source ? source.path : undefined;

/**
 * The record of one shown Visual (`docs/architecture/visuals.md` → The copy: The record), kept in the Session's storage outside
 * History: its call (`callId`, which is the Visual's id), the conversation, the parent call for one shown from a `codemode`
 * script, the title and summary, the source, the page as shown (redacted of the Session's Secrets, its local assets inlined,
 * never the shim), its size, the warnings given at the show, and the time. The origin is computed from the Session, never kept.
 */
export const VisualRecord = Schema.Struct({
  callId: Schema.String,
  conversation: Schema.String,
  parentCall: Schema.optionalKey(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  source: VisualSource,
  html: Schema.String,
  /** The page's UTF-8 bytes. */
  bytes: Schema.Finite,
  warnings: Schema.Array(VisualWarning),
  /** Epoch milliseconds it was shown. */
  at: Schema.Finite,
});

export type VisualRecord = typeof VisualRecord.Type;

/** What a show hands the Session to keep: the record but its time, which the Session sets. */
export type VisualDraft = Omit<VisualRecord, "at">;

/** What an evicted Visual leaves: everything its card shows without the page. */
export const VisualStub = Schema.Struct({
  callId: Schema.String,
  conversation: Schema.String,
  parentCall: Schema.optionalKey(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  source: VisualSource,
  bytes: Schema.Finite,
  at: Schema.Finite,
});

export type VisualStub = typeof VisualStub.Type;

/**
 * A call's Visual record or stub as a Fork or Clone carries it to the new Session, with the page of entries that holds its
 * call (`ExportPage.visuals`; `docs/architecture/visuals.md` → Fork and Clone). Only an RPC's value, never a message to a
 * client, and never decoded: a Session reads one it cannot use as no copy at all.
 */
export type VisualCopy =
  | VisualRecordCopy
  | VisualStubCopy
  // A kind a newer Session sends: skipped, never an error that leaves a Fork half done.
  | { readonly kind: string };

export type VisualRecordCopy = { readonly kind: "record"; readonly record: VisualRecord };

export type VisualStubCopy = { readonly kind: "stub"; readonly stub: VisualStub };

/** Whether `copy` is a record copy (its kind, and its key: one from another build may have the kind alone). */
export const isRecordCopy = (copy: VisualCopy): copy is VisualRecordCopy =>
  copy.kind === "record" && "record" in copy;

/** Whether `copy` is a stub copy (its kind, and its key). */
export const isStubCopy = (copy: VisualCopy): copy is VisualStubCopy =>
  copy.kind === "stub" && "stub" in copy;

/** What a Session does with the Visuals of a Fork or Clone (`ExportPage.visuals`): what its calls' copies are, and keeping them. */
export type VisualCopies = {
  /** The copies of the Visuals of the calls in `callIds` and of the calls nested in them (a `codemode` script's), kept or not. */
  readonly copiesFor: (callIds: ReadonlyArray<string>) => ReadonlyArray<VisualCopy>;
  /** Keep the copies a Fork or Clone's source sent, as the calls of conversation `conversation`; the bounds apply. */
  readonly adopt: (copies: ReadonlyArray<VisualCopy>, conversation: ConversationId) => void;
};

/**
 * One Visual of a conversation, as `visuals` lists them: `kept` (its page can be mounted) or `evicted` (a stub: the card shows
 * its title, summary, source, time and size). A state this build does not know reads as `evicted`.
 */
export const VisualEntry = Schema.Struct({
  callId: Schema.String,
  parentCall: Schema.optionalKey(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  source: VisualSource,
  state: Schema.String,
  bytes: Schema.Finite,
  at: Schema.Finite,
});

export type VisualEntry = typeof VisualEntry.Type;

/** Whether an entry's page can be mounted: `kept`; any other state, one a later build adds included, cannot. */
export const isKeptVisual = (entry: Pick<VisualEntry, "state">): boolean => entry.state === "kept";

/**
 * A conversation's Visuals, whole: sent after the snapshot of each conversation a client `watch`es, and again each time they
 * change; each replaces the last one of that conversation (`docs/architecture/visuals.md` → Socket messages).
 */
export const VisualsMessage = Schema.Struct({
  type: Schema.Literal("visuals"),
  conversationId: ConversationId,
  visuals: Schema.Array(VisualEntry),
});

/**
 * Ask for a Visual's page (`docs/architecture/visuals.md` → Socket messages): answered through the socket's `id`/`result` reply
 * with a `VisualPageAnswer`. Sent only to a Session whose `hello` says `visuals`.
 */
export const VisualPageCommand = Schema.Struct({
  type: Schema.Literal("visual_page"),
  id: Schema.optionalKey(Schema.String),
  callId: Schema.String.check(Schema.isMaxLength(MAX_VISUAL_KEY)),
});

/**
 * What `visual_page` answers: the `page` (the record, with the `origin` the Session's Visuals are served at; none when the
 * stage cannot build one, and the frame then fails to start rather than guess), the Visual's `stub` when it was `evicted`, or
 * `none` (no Visual of that call: it is still running, failed, or was never one). Answering with a page marks the Visual the
 * most recently mounted. A status this build does not know reads as `none`.
 */
export const VisualPageAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("page"),
    record: VisualRecord,
    origin: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("evicted"), stub: VisualStub }),
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.String }),
]);

export type VisualPageAnswer = typeof VisualPageAnswer.Type;

/**
 * Ask for the file a Visual was shown from, as it is now (`docs/architecture/visuals.md` → The frame: The card, Open file):
 * answered with a `VisualFileAnswer`. The file is the one the Visual's record names, read from the Workspace of the
 * conversation that showed it, never a path the client sends. Sent only to a Session whose `hello` says `visuals`.
 */
export const VisualFileCommand = Schema.Struct({
  type: Schema.Literal("visual_file"),
  id: Schema.optionalKey(Schema.String),
  callId: Schema.String.check(Schema.isMaxLength(MAX_VISUAL_KEY)),
});

/**
 * What `visual_file` answers: the file's `text` as it is now, with its path; `missing` (it was moved, removed or never a
 * file, or the Workspace did not answer in time), `too_large` (over the 2 MiB a page may be), `not_text` (not UTF-8), or
 * `none` (no Visual of that call, or one shown inline). A status this build does not know reads as `none`.
 */
export const VisualFileAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("text"), path: Schema.String, text: Schema.String }),
  Schema.Struct({
    status: Schema.Literals(["missing", "too_large", "not_text"]),
    path: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.String }),
]);

export type VisualFileAnswer = typeof VisualFileAnswer.Type;

/**
 * What `visual_show` gives a script (`docs/architecture/visuals.md` → Tools): the Visual's id (its call's), its title, size and
 * source file, the earlier Visual of the same file in the conversation that now shows collapsed, and the warnings' messages.
 * The same keys are the result's `details.visual`, which `/export` and `session_transcript` read.
 */
export const VisualShown = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  bytes: Schema.Finite,
  source_path: Schema.NullOr(Schema.String),
  supersedes: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
});

export type VisualShown = typeof VisualShown.Type;

/**
 * What `visual_check` gives a script (`docs/architecture/visuals.md` → Tools): the width and theme it rendered at, the page's
 * content height (null when the check was cut off before it measured it), whether the screenshot shows less than the page (and from where to where it does), whether the page grows
 * after each of the frame's resizes, and what the page logged, was blocked from and failed to load, with the check's own
 * warnings. The screenshot itself is an image of the result, never a value.
 */
export const VisualChecked = Schema.Struct({
  width: Schema.Finite,
  theme: Schema.Literals(VISUAL_THEMES),
  content_height: Schema.NullOr(Schema.Finite),
  clipped: Schema.Boolean,
  screenshot: Schema.NullOr(Schema.Struct({ top: Schema.Finite, height: Schema.Finite })),
  grows: Schema.Boolean,
  console: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  violations: Schema.Array(Schema.String),
  failed_loads: Schema.Array(Schema.Struct({ url: Schema.String, reason: Schema.String })),
  warnings: Schema.Array(Schema.String),
});

export type VisualChecked = typeof VisualChecked.Type;

/** The key of a `visual_show` result's `details` that holds what it showed (`VisualShown`, with its `summary`). */
export const VISUAL_DETAILS_KEY = "visual";

/** What `/export` and `session_transcript` write for a Visual: never its page. */
export const visualTranscriptLine = (title: string, summary: string): string =>
  `Visual: ${title} — ${summary} (not rendered)`;

/** The key of the Visual Pane that shows call `callId`'s Visual: `visual:<callId>`, as it is. */
export const visualPaneKey = (callId: string): string => `visual:${callId}`;

/**
 * The query of the Session's page that opens that Pane (`?pane=visual:call_1`), as the web app writes a Pane key: encoded
 * but for the `:` after the type, so `URLSearchParams` reads back the key `visualPaneKey` gives. The web app's `encodeKey` (`apps/web/src/router.ts`) writes
 * a Pane key the same way; keep the two alike.
 */
export const visualPaneQuery = (callId: string): string =>
  `?pane=${encodeURIComponent(visualPaneKey(callId)).replaceAll("%3A", ":")}`;

/**
 * What a result's `details.visual` says of the Visual its call showed: the title and summary, and, when it says them, its id
 * (the call's), the file it was shown from (`source_path`, null for an inline page) and its size.
 */
export const ShownVisual = Schema.Struct({
  id: Schema.String.pipe(Schema.optionalKey),
  title: Schema.String,
  summary: Schema.String,
  source_path: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
  bytes: Schema.Finite.pipe(Schema.optionalKey),
});

export type ShownVisual = typeof ShownVisual.Type;

const ShownDetails = Schema.Struct({ [VISUAL_DETAILS_KEY]: ShownVisual });

const isShownDetails = Schema.is(ShownDetails);

/**
 * The Visual a tool result's `details` say it showed (`details.visual`), for `/export` and `session_transcript`, and for the
 * card of a call whose Visual a Session does not keep (a Fork whose source's copy could not be read); none for any other
 * result, a failed call included.
 */
export const shownVisualOf = (details: JsonValue | undefined): ShownVisual | undefined =>
  isShownDetails(details) ? details[VISUAL_DETAILS_KEY] : undefined;

// ---------------------------------------------------------------------------------------------------------------------
// The shim

/** The WebRTC constructors the shim deletes before the page's scripts run (and the check's prelude does), a speed bump. */
export const VISUAL_WEBRTC_NAMES = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
] as const;

/** The notification the shim posts for an Escape the page did not handle; cloudpid's own, since ext-apps has none. */
export const VISUAL_ESCAPE = "cloudpid/notifications/escape";

/**
 * The shim (`docs/architecture/visuals.md` → The frame: The shim), as the text the web client puts first in a page's `<head>`
 * at mount, never stored, so a fix reaches every stored Visual. A plain script, not a module, so a test runs the very text in
 * a fake window. It speaks a subset of the ext-apps frame protocol to the proxy above it: `ui/initialize` (answered with the
 * host context, whose style variables and theme it applies to the page's root, live with each `host-context-changed`), the
 * content's height as `size-changed` (the root's height at `max-content`, as ext-apps' own apps measure it, so a page
 * shorter than its frame reports its own height and the frame shrinks; a `scrollHeight` is never less than the frame), a link the page opens as `ui/open-link` (the host asks the owner first), and an Escape
 * the page did not handle. Before the page's scripts run it forces `overscroll-behavior: auto` so a scroll at the frame's end
 * chains to the chat, and deletes the WebRTC constructors: a speed bump, not a boundary (a fresh realm bypasses it).
 */
export const VISUAL_SHIM = `(function () {
  "use strict";
  var host = window.parent;
  if (!host || host === window) return;
  var target = window.location.origin && window.location.origin !== "null" ? window.location.origin : "*";
  ${JSON.stringify(VISUAL_WEBRTC_NAMES)}.forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  var style = document.createElement("style");
  style.textContent = "html, body { overscroll-behavior: auto !important; }";
  (document.head || document.documentElement).appendChild(style);
  var next = 1;
  var waiting = {};
  var post = function (message) { host.postMessage(message, target); };
  var notify = function (method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); };
  var request = function (method, params, done) {
    var id = "visual-" + next++;
    waiting[id] = done;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
  };
  var apply = function (context) {
    if (!context || typeof context !== "object") return;
    var root = document.documentElement;
    if (context.theme === "light" || context.theme === "dark") {
      root.style.colorScheme = context.theme;
      root.setAttribute("data-theme", context.theme);
    }
    var variables = context.styles && context.styles.variables;
    if (variables && typeof variables === "object") {
      Object.keys(variables).forEach(function (key) {
        if (key.indexOf("--") === 0 && typeof variables[key] === "string") root.style.setProperty(key, variables[key]);
      });
    }
  };
  var sent = -1;
  var measure = function () {
    var root = document.documentElement;
    var before = root.style.getPropertyValue("height");
    var priority = root.style.getPropertyPriority("height");
    root.style.setProperty("height", "max-content", "important");
    var height = Math.ceil(root.getBoundingClientRect().height);
    if (before) root.style.setProperty("height", before, priority);
    else root.style.removeProperty("height");
    if (height !== sent) {
      sent = height;
      notify("ui/notifications/size-changed", { height: height });
    }
  };
  var started = false;
  var start = function () {
    if (started) return;
    started = true;
    notify("ui/notifications/initialized", {});
    measure();
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    window.addEventListener("load", measure);
  };
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;
    if (data.id !== undefined && data.method === undefined) {
      var done = waiting[data.id];
      delete waiting[data.id];
      if (done) done(data.result, data.error);
      return;
    }
    if (data.method === "ui/notifications/host-context-changed") { apply(data.params); return; }
    if (data.id !== undefined && (data.method === "ui/resource-teardown" || data.method === "ping")) {
      post({ jsonrpc: "2.0", id: data.id, result: {} });
    }
  });
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented) return;
    var node = event.target;
    while (node && node.nodeType === 1 && String(node.nodeName).toLowerCase() !== "a") node = node.parentNode;
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== "function") return;
    var href = node.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var url;
    try { url = new URL(href, document.baseURI); } catch (e) { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    request("ui/open-link", { url: url.href }, function () {});
  });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !event.defaultPrevented) notify("${VISUAL_ESCAPE}", {});
  });
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "cloudpid-visual", version: "1" },
    appCapabilities: {}
  }, function (result) {
    if (result && result.hostContext) apply(result.hostContext);
    start();
  });
})();`;

/** `html` with `script` first in its `<head>` (or right after `<html>`, or first of all), so it runs before the page's scripts. */
const withScriptFirst = (html: string, script: string): string => {
  const head = /<head(\s[^>]*)?>/i.exec(html);

  if (head !== null) {
    const at = head.index + head[0].length;

    return `${html.slice(0, at)}${script}${html.slice(at)}`;
  }

  const root = /<html(\s[^>]*)?>/i.exec(html);

  if (root !== null) {
    const at = root.index + root[0].length;

    return `${html.slice(0, at)}<head>${script}</head>${html.slice(at)}`;
  }

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);

  return doctype === null
    ? `${script}${html}`
    : `${doctype[0]}${script}${html.slice(doctype[0].length)}`;
};

/** `html` with the shim first in its `<head>` (or right after `<html>`, or first of all), so it runs before the page's scripts. */
export const withVisualShim = (html: string): string =>
  withScriptFirst(html, `<script>${VISUAL_SHIM}</script>`);

/**
 * What `visual_check` runs first in the page it renders at the top level, where the shim (which answers only a host above it)
 * would do nothing: the theme and style variables a frame is told, on `<html>` (`color-scheme`, `data-theme` and the custom
 * properties, as the shim applies them), and the WebRTC constructors deleted. The values are the table's for `theme`.
 */
export const visualCheckPrelude = (theme: VisualTheme): string =>
  `(function () {
  var root = document.documentElement;
  root.style.colorScheme = ${JSON.stringify(theme)};
  root.setAttribute("data-theme", ${JSON.stringify(theme)});
  var variables = ${JSON.stringify(visualStyleVariables(theme))};
  Object.keys(variables).forEach(function (key) { root.style.setProperty(key, variables[key]); });
  ${JSON.stringify(VISUAL_WEBRTC_NAMES)}.forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
})();`;

/** `html` as `visual_check` renders it: the prelude first in its `<head>`, never stored. */
export const withVisualCheckPrelude = (html: string, theme: VisualTheme): string =>
  withScriptFirst(html, `<script>${visualCheckPrelude(theme)}</script>`);
