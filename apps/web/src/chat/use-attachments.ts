// A composer's Attachments: each file uploads as soon as it is attached, with its progress; removing one before it is
// sent stops its upload or deletes the stored file; and the pictures among them are fitted, while the owner writes, into
// what one message may hold (`image-budget.ts`), so each tile says before sending whether its image goes inline.

// @effect-diagnostics asyncFunction:off preferEffectArray:off cryptoRandomUUID:off -- browser code in a React app with no Effect runtime: native arrays, promises and crypto are the platform here.

import type { StoredAttachment } from "@cloudpid/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPictureType, requestedName, type SentAttachment } from "./attachments.ts";
import { type Fit, fitImages } from "./image-budget.ts";
import { encodeImage, probeImage } from "./image-encode.ts";
import { removeAttachment, type Upload, UploadAborted, uploadAttachment } from "./uploads.ts";

export type AttachmentStatus = "uploading" | "uploaded" | "failed";

/** One file attached to the message being written. */
export type AttachmentItem = {
  readonly id: string;
  readonly file: File;
  /** The name it is uploaded under, apart from the composer's other Attachments. */
  readonly name: string;
  /** Whether it is a picture the model may see inline. */
  readonly picture: boolean;
  /** A link to the file, for a picture's thumbnail. */
  readonly preview: string | undefined;
  readonly status: AttachmentStatus;
  /** The share of it uploaded, 0–1. */
  readonly progress: number;
  /** Where the Workspace stored it, once uploaded. */
  readonly stored: StoredAttachment | undefined;
  /** Why it did not upload. */
  readonly error: string | undefined;
};

export type Attachments = {
  readonly items: readonly AttachmentItem[];
  /** How each picture goes, by its ID: inline, or as a file only and why. Absent while it is being prepared. */
  readonly fits: ReadonlyMap<string, Fit>;
  readonly add: (files: Iterable<File>) => void;
  /** Take one off the message: its upload is stopped, or its stored file deleted. */
  readonly remove: (id: string) => void;
  /** Why the message cannot be sent with them yet, or null once every one is uploaded and every picture fitted. */
  readonly waiting: string | null;
  /** The Attachments as the message sends them; undefined while `waiting`. */
  readonly sent: () => readonly SentAttachment[] | undefined;
  /** Forget them once the message is sent; their files stay in the Workspace. */
  readonly clear: () => void;
};

const UNREADABLE = "This browser cannot read it; it goes as a file only.";

const UNPREPARED = "The image could not be prepared for the model; it goes as a file only.";

/** The Attachments of a composer writing to Session `sessionId`. */
export const useAttachments = (sessionId: string | null): Attachments => {
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const [fits, setFits] = useState<ReadonlyMap<string, Fit>>(new Map());
  // The pictures `fits` was made for: a set that changed since is being fitted again.
  const [fitted, setFitted] = useState("");
  const current = useRef(items);
  const uploads = useRef(new Map<string, Upload>());

  current.current = items;

  const update = useCallback((id: string, change: Partial<AttachmentItem>) => {
    setItems((all) => all.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  /** Wait for `upload` of Attachment `id`, and note how it ended. */
  const settle = useCallback(
    async (id: string, upload: Upload) => {
      try {
        const stored = await upload.done;

        update(id, { status: "uploaded", progress: 1, stored });
      } catch (error) {
        if (!(error instanceof UploadAborted)) {
          update(id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        uploads.current.delete(id);
      }
    },
    [update],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      if (sessionId === null) return;

      const taken = current.current.flatMap((item) =>
        item.stored === undefined ? [item.name] : [item.name, item.stored.name],
      );

      const added: AttachmentItem[] = [];

      for (const file of files) {
        const name = requestedName(file.name, taken);
        const picture = isPictureType(file.type);

        taken.push(name);
        added.push({
          id: crypto.randomUUID(),
          file,
          name,
          picture,
          preview: picture ? URL.createObjectURL(file) : undefined,
          status: "uploading",
          progress: 0,
          stored: undefined,
          error: undefined,
        });
      }

      setItems((all) => [...all, ...added]);

      for (const item of added) {
        const upload = uploadAttachment(sessionId, item.name, item.file, (progress) => {
          update(item.id, { progress });
        });

        uploads.current.set(item.id, upload);
        void settle(item.id, upload);
      }
    },
    [sessionId, settle, update],
  );

  const remove = useCallback(
    (id: string) => {
      const item = current.current.find((candidate) => candidate.id === id);

      if (item === undefined) return;

      uploads.current.get(id)?.abort();
      uploads.current.delete(id);

      if (item.stored !== undefined && sessionId !== null) {
        void removeAttachment(sessionId, item.stored.name);
      }

      if (item.preview !== undefined) URL.revokeObjectURL(item.preview);

      setItems((all) => all.filter((candidate) => candidate.id !== id));
    },
    [sessionId],
  );

  const clear = useCallback(() => {
    for (const item of current.current) {
      if (item.preview !== undefined) URL.revokeObjectURL(item.preview);
    }

    setItems([]);
  }, []);

  // Leaving the page stops what is still uploading; what was stored stays, as a sent file does.
  useEffect(
    () => () => {
      for (const upload of uploads.current.values()) upload.abort();

      for (const item of current.current) {
        if (item.preview !== undefined) URL.revokeObjectURL(item.preview);
      }
    },
    [],
  );

  const pictures = items.flatMap((item) => (item.picture ? [item.id] : [])).join(",");

  useEffect(() => {
    let stale = false;
    const shown = current.current.filter((item) => item.picture);

    const fit = async (): Promise<ReadonlyMap<string, Fit>> => {
      const next = new Map<string, Fit>();
      const readable: AttachmentItem[] = [];

      for (const item of shown) {
        try {
          await probeImage(item.file);
          readable.push(item);
        } catch {
          next.set(item.id, { kind: "file", reason: UNREADABLE });
        }
      }

      try {
        const results = await fitImages(
          readable.map((item) => item.file),
          encodeImage,
        );

        for (const [index, item] of readable.entries()) {
          next.set(item.id, results[index] ?? { kind: "file", reason: UNPREPARED });
        }
      } catch {
        for (const item of readable) next.set(item.id, { kind: "file", reason: UNPREPARED });
      }

      return next;
    };

    void fit().then((next) => {
      if (stale) return;

      setFits(next);
      setFitted(pictures);
    });

    return () => {
      stale = true;
    };
  }, [pictures]);

  const waiting = useMemo(() => {
    if (items.some((item) => item.status === "failed")) {
      return "Remove the attachments that did not upload, then send.";
    }

    if (items.some((item) => item.status === "uploading")) {
      return "Waiting for the attachments to upload.";
    }

    return fitted === pictures ? null : "Preparing the images for the model.";
  }, [items, fitted, pictures]);

  const sent = useCallback((): readonly SentAttachment[] | undefined => {
    if (waiting !== null) return undefined;

    const message: SentAttachment[] = [];

    for (const item of items) {
      if (item.stored === undefined) return undefined;

      const fit = fits.get(item.id);

      message.push({
        name: item.stored.name,
        path: item.stored.path,
        inline: fit?.kind === "inline" ? fit.encoded : undefined,
      });
    }

    return message;
  }, [waiting, items, fits]);

  return { items, fits, add, remove, waiting, sent, clear };
};
