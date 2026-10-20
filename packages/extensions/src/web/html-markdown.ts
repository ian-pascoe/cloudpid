// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// HTML to Markdown in one linear pass over htmlparser2 events, with no DOM.
//
// The original pi-web-tools used Turndown, which needs a DOM (not in Workers) and re-reads its accumulated output for
// every sibling, so it is quadratic and the original had to split pages into pieces to keep it fast. This converter
// streams instead: block structure is a stack of line prefixes (list markers, `> `), inline spans (emphasis, code,
// links) are buffered until they close so their markers can wrap trimmed text, and every event is handled in constant
// time, so a multi-MiB flat page costs the same per byte as a small one and nesting depth costs no stack.
//
// Output follows Turndown's settings in the original (ATX headings, `-` bullets, fenced code, `*` emphasis, `---`
// rules, inline links), with these differences: lists are tight, an ordered list's `start` is honoured, and a table
// is one line per row with cells separated by ` | ` (Turndown, without its GFM plugin, put each cell in a paragraph).
import * as Arr from "effect/Array";
import { Parser } from "htmlparser2";
import { LINE_ELEMENTS, PARAGRAPH_ELEMENTS } from "./html-text.ts";

/** Elements whose content never reaches the Markdown, as in the original (`noscript` is kept, as Turndown kept it). */
const UNRENDERED_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "template", "svg"]);

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements converted as their children only: Markdown has no syntax for them, or they hold no content. */
const HEADING = /^h([1-6])$/;

/** A line prefix that a list item or a block quote adds: `marker` on its first line, `indent` on the rest. */
type Frame = { readonly marker: string; readonly indent: string; pending: boolean };

/** An open inline span whose text is held until it closes. */
type Span = {
  readonly kind: "strong" | "em" | "del" | "code" | "link" | "plain";
  readonly href?: string;
  readonly parts: string[];
  /** Whether whitespace separated the span from the text before it. */
  readonly spaceBefore: boolean;
};

/** Escape what Markdown would read as syntax in text, and, at the start of a line, what would start a block. */
export const escapeText = (text: string, atLineStart: boolean): string => {
  const escaped = text.replace(/[\\`*_[\]]/g, "\\$&");

  return atLineStart
    ? escaped
        .replace(/^(#{1,6})(\s|$)/, "\\$1$2")
        .replace(/^([-+=>])(\s|$)/, "\\$1$2")
        .replace(/^(\d+)\.(\s|$)/, "$1\\.$2")
        .replace(/^~~~/, "\\~~~")
    : escaped;
};

/** The number an ordered list starts at: its \`start\` attribute, or 1. */
const startNumber = (start: string | undefined): number => {
  const number = Number.parseInt(start ?? "1", 10);

  return Number.isNaN(number) ? 1 : number;
};

/** A URL as a Markdown destination: spaces and parentheses would end it early. */
const destination = (url: string): string =>
  url.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

/** `text` as an inline code span, with a delimiter longer than any run of backticks inside it. */
const codeSpan = (text: string): string => {
  const runs = text.match(/`+/g) ?? [];
  const longest = Arr.reduce(runs, 0, (max, run) => Math.max(max, run.length));
  const delimiter = "`".repeat(longest === 0 ? 1 : longest + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;

  return `${delimiter}${padded}${delimiter}`;
};

/** The fence for a code block: longer than any run of backticks in it. */
const fenceFor = (code: string): string => {
  const runs = code.match(/`{3,}/g) ?? [];

  return "`".repeat(Arr.reduce(runs, 3, (max, run) => Math.max(max, run.length + 1)));
};

const WRAPPERS = { strong: "**", em: "*", del: "~~" } as const;

/** Convert `html` to Markdown. Linear in its length; never throws on malformed input. */
export const htmlToMarkdown = (html: string): string => {
  const out: string[] = [];
  const frames: Frame[] = [];
  const spans: Span[] = [];
  /** Cells written so far in each open table row. */
  const rowCells: number[] = [];
  /** Ordered list counters; a bullet list holds undefined. */
  const lists: (number | undefined)[] = [];
  let lineOpen = false;
  /** Newlines wanted before the next content: 1 starts a line, 2 leaves a blank line. */
  let gap = 0;
  let pendingSpace = false;
  /** Whether a heading's marker was just written, so the text after it needs no space. */
  let afterMarker = false;
  let skipDepth = 0;
  let headingDepth = 0;
  let pre: { text: string; language: string } | undefined;

  const prefix = (blank: boolean): string => {
    let text = "";

    for (const frame of frames) {
      text += frame.pending && !blank ? frame.marker : frame.indent;

      if (!blank) frame.pending = false;
    }

    return blank ? text.trimEnd() : text;
  };

  const atLineStart = (): boolean => gap > 0 || !lineOpen;

  /** Write `text` to the page: close the line and add the blank line the last block asked for, then prefix the line. */
  const write = (text: string): void => {
    if (gap > 0 && out.length > 0) {
      if (lineOpen) {
        out.push("\n");
        lineOpen = false;
      }

      if (gap >= 2) out.push(`${prefix(true)}\n`);
    }

    gap = 0;

    if (!lineOpen) {
      out.push(prefix(false));
      lineOpen = true;
    }

    out.push(text);
  };

  const breakBefore = (newlines: 1 | 2): void => {
    gap = Math.max(gap, newlines);
  };

  /** Inside an inline span, a block boundary is only a space. */
  const block = (newlines: 1 | 2): void => {
    if (spans.length > 0 || headingDepth > 0) pendingSpace = true;
    else breakBefore(newlines);
  };

  /** Inline content goes to the open span, or to the page. */
  const put = (text: string): void => {
    const span = spans.at(-1);

    if (span !== undefined) {
      span.parts.push(text);

      return;
    }

    const visible = atLineStart() ? text.trimStart() : text;

    if (visible !== "") write(visible);
  };

  /**
   * A closed span as Markdown: its markers wrap trimmed text. Whitespace before the text is kept outside them; the
   * whitespace after it is `pendingSpace`, which the text inside the span left set.
   */
  const render = (span: Span): string => {
    const raw = span.parts.join("");
    const lead = /^\s/.test(raw) ? " " : "";
    const core = raw.trim();

    if (span.kind === "plain") return raw;

    if (core === "") return "";

    if (span.kind === "code") return lead + codeSpan(core);

    if (span.kind === "link") return `${lead}[${core}](${destination(span.href ?? "")})`;

    return `${lead}${WRAPPERS[span.kind]}${core}${WRAPPERS[span.kind]}`;
  };

  const closeSpan = (): void => {
    const span = spans.pop();

    if (span === undefined) return;

    const rendered = render(span);

    if (rendered.trim() === "") {
      // Nothing but whitespace: it only separates its neighbours.
      pendingSpace = pendingSpace || span.spaceBefore || rendered !== "";

      return;
    }

    put(span.spaceBefore && !rendered.startsWith(" ") ? ` ${rendered}` : rendered);
  };

  const openSpan = (span: Pick<Span, "kind" | "href">): void => {
    spans.push({ ...span, parts: [], spaceBefore: pendingSpace });
    pendingSpace = false;
  };

  const text = (value: string): void => {
    if (skipDepth > 0) return;

    if (pre !== undefined) {
      pre.text += value;

      return;
    }

    const inCode = spans.at(-1)?.kind === "code";
    const core = value.trim().replace(/\s+/g, " ");
    const spaceBefore = (pendingSpace || /^\s/.test(value)) && !afterMarker;

    if (core === "") {
      if (/\s/.test(value)) pendingSpace = true;

      return;
    }

    const body = inCode ? core : escapeText(core, atLineStart() && spans.length === 0);

    put(spaceBefore ? ` ${body}` : body);
    afterMarker = false;
    pendingSpace = /\s$/.test(value);
  };

  const endPre = (): void => {
    if (pre === undefined) return;

    const code = pre.text.replace(/^\n/, "").replace(/\n$/, "");
    const fence = fenceFor(code);

    breakBefore(2);
    write(`${fence}${pre.language}`);

    for (const line of code.split("\n")) {
      breakBefore(1);
      write(line);
    }

    breakBefore(1);
    write(fence);
    breakBefore(2);
    pre = undefined;
  };

  const open = (name: string, attributes: Readonly<Record<string, string>>): void => {
    if (pre !== undefined) {
      if (name === "br") pre.text += "\n";
      else if (name === "code" && pre.language === "") {
        pre.language =
          /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attributes.class ?? "")?.[1] ?? "";
      }

      return;
    }

    const level = HEADING.exec(name)?.[1];

    if (level !== undefined && spans.length === 0) {
      breakBefore(2);
      write(`${"#".repeat(Number(level))} `);
      headingDepth++;
      pendingSpace = false;
      afterMarker = true;

      return;
    }

    switch (name) {
      case "br":
        if (spans.length > 0 || headingDepth > 0) pendingSpace = true;
        else if (lineOpen) {
          out.push("  \n");
          lineOpen = false;
        }

        pendingSpace = false;

        return;
      case "hr":
        if (spans.length === 0) {
          breakBefore(2);
          write("---");
          breakBefore(2);
        }

        return;
      case "img": {
        const source = attributes.src ?? "";

        if (source !== "" && !source.startsWith("data:")) {
          const alt = (attributes.alt ?? "").replace(/\s+/g, " ").trim().replace(/[[\]]/g, "\\$&");

          put(`${pendingSpace ? " " : ""}![${alt}](${destination(source)})`);
          pendingSpace = false;
        }

        return;
      }

      case "pre":
        if (spans.length === 0) pre = { text: "", language: "" };

        return;
      case "strong":
      case "b":
        openSpan({ kind: "strong" });

        return;
      case "em":
      case "i":
        openSpan({ kind: "em" });

        return;
      case "del":
      case "s":
      case "strike":
        openSpan({ kind: "del" });

        return;
      case "code":
      case "kbd":
      case "samp":
        openSpan({ kind: "code" });

        return;
      case "a": {
        const href = attributes.href ?? "";

        // A link without a usable destination is only its text; the span keeps the nesting even so.
        openSpan(
          href === "" || /^\s*javascript:/i.test(href) ? { kind: "plain" } : { kind: "link", href },
        );

        return;
      }

      case "ul":
      case "ol": {
        block(lists.length === 0 ? 2 : 1);
        lists.push(name === "ol" ? startNumber(attributes.start) : undefined);

        return;
      }

      case "li": {
        const counter = lists.at(-1);
        const marker = counter === undefined ? "- " : `${counter}. `;

        if (counter !== undefined) lists[lists.length - 1] = counter + 1;

        block(1);

        if (spans.length === 0) {
          frames.push({ marker, indent: " ".repeat(marker.length), pending: true });
        }

        return;
      }

      case "blockquote":
        block(2);

        if (spans.length === 0) frames.push({ marker: "> ", indent: "> ", pending: false });

        return;
      case "tr":
        block(1);
        rowCells.push(0);

        return;
      case "td":
      case "th": {
        const index = rowCells.at(-1);

        if (index !== undefined) {
          if (index > 0) put(" | ");

          rowCells[rowCells.length - 1] = index + 1;
          pendingSpace = false;
        }

        return;
      }

      default:
        if (PARAGRAPH_ELEMENTS.has(name)) block(2);
        else if (LINE_ELEMENTS.has(name)) block(1);
    }
  };

  const close = (name: string): void => {
    if (pre !== undefined) {
      if (name === "pre") endPre();

      return;
    }

    if (HEADING.test(name) && headingDepth > 0) {
      headingDepth--;
      breakBefore(2);

      return;
    }

    switch (name) {
      case "strong":
      case "b":
      case "em":
      case "i":
      case "del":
      case "s":
      case "strike":
      case "code":
      case "kbd":
      case "samp":
      case "a":
        closeSpan();

        return;
      case "ul":
      case "ol":
        lists.pop();
        block(lists.length === 0 ? 2 : 1);

        return;
      case "li":
        if (spans.length === 0) frames.pop();

        block(1);

        return;
      case "blockquote":
        if (spans.length === 0) frames.pop();

        block(2);

        return;
      case "tr":
        rowCells.pop();
        block(1);

        return;
      default:
        if (PARAGRAPH_ELEMENTS.has(name)) block(2);
        else if (LINE_ELEMENTS.has(name)) block(1);
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (skipDepth > 0 || UNRENDERED_ELEMENTS.has(name)) {
          skipDepth++;

          return;
        }

        open(name, attributes);
      },
      ontext: text,
      onclosetag(name) {
        if (skipDepth > 0) {
          skipDepth--;

          return;
        }

        if (!VOID_ELEMENTS.has(name)) close(name);
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();

  // A tag the page never closed leaves its span open: its text still belongs on the page.
  while (spans.length > 0) closeSpan();

  endPre();

  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
};
