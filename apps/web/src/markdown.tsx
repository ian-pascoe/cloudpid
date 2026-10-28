// Markdown as the web app draws it (the transcript's messages and a Skill's SKILL.md; docs/architecture/client-and-protocol.md
// → Skill page): which URLs it loads, how its blocks look, and the renderer of a text that is not a message.

import { type Components, defaultRemarkPlugins, Streamdown } from "streamdown";
import * as Record from "effect/Record";
import { cn } from "./lib/utils.ts";

/**
 * Images are not loaded: the page would fetch whatever URL the markdown (the model's, or text it read from a tool)
 * names, which tells that host the reader's address and when the page was open. Streamdown shows a blocked image as a
 * placeholder.
 */
export const NO_IMAGES = { allowedImagePrefixes: [], allowDataImages: false };

/** How markdown's blocks look in the transcript, on whatever background `code` is the muted one of `codeSurface`. */
export const markdownClass = (codeSurface: string) =>
  cn(
    "max-w-none leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[0.8125rem] [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.85em] [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:underline [&_a]:underline-offset-2 [&_h1]:mt-6 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold",
    codeSurface,
  );

/** The part of a markdown tree `relativeLinksTo` walks. */
interface MarkdownNode {
  readonly type: string;
  url?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

/**
 * A remark plugin that makes the links of a markdown text that lives in a repo absolute against `base` (where the text is
 * on GitHub), as a SKILL.md writes them relative to itself. An anchor in the text stays one, and so does a URL that is
 * complete. It runs before the sanitizing, which blocks a relative URL. It rewrites markdown links and definitions only:
 * a link written as raw HTML is not in the markdown tree. A path-relative one (`<a href="docs/x.md">`) the sanitizing
 * shows as plain text, "[blocked]", rather than as a link; a root-relative one (`<a href="/settings">`) stays a link into
 * cloudpid itself.
 */
export const relativeLinksTo = (base: string) => () => {
  const visit = (node: MarkdownNode) => {
    if ((node.type === "link" || node.type === "definition") && node.url !== undefined) {
      if (!node.url.startsWith("#")) {
        try {
          node.url = new URL(node.url, base).toString();
        } catch {
          // A URL that cannot be one stays as it is, for the sanitizing to refuse.
        }
      }
    }

    for (const child of node.children ?? []) visit(child);
  };

  return visit;
};

const DEFAULT_REMARK_PLUGINS = Record.values(defaultRemarkPlugins);

const COMPONENTS: Components = {
  img: ({ alt }) => <span className="text-muted-foreground">{String(alt ?? "")}</span>,
};

/**
 * A whole markdown text, not one being written (a repo's SKILL.md). Its images are not loaded (their alt text shows),
 * raw HTML is sanitized as in the transcript, and a link to another file of the repo, which a SKILL.md writes relative
 * to itself, goes to that file on GitHub when `base` (the folder's URL there, ending in `/`) is given.
 */
export const StaticMarkdown = ({
  text,
  base,
  className,
}: {
  text: string;
  base?: string | undefined;
  className?: string | undefined;
}) => (
  <Streamdown
    mode="static"
    components={COMPONENTS}
    remarkPlugins={
      base === undefined
        ? DEFAULT_REMARK_PLUGINS
        : [...DEFAULT_REMARK_PLUGINS, relativeLinksTo(base)]
    }
    className={cn(
      "text-[0.9375rem] break-words",
      markdownClass("[&_pre]:bg-muted [&_code:not(pre_code)]:bg-muted"),
      className,
    )}
  >
    {text}
  </Streamdown>
);
