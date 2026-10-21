// Uploading an Attachment to the Session's Workspace, and removing one that was not sent, over the main Worker's
// `/sessions/:id/attachments/:name` route: the `Uploads` service, so the composer's Attachments run in a test without
// a network. An upload is an `XMLHttpRequest`, the one browser API that reports how much of a request body has gone
// (neither `fetch` nor Effect's `HttpClient` does); a removal is a `DELETE` over `HttpClient`.

import { attachmentRoutePath, MAX_ATTACHMENT_BYTES, StoredAttachment } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { formatSize } from "./attachments.ts";

/** Why an upload failed, as the Attachment's tile says it. */
export class UploadError extends Schema.TaggedError<
  UploadError,
  { readonly brand: unique symbol }
>()("UploadError", { message: Schema.String }) {}

export interface UploadsApi {
  /**
   * Upload `file` as Attachment `name` of Session `sessionId`, telling `onProgress` the share of it sent (0–1) as it
   * goes: the name and path the Workspace stored it under. Interrupting it stops the upload.
   */
  readonly upload: (
    sessionId: string,
    name: string,
    file: Blob,
    onProgress: (fraction: number) => void,
  ) => Effect.Effect<StoredAttachment, UploadError>;
  /** Remove Attachment `name` of Session `sessionId`, which was not sent. Best effort: a failure leaves the file. */
  readonly remove: (sessionId: string, name: string) => Effect.Effect<void>;
}

/** Where the composer's Attachments go: the Session's Workspace. */
export class Uploads extends Context.Service<Uploads, UploadsApi>()("@cloudpid/web/chat/uploads") {}

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredAttachment));

const TOO_BIG = `An attachment is at most ${formatSize(MAX_ATTACHMENT_BYTES)}.`;

/** The upload over `XMLHttpRequest`, aborted when interrupted. */
const upload: UploadsApi["upload"] = (sessionId, name, file, onProgress) =>
  file.size > MAX_ATTACHMENT_BYTES
    ? Effect.fail(UploadError.make({ message: TOO_BIG }))
    : Effect.callback<StoredAttachment, UploadError>((resume) => {
        const request = new XMLHttpRequest();

        const fail = (message: string) => {
          resume(Effect.fail(UploadError.make({ message })));
        };

        request.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
        });
        request.addEventListener("load", () => {
          const stored =
            request.status === 201 ? decodeStored(request.responseText) : Option.none();

          if (Option.isSome(stored)) resume(Effect.succeed(stored.value));
          else if (request.status === 413) fail(TOO_BIG);
          else if (request.status === 404) fail("This session no longer exists.");
          else fail(request.responseText.trim() || `The upload failed (${request.status}).`);
        });
        request.addEventListener("error", () => {
          // A lapsed sign-in redirects the upload to Access's login, which the browser refuses to read: it fails the
          // same way.
          fail("The upload failed. Check the connection, or reload to sign in again.");
        });
        request.open("PUT", attachmentRoutePath(sessionId, name));
        request.send(file);

        return Effect.sync(() => {
          request.abort();
        });
      });

/**
 * The browser's uploads. Building it touches nothing of the page (`XMLHttpRequest` is made when an upload starts), so
 * it is safe where there is no page, as a test is.
 */
export const UploadsLive: Layer.Layer<Uploads> = Layer.effect(
  Uploads,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    return Uploads.of({
      upload,
      remove: (sessionId, name) =>
        // The file stays in the Workspace's `.uploads`, as a sent one does.
        http.del(attachmentRoutePath(sessionId, name)).pipe(Effect.ignore),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
