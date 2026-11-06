// docs/architecture/visuals.md → Guidance. What the model is told of Visuals: the `visuals` system prompt section, two static
// lines that say when to show a Visual and how to load the tool, and `visual_show`'s static description, which holds the page
// rules, the layout, the style variables and the libraries. Both are fixed text, so the provider's prompt cache keeps hitting
// (AGENTS.md → Prompt cache); the description is one constant, bumped by a deliberate deploy.
// @effect-diagnostics preferEffectArray:off -- static text over small constant tables.
import {
  CONSTANTS,
  MAX_VISUAL_SUMMARY,
  MAX_VISUAL_TITLE,
  TOKENS,
  VISUAL_HOSTS,
  VISUAL_KNOWN_FAILURES,
  VISUAL_LIBRARIES,
  VISUAL_PHONE_WIDTH,
  VISUAL_SCRATCH_DIRECTORY,
  VISUAL_THREAD_WIDTH,
} from "@cloudpid/protocol";

/** The tool that shows a Visual. */
export const VISUAL_SHOW = "visual_show";

/** The `visuals` section's lines: when to show a Visual, and how to reach the tool when it is deferred. Never changes. */
export const VISUALS_SECTION = [
  `- When a picture says it better than text (a chart, a diagram, an explainer, a mockup), show the owner a Visual with ${VISUAL_SHOW}: a page of your own rendered inline in this conversation, on desktop and phone. Don't restate what it shows.`,
  `- If ${VISUAL_SHOW} is not loaded, load it with tool_search ("visual") first; its description has the page rules and the libraries.`,
].join("\n");

const styleVariables = [...TOKENS.map(([name]) => name), ...CONSTANTS.map(([name]) => name)];

const libraryLine = (library: (typeof VISUAL_LIBRARIES)[number]): string =>
  `  - ${library.name}: ${library.files.join(" and ")}${library.note === undefined ? "" : ` (${library.note})`}`;

/** `visual_show`'s description (`docs/architecture/visuals.md` → Guidance): static, read with the tool when it is loaded. */
export const VISUAL_SHOW_DESCRIPTION = [
  "Show the owner a Visual: a page you wrote (a chart, a diagram, an explainer, a mockup), rendered inline in this conversation where the call is, on desktop and phone, and kept as it was shown. It is display only: its scripts run, but it cannot call tools, reach cloudpid or tell you anything. Every call shows a new Visual; an earlier one of the same file then shows collapsed.",
  "",
  `Give exactly one of path (an HTML file of this Workspace) or html (the page itself), a title of at most ${MAX_VISUAL_TITLE} characters, and a summary of at most ${MAX_VISUAL_SUMMARY} that stands for the page wherever it is not rendered (transcripts, exports, an evicted card). Prefer path for anything you will revise, written at ${VISUAL_SCRATCH_DIRECTORY}/<distinctive-name>.html (absolute): after a compaction an inline page is recoverable only through context_history. A path page's local images (PNG, JPEG, WebP, GIF, SVG; at most 1 MiB each), stylesheets and single-file scripts, relative to the file or absolute, are inlined; a module graph is not. The copy is at most 2 MiB after inlining, and is redacted of the Secrets you hold.`,
  "",
  "Page rules:",
  "- One HTML document; scripts and styles inline or from the list below. No network calls (fetch, XHR, WebSocket, EventSource), forms or frames: they are blocked.",
  "- No viewport-height units (vh, svh, lvh, dvh) in the page's CSS: the call fails on them. The frame fits its height to the content.",
  "- Never ask the owner for credentials or anything private in a Visual.",
  "- Accessible: alt on images, <title> in SVGs, real text rather than text drawn in a canvas, and respect prefers-reduced-motion. Set touch-action, overscroll-behavior and touch listeners (passive: true unless a gesture needs otherwise) only where a gesture needs them, or the page can trap the chat's scrolling on a phone.",
  "",
  `Layout: the frame is the thread's width (${VISUAL_THREAD_WIDTH} px on a desktop, about ${VISUAL_PHONE_WIDTH} on a phone) and grows with the content, from 160 px up to 20,000 px, so a long explainer is one tall page, not a scroll box. Design for both widths.`,
  "",
  `Theme: the page is told the owner's theme live, as color-scheme and data-theme ("light" or "dark") on <html>, and as these CSS variables on <html>, which follow it: ${styleVariables.join(", ")}. Use them (with fallbacks) rather than fixed colors, so the page follows light and dark.`,
  "",
  `Network: resources load only inline, as data:, or from ${VISUAL_HOSTS.map((host) => `https://${host}`).join(", ")}; nothing else loads, and every URL must name an exact version. These pinned files are known to work:`,
  ...VISUAL_LIBRARIES.map(libraryLine),
  `Known not to work: ${VISUAL_KNOWN_FAILURES.join("; ")}.`,
  "",
  'The result is "Shown" with any warnings (a missing or too large asset, a host not on the list, network calls, a frame or form, touch handling, Secrets replaced, a fragment wrapped): fix what they say and show again. Scripts get { id, title, bytes, source_path, supersedes, warnings }.',
].join("\n");
