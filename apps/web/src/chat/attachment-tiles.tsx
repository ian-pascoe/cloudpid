// The composer's Attachments, above its input: a picture as a 64 px thumbnail, any other file as a row with its name and
// size; each with its upload's progress and a labelled remove button, which takes a 44 px touch. A tile that has
// something to say (the upload failed, the picture goes as a file only, a GIF goes as a still) widens to say it.

import * as Arr from "effect/Array";
import { AlertCircle, FileText, Image as ImageIcon, ImageOff, X } from "lucide-react";
import { useAtom } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { cn } from "../lib/utils.ts";
import { formatSize } from "./attachments.ts";
import type { Fit } from "./image-budget.ts";
import type { AttachmentItem } from "./attachments-state.ts";

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
        className="h-full bg-muted-foreground motion-safe:transition-[width] motion-safe:duration-150"
        style={{ width: `${Math.max(item.progress, 0.04) * 100}%` }}
      />
    </div>
  ) : null;

/**
 * What the tile says besides the name: why it failed, why its picture goes as a file, that a GIF goes without its
 * animation, else its size.
 */
const noteOf = (item: AttachmentItem, fit: Fit | undefined) => {
  if (item.status === "failed") {
    return { tone: "error", text: item.error ?? "It did not upload." } as const;
  }

  if (fit?.kind === "file") return { tone: "info", text: fit.reason } as const;

  if (
    item.file.type === "image/gif" &&
    fit?.kind === "inline" &&
    fit.encoded.mimeType !== "image/gif"
  ) {
    return { tone: "info", text: "Too big to animate; the model sees a still." } as const;
  }

  return undefined;
};

type TileProps = {
  item: AttachmentItem;
  fit: Fit | undefined;
  onRemove: (id: string) => void;
};

/** Whether the browser could not show a tile's picture. */
const Unshown = ScopedAtom.make(() => Atom.make(false));

const Tile = ({ item, fit, onRemove }: TileProps) => {
  const note = noteOf(item, fit);
  // The name the message will use: the stored one, once the Workspace has suffixed it.
  const name = item.stored?.name ?? item.name;
  // A picture the browser cannot show (a HEIC elsewhere than Safari, a corrupt file) gets a file's icon instead.
  const [unshown, setUnshown] = useAtom(Unshown.use());
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
            // The progress bar says how far an upload is; its share here would be read out at every step.
            <p
              aria-hidden={item.status === "uploading"}
              className="text-xs text-muted-foreground tabular"
            >
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
      {/* A 44 px button around the 20 px circle it shows; a fine pointer hits the circle only. */}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        onClick={() => {
          onRemove(item.id);
        }}
        className={cn(
          "group absolute z-10 inline-flex size-11 items-center justify-center text-muted-foreground outline-none pointer-fine:pointer-events-none",
          thumbnailOnly ? "-top-[18px] -right-[18px]" : "-top-1.5 -right-1.5",
        )}
      >
        <span className="pointer-events-auto inline-flex size-5 items-center justify-center rounded-full border bg-background transition-colors group-hover:bg-accent group-hover:text-accent-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
          <X className="size-3" aria-hidden />
        </span>
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
    <ul
      aria-label="Attachments"
      aria-live="polite"
      aria-relevant="additions"
      className="flex flex-wrap gap-2 px-2.5 pt-2.5"
    >
      {Arr.map(items, (item) => (
        <Unshown.Provider key={item.id}>
          <Tile item={item} fit={fits.get(item.id)} onRemove={onRemove} />
        </Unshown.Provider>
      ))}
    </ul>
  );
