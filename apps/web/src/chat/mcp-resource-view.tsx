// What a tool call's card draws for the resources its result names or holds (`docs/architecture/mcp-in-a-session.md` →
// Resource links and embedded resources): a chip for each, and the preview of the one the owner opened. The model is
// `mcp-resources.ts`; the live read of a link, which needs the Session, is `mcp-resource-live.tsx`, handed in as `Live`
// so that opening the preview of a resource whose data the transcript holds reads nothing at all.
// @effect-diagnostics globalTimers:off -- the object URL of a download is released a tick after its click, in an event handler.
import { Download, FileText, Image as ImageIcon, Link2, Package } from "lucide-react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { useState } from "react";
import type { ReactNode } from "react";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { markdownClass } from "../markdown.tsx";
import {
  chipLabel,
  downloadBytes,
  type Held,
  needsRead,
  type Preview,
  previewOf,
  type Read,
  safeContentType,
  safeFilename,
  type ShownResource,
  unavailableNote,
} from "./mcp-resources.ts";

/** A resource's size as the chip says it: `512 B`, `3.4 KB`, `1.5 MB`. */
const sizeText = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Streamdown's rehype plugins but `raw`, which is what turns a tag in the text into an element. */
const RESOURCE_REHYPE_PLUGINS = Record.values(Record.remove(defaultRehypePlugins, "raw"));

/**
 * Markdown with no raw HTML: the plugins are Streamdown's sanitizer and URL hardening, without `rehype-raw`, so a tag in
 * the text is shown as the text it is and never becomes an element. Images are not loaded (their alt text shows) and a
 * link to a URL that is not safe is blocked, as in the transcript.
 */
export const ResourceMarkdown = ({ text }: { text: string }) => (
  <Streamdown
    mode="static"
    skipHtml
    rehypePlugins={RESOURCE_REHYPE_PLUGINS}
    components={{
      img: ({ alt }) => <span className="text-muted-foreground">{String(alt ?? "")}</span>,
    }}
    className={cn(
      "text-sm break-words",
      markdownClass("[&_pre]:bg-muted [&_code:not(pre_code)]:bg-muted"),
    )}
  >
    {text}
  </Streamdown>
);

/** Saves `held` as a file the browser downloads, under a name and type chosen here, never the resource's own. */
const save = (held: Held, resource: ShownResource): void => {
  const bytes = downloadBytes(held);

  if (bytes === undefined) return;

  const type = safeContentType(
    held.kind === "blob" && held.mimeType !== "" ? held.mimeType : resource.mimeType,
  );

  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");

  link.href = url;
  link.download = safeFilename(resource.uri, resource.mimeType);
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const Note = ({ children }: { children: ReactNode }) => (
  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
    {children}
  </div>
);

/** A preview drawn: Markdown without raw HTML, escaped source, an image, or only the download. */
export const PreviewBody = ({ preview }: { preview: Preview }) => {
  switch (preview.kind) {
    case "markdown":
      return (
        <div className="max-h-96 overflow-auto rounded-md border p-3">
          <ResourceMarkdown text={preview.text} />
          {preview.cut && <CutNote />}
        </div>
      );
    case "source":
      return (
        <div>
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {preview.text}
          </pre>
          {preview.cut && <CutNote />}
        </div>
      );
    case "image":
      return (
        <img
          src={preview.src}
          alt="Preview of the resource"
          className="max-h-96 max-w-full rounded-md border"
        />
      );
    case "download":
      return (
        <Note>
          {preview.why === "size"
            ? "Too large to show here. Download it to open it."
            : "This type is not previewed. Download it to open it."}
        </Note>
      );
  }
};

const CutNote = () => (
  <div className="mt-1 text-xs text-muted-foreground">
    The first part is shown. Download it for all.
  </div>
);

/** The opened resource whose data is at hand: its preview, and Download. */
export const HeldPreview = ({ resource, held }: { resource: ShownResource; held: Held }) => (
  <div className="flex flex-col items-start gap-2">
    <PreviewBody preview={previewOf(held, resource.mimeType, resource.uri)} />
    <Button variant="outline" size="sm" onClick={() => save(held, resource)}>
      <Download aria-hidden /> Download
    </Button>
  </div>
);

/** What an opened preview shows for a read: its data, or why there is none. */
export const ReadPreview = ({ resource, read }: { resource: ShownResource; read: Read }) =>
  read.status === "held" ? (
    <HeldPreview resource={resource} held={read.held} />
  ) : (
    <Note>{unavailableNote(read.reason, read.message)}</Note>
  );

const iconOf = (resource: ShownResource) => {
  switch (resource.kind) {
    case "image":
      return ImageIcon;
    case "spill":
      return Package;
    case "text":
      return FileText;
    case "link":
      return Link2;
  }
};

/** One chip: the resource's name, and its type and size when known. */
export const Chip = ({
  resource,
  open,
  onToggle,
}: {
  resource: ShownResource;
  open: boolean;
  onToggle: () => void;
}) => {
  const Icon = iconOf(resource);

  const facts = Arr.join(
    [
      ...(resource.mimeType === undefined ? [] : [resource.mimeType]),
      ...(resource.size === undefined ? [] : [sizeText(resource.size)]),
    ],
    " · ",
  );

  return (
    <button
      type="button"
      aria-expanded={open}
      title={resource.uri}
      onClick={onToggle}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs hover:bg-accent aria-expanded:bg-accent"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium">{chipLabel(resource.uri)}</span>
      {facts !== "" && <span className="shrink-0 text-muted-foreground">{facts}</span>}
    </button>
  );
};

/**
 * The chips of a card's resources, and the preview of the one the owner opened. A resource whose data the transcript
 * holds is previewed from it; any other is handed to `Live`, the one place that reads (and that never starts a Container).
 * `initiallyOpen` is for a test, which cannot click.
 */
export const ResourceChips = ({
  resources,
  Live,
  initiallyOpen,
}: {
  resources: ReadonlyArray<ShownResource>;
  Live: (props: { resource: ShownResource }) => ReactNode;
  initiallyOpen?: number | undefined;
}) => {
  const [openIndex, setOpenIndex] = useState<number | undefined>(initiallyOpen);

  if (resources.length === 0) return null;

  const opened = openIndex === undefined ? undefined : resources[openIndex];

  return (
    <div className="my-2" data-testid="resource-chips">
      <div className="flex flex-wrap gap-1.5">
        {Arr.map(resources, (resource, index) => (
          <Chip
            key={`${index}:${resource.uri}`}
            resource={resource}
            open={openIndex === index}
            onToggle={() => setOpenIndex(openIndex === index ? undefined : index)}
          />
        ))}
      </div>
      {opened !== undefined && (
        <div className="mt-2">
          {opened.held !== undefined && !needsRead(opened) ? (
            <HeldPreview resource={opened} held={opened.held} />
          ) : (
            <Live resource={opened} />
          )}
        </div>
      )}
    </div>
  );
};
