// Uploading an Attachment to the Session's Workspace, and removing one that was not sent, over the main Worker's
// `/sessions/:id/attachments/:name` route. An upload is an `XMLHttpRequest`, the one browser API that reports how much
// of a request body has gone (`fetch` does not).

// @effect-diagnostics asyncFunction:off missingPipeableSignature:off newPromise:off extendsNativeError:off globalFetch:off -- browser code with no Effect runtime: XHR callbacks, fetch and promises are the platform here.

import { attachmentRoutePath, MAX_ATTACHMENT_BYTES, StoredAttachment } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { formatSize } from "./attachments.ts";

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredAttachment));

/** An upload under way: its result, and how to stop it. */
export type Upload = {
  readonly done: Promise<StoredAttachment>;
  readonly abort: () => void;
};

/** Why an upload was stopped by `abort`: not a failure to show. */
export class UploadAborted extends Error {}

const TOO_BIG = `An attachment is at most ${formatSize(MAX_ATTACHMENT_BYTES)}.`;

/**
 * Upload `file` as Attachment `name` of Session `sessionId`, reporting the share of it sent (0–1) to `onProgress`. The
 * result is the name and path the Workspace stored it under.
 */
export const uploadAttachment = (
  sessionId: string,
  name: string,
  file: Blob,
  onProgress: (fraction: number) => void,
): Upload => {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { done: Promise.reject(new Error(TOO_BIG)), abort: () => {} };
  }

  const request = new XMLHttpRequest();

  const done = new Promise<StoredAttachment>((resolve, reject) => {
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      const stored = request.status === 201 ? decodeStored(request.responseText) : Option.none();

      if (Option.isSome(stored)) resolve(stored.value);
      else if (request.status === 413) reject(new Error(TOO_BIG));
      else if (request.status === 404) reject(new Error("This session no longer exists."));
      else {
        reject(new Error(request.responseText.trim() || `The upload failed (${request.status}).`));
      }
    });
    request.addEventListener("error", () => {
      // A lapsed sign-in redirects the upload to Access's login, which the browser refuses to read: it fails the same way.
      reject(new Error("The upload failed. Check the connection, or reload to sign in again."));
    });
    request.addEventListener("abort", () => {
      reject(new UploadAborted("The upload was stopped"));
    });
  });

  request.open("PUT", attachmentRoutePath(sessionId, name));
  request.send(file);

  return {
    done,
    abort: () => {
      request.abort();
    },
  };
};

/** Remove Attachment `name` of Session `sessionId`, which was not sent. Best effort: a failure leaves the file. */
export const removeAttachment = async (sessionId: string, name: string): Promise<void> => {
  try {
    await fetch(attachmentRoutePath(sessionId, name), { method: "DELETE" });
  } catch {
    // The file stays in the Workspace's `.uploads`, as a sent one does.
  }
};
