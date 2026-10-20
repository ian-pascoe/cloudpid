// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// Fetched bytes to the text a model reads: the main content of an HTML page as Markdown or plain text, JSON
// re-indented, anything else as it came. Ported from `convertHtmlPage` and `convertFetchedContent` in pi-web-tools'
// `src/web-fetch.ts` (see ../../NOTICE.md).
import * as Arr from "effect/Array";
import { extractMainContent, type HtmlMainContent } from "./html-main-content.ts";
import { escapeText, htmlToMarkdown } from "./html-markdown.ts";
import { extractTextFromHtml } from "./html-text.ts";
import { reindentJson } from "./json-reindent.ts";

/** What `web_fetch` returns the page as. */
export type WebFetchFormat = "text" | "markdown" | "html";

const CHROME_REMOVED_STEM = "Site chrome outside the main content was removed";
const CHROME_REMOVED_NOTE = `${CHROME_REMOVED_STEM}.`;

/** The note for a page whose chrome removal dropped `main`'s text, or undefined when none was dropped. */
const chromeNote = (main: HtmlMainContent): string | undefined => {
  if (main.largeRemovalPercent !== undefined) {
    return `${CHROME_REMOVED_STEM} (${main.largeRemovalPercent}% of page text); use format: html for the full page.`;
  }

  return main.chromeRemoved ? CHROME_REMOVED_NOTE : undefined;
};

const firstLine = (text: string): string => text.trimStart().split("\n", 1)[0]?.trim() ?? "";

/**
 * Convert HTML to Markdown or plain text, keeping the main content, the page title, and a note when chrome was
 * dropped. Pages without identifiable main content convert whole.
 */
export const convertHtmlPage = (html: string, format: "markdown" | "text"): string => {
  const main = extractMainContent(html);

  if (main === undefined)
    return format === "markdown" ? htmlToMarkdown(html) : extractTextFromHtml(html);

  const note = chromeNote(main);

  if (format === "text") {
    const body = extractTextFromHtml(main.html);
    const heading = firstLine(body) === main.title ? undefined : main.title;

    return Arr.join(
      Arr.filter(
        [heading, note === undefined ? undefined : `[${note}]`, body],
        (part) => part !== undefined,
      ),
      "\n\n",
    );
  }

  const body = htmlToMarkdown(main.html);
  // Escape the title as the body escapes text, so `Foo_bar` matches a `# Foo\_bar` heading.
  const title = main.title === undefined ? undefined : escapeText(main.title, false);

  const heading =
    title === undefined || firstLine(body).replace(/^#+\s*/, "") === title
      ? undefined
      : `# ${title}`;

  return Arr.join(
    Arr.filter(
      [heading, note === undefined ? undefined : `*${note}*`, body],
      (part) => part !== undefined,
    ),
    "\n\n",
  );
};

/** Types that declare JSON. Bodies of other types are never parsed as JSON, even when they would be. */
const isJsonMime = (mime: string): boolean =>
  mime === "application/json" || mime === "text/json" || mime.endsWith("+json");

/** `content` of media type `mime` as `format`. */
export const convertContent = (content: string, mime: string, format: WebFetchFormat): string => {
  if (format === "html") return content;

  if (isJsonMime(mime)) return reindentJson(content) ?? content;

  if (mime !== "text/html") return content;

  return convertHtmlPage(content, format);
};
