// Attachments (`docs/spec.md` → Client and protocol → Attachments): the main Worker's `PUT` and `DELETE` of
// `/sessions/:id/attachments/:name` write a file the owner attached into the Session's Workspace, at
// `/workspace/.uploads/<session-id>/<name>`, and remove one that was not sent. Every path is made here from the Session's
// ID and a sanitised name, so nothing a client sends reaches outside that directory. The Registry's check that the
// Session exists is `serve-attachment.ts`'s, so this module loads in a Workspace test Worker without alchemy.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- the Workspace's file operations are Promise-native (ADR-0003).
import {
  attachmentPath,
  freeAttachmentName,
  MAX_ATTACHMENT_BYTES,
  sanitizeAttachmentName,
  type StoredAttachment,
  uploadsDirectory,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AttachmentRoute } from "./routes.ts";
import type { WorkspaceNamespace } from "./session/workspace.ts";

/** What an upload needs of the Session's Workspace. */
export type AttachmentFiles = {
  /** The names in `directory`; none when it is not there yet. */
  readonly names: (directory: string) => Promise<ReadonlySet<string>>;
  /** Write `bytes` to `path`, making its directory. */
  readonly write: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Remove the file at `path`; nothing when it is not there. */
  readonly remove: (path: string) => Promise<void>;
};

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The files of Workspace `slug`, through its Workspace DO's file operations, as the Session's environment reaches them. */
export const workspaceAttachmentFiles = (
  namespace: WorkspaceNamespace,
  slug: string,
): AttachmentFiles => {
  const env = async () => {
    const { ComputerExecutionEnv } = await computer();

    // The id the Session's environment has, so both see the same files.
    return new ComputerExecutionEnv({
      workspace: namespace.getByName(slug),
      id: `computer:${slug}`,
      cwd: "/workspace",
    });
  };

  return {
    names: async (directory) => {
      const listed = await (await env()).listDir(directory, BACKGROUND_CONTEXT);

      if (listed.ok) return new Set(listed.value.map((entry) => entry.name));

      if (listed.error.code === "not_found") return new Set();

      throw listed.error;
    },
    write: async (path, bytes) => {
      const written = await (await env()).writeFile(path, bytes, BACKGROUND_CONTEXT);

      if (!written.ok) throw written.error;
    },
    remove: async (path) => {
      const removed = await (await env()).remove(path, { force: true }, BACKGROUND_CONTEXT);

      if (!removed.ok) throw removed.error;
    },
  };
};

/** The request's body, or undefined once it is over `limit` bytes (by its length header, or as it is read). */
const readCapped = async (request: Request, limit: number): Promise<Uint8Array | undefined> => {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);

  if (Number.isFinite(declared) && declared > limit) return undefined;

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

const TOO_BIG = `An attachment is at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;

const failure = (cause: unknown) =>
  new Response(
    `The workspace could not store it: ${cause instanceof Error ? cause.message : String(cause)}`,
    { status: 502 },
  );

/**
 * Answer an upload or a removal of Attachment `route.name` of Session `route.sessionId` in `files`: a `PUT` stores the
 * body (at most `MAX_ATTACHMENT_BYTES`, else 413) under the sanitised name, suffixed `-2`, `-3`, … when taken, and
 * answers 201 with the name and path it got; a `DELETE` removes it and answers 204. Two uploads of one name at the same
 * moment could both find it free, the later write winning: the web app names its own uploads apart, so only two pages
 * uploading the same name at once could meet that.
 */
export const answerAttachment = async (
  request: Request,
  route: AttachmentRoute,
  files: AttachmentFiles,
): Promise<Response> => {
  if (route.name === undefined) return new Response("Unreadable name", { status: 400 });

  const name = sanitizeAttachmentName(route.name);

  if (route.method === "DELETE") {
    try {
      await files.remove(attachmentPath(route.sessionId, name));
    } catch (cause) {
      return failure(cause);
    }

    return new Response(null, { status: 204 });
  }

  const bytes = await readCapped(request, MAX_ATTACHMENT_BYTES);

  if (bytes === undefined) return new Response(TOO_BIG, { status: 413 });

  try {
    const stored = freeAttachmentName(name, await files.names(uploadsDirectory(route.sessionId)));
    const path = attachmentPath(route.sessionId, stored);

    await files.write(path, bytes);

    return Response.json({ name: stored, path } satisfies StoredAttachment, { status: 201 });
  } catch (cause) {
    return failure(cause);
  }
};
