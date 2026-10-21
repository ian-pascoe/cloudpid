// The composer's Attachments, above its input: a picture as a 64 px thumbnail, any other file as a row with its name and
// size; each with its upload's progress and a labelled remove button. A tile that has something to say (the upload
// failed, or the picture goes as a file only) widens to say it.

// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime.

import { AlertCircle, FileText, Image as ImageIcon, ImageOff, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils.ts";
import { formatSize } from "./attachments.ts";
import type { Fit } from "./image-budget.ts";
import type { AttachmentItem } from "./use-attachments.ts";

const Progress = ({ item }: { item: AttachmentItem }) =>
  item.status === "uploading" ? (
    <div
      role="progressbar"
      aria-label={`Uploading ${item.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(item.progress * 100)}
      className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-md bg-muted"
    >
      <div
        className="h-full bg-primary motion-safe:transition-[width] motion-safe:duration-150"
        style={{ width: `${Math.max(item.progress, 0.04) * 100}%` }}
      />
    </div>
  ) : null;

/** What the tile says besides the name: why it failed, why its picture goes as a file, else its size. */
const noteOf = (item: AttachmentItem, fit: Fit | undefined) => {
  if (item.status === "failed") {
    return { tone: "error", text: item.error ?? "It did not upload." } as const;
  }

  if (fit?.kind === "file") return { tone: "info", text: fit.reason } as const;

  return undefined;
};

const Tile = ({
  item,
  fit,
  onRemove,
}: {
  item: AttachmentItem;
  fit: Fit | undefined;
  onRemove: (id: string) => void;
}) => {
  const note = noteOf(item, fit);
  // The name the message will use: the stored one, once the Workspace has suffixed it.
  const name = item.stored?.name ?? item.name;
  // A picture the browser cannot show (a HEIC elsewhere than Safari, a corrupt file) gets a file's icon instead.
  const [unshown, setUnshown] = useState(false);
  const thumbnail = item.picture && item.preview !== undefined && !unshown;
  const thumbnailOnly = thumbnail && note === undefined;
  const failed = item.status === "failed";

  return (
    <li
      className={cn(
        "relative flex h-16 max-w-full items-center rounded-md border bg-background",
        failed && "border-destructive/40",
        !thumbnailOnly && "w-72 gap-2.5 pr-8",
      )}
    >
      {thumbnail ? (
        <img
          src={item.preview}
          onError={() => {
            setUnshown(true);
          }}
          alt={thumbnailOnly ? name : ""}
          title={name}
          className={cn(
            "size-16 shrink-0 object-cover",
            thumbnailOnly ? "rounded-md" : "-my-px -ml-px rounded-l-md",
          )}
        />
      ) : (
        <span className="ml-3 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {item.picture ? (
            <ImageIcon className="size-4" aria-hidden />
          ) : (
            <FileText className="size-4" aria-hidden />
          )}
        </span>
      )}
      {!thumbnailOnly && (
        <div className="min-w-0 flex-1 py-1">
          <p className="truncate text-sm" title={name}>
            {name}
          </p>
          {note === undefined ? (
            <p className="text-xs text-muted-foreground tabular">
              {item.status === "uploading"
                ? `${Math.round(item.progress * 100)}% of ${formatSize(item.file.size)}`
                : formatSize(item.file.size)}
            </p>
          ) : (
            <p
              role={note.tone === "error" ? "alert" : undefined}
              className={cn(
                "line-clamp-2 text-xs leading-tight",
                note.tone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {note.tone === "error" ? (
                <AlertCircle className="mr-1 inline size-3 align-[-2px]" aria-hidden />
              ) : (
                <ImageOff className="mr-1 inline size-3 align-[-2px]" aria-hidden />
              )}
              {note.text}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        onClick={() => {
          onRemove(item.id);
        }}
        className={cn(
          "touch-target absolute inline-flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          thumbnailOnly ? "-top-1.5 -right-1.5" : "top-1.5 right-1.5",
        )}
      >
        <X className="size-3" aria-hidden />
      </button>
      <Progress item={item} />
    </li>
  );
};

export const AttachmentTiles = ({
  items,
  fits,
  onRemove,
}: {
  items: readonly AttachmentItem[];
  fits: ReadonlyMap<string, Fit>;
  onRemove: (id: string) => void;
}) =>
  items.length === 0 ? null : (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-2.5 pt-2.5">
      {items.map((item) => (
        <Tile key={item.id} item={item} fit={fits.get(item.id)} onRemove={onRemove} />
      ))}
    </ul>
  );
