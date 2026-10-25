// A message's markdown as HTML, for the clipboard: what a rich editor (a document, an email) pastes as formatting. The
// transcript draws markdown with Streamdown, whose DOM is the page's (code blocks' buttons, links that ask before
// opening), so the HTML is made again from the text, in the same flavour (GitHub's). Loaded only when a message is
// copied.

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Images become their alt text, as the transcript does not load them either: a pasted `<img>` would fetch whatever URL
 * the model named. Raw HTML in the markdown is dropped (remark-rehype's default), and the rest sanitized.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    handlers: {
      image: (_state, node) => ({ type: "text", value: node.alt ?? "" }),
      imageReference: (_state, node) => ({ type: "text", value: node.alt ?? "" }),
    },
  })
  .use(rehypeSanitize)
  .use(rehypeStringify);

/** `markdown` as sanitized HTML. */
export const markdownHtml = (markdown: string): string => String(processor.processSync(markdown));
