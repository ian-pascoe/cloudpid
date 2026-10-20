// Ported from @ian-pascoe/pi-web-tools (`extractTextFromHtml` in `src/web-fetch.ts`, MIT, © 2026 Ian Pascoe; see
// ../../NOTICE.md). The native array and string methods of its parse loop stay as they are.
// @effect-diagnostics preferEffectArray:off
import { Parser } from "htmlparser2";

/** Block elements that end the current line and separate a following block with a blank line. */
export const PARAGRAPH_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "dl",
  "table",
  "figure",
  "form",
  "hr",
]);

/** Block elements that only start a new line. */
export const LINE_ELEMENTS: ReadonlySet<string> = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "li",
  "dt",
  "dd",
  "tr",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "figcaption",
  "fieldset",
  "address",
  "details",
  "summary",
  "body",
  "html",
]);

/** Elements whose content is never part of a page's text. */
export const OMITTED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
  "svg",
]);

const CELL_ELEMENTS = new Set(["td", "th"]);

/** The visible text of `html`, one line per block and a blank line between paragraphs. One linear pass. */
export const extractTextFromHtml = (html: string): string => {
  // Output is accumulated as parts and joined once; state tracks the tail so no step rescans it.
  const parts: string[] = [];
  let trailingNewlines = 0;
  let pendingSpace = false;
  let skipDepth = 0;
  let preDepth = 0;

  const emit = (value: string): void => {
    if (value.length === 0) return;

    parts.push(value);

    let newlines = 0;

    while (newlines < value.length && value[value.length - 1 - newlines] === "\n") newlines++;

    trailingNewlines = newlines === value.length ? trailingNewlines + newlines : newlines;
  };

  // Ensure the text ends with at least `newlines` line breaks, without adding to existing ones.
  const breakLine = (newlines: number): void => {
    pendingSpace = false;

    if (parts.length === 0) return;

    emit("\n".repeat(Math.max(0, newlines - trailingNewlines)));
  };

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || OMITTED_ELEMENTS.has(name)) {
        skipDepth++;

        return;
      }

      if (name === "br") {
        pendingSpace = false;

        if (parts.length > 0 && (preDepth > 0 || trailingNewlines < 2)) emit("\n");
      } else if (PARAGRAPH_ELEMENTS.has(name)) breakLine(2);
      else if (LINE_ELEMENTS.has(name)) breakLine(1);

      if (name === "pre") preDepth++;
    },
    ontext(value) {
      if (skipDepth > 0) return;

      if (preDepth > 0) {
        emit(value);

        return;
      }

      const core = value.trim().replace(/\s+/g, " ");
      const atLineStart = parts.length === 0 || trailingNewlines > 0;
      const spaceBefore = pendingSpace || /^\s/.test(value);

      if (core.length > 0) {
        emit(spaceBefore && !atLineStart ? ` ${core}` : core);
        pendingSpace = /\s$/.test(value);
      } else if (!atLineStart && /\s/.test(value)) {
        pendingSpace = true;
      }
    },
    onclosetag(name) {
      if (skipDepth > 0) {
        skipDepth--;

        return;
      }

      if (name === "pre") preDepth = Math.max(0, preDepth - 1);

      if (PARAGRAPH_ELEMENTS.has(name)) breakLine(2);
      else if (LINE_ELEMENTS.has(name)) breakLine(1);
      else if (CELL_ELEMENTS.has(name) && trailingNewlines === 0) pendingSpace = true;
    },
  });

  parser.write(html);
  parser.end();

  return parts.join("").replace(/^\n+/, "").trimEnd();
};
