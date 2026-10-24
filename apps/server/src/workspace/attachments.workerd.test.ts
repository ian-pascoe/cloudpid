// The Attachments route over a real Workspace DO: where an upload lands, that a name cannot leave the Session's
// `.cloudpid/uploads` directory, suffixing, removal and the size limit (`docs/spec.md` → Client and protocol → Attachments).
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { MAX_ATTACHMENT_BYTES } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env } from "cloudflare:workers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe, expect, it } from "vitest";
import { answerAttachment, workspaceAttachmentFiles } from "../attachments.ts";
import { attachmentRoute } from "../routes.ts";
import type { WorkspaceNamespace } from "../session/workspace.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const uploads = `/workspace/.cloudpid/uploads/${session}`;

/** The Workspace DO namespace, as the Server Worker reaches it: its stubs are what `ComputerExecutionEnv` takes. */
const namespace: WorkspaceNamespace = { getByName: (slug) => env.WORKSPACES.getByName(slug) };

let workspaces = 0;

/** A Workspace of its own, its Attachment files, and an environment to look at what they hold. */
const fresh = () => {
  const slug = `attachments-${(workspaces += 1)}`;

  return {
    files: workspaceAttachmentFiles(namespace, slug),
    look: new ComputerExecutionEnv({
      workspace: namespace.getByName(slug),
      id: `computer:${slug}`,
      cwd: "/workspace",
    }),
  };
};

const call = async (
  files: ReturnType<typeof fresh>["files"],
  method: "PUT" | "DELETE",
  name: string,
  body?: BodyInit,
) => {
  const request = new Request(`http://worker.test/sessions/${session}/attachments/${name}`, {
    method,
    body: body ?? null,
  });

  const route = attachmentRoute(HttpServerRequest.fromWeb(request));

  if (route === undefined) throw new Error(`Not routed: ${name}`);

  return answerAttachment(request, route, files);
};

const names = async (look: ComputerExecutionEnv, directory: string) => {
  const listed = await look.listDir(directory, BACKGROUND_CONTEXT);

  return listed.ok ? listed.value.map((entry) => entry.name).sort() : listed.error.code;
};

const bytesAt = async (look: ComputerExecutionEnv, path: string) => {
  const read = await look.readBinaryFile(path, BACKGROUND_CONTEXT);

  if (!read.ok) throw read.error;

  return read.value;
};

describe("an Attachment upload to a Workspace", () => {
  it("makes the Session's uploads directory beside the read-only skills and stores the bytes there", async () => {
    const { files, look } = fresh();
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    const response = await call(files, "PUT", "photo.png", bytes);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "photo.png", path: `${uploads}/photo.png` });
    expect(await bytesAt(look, `${uploads}/photo.png`)).toEqual(bytes);
    expect(await names(look, "/workspace/.cloudpid/uploads")).toEqual([session]);
  });

  it("suffixes a name the Session already uploaded", async () => {
    const { files, look } = fresh();

    await call(files, "PUT", "image.png", "one");

    const second = await call(files, "PUT", "image.png", "two");

    expect(await second.json()).toEqual({ name: "image-2.png", path: `${uploads}/image-2.png` });
    expect(await names(look, uploads)).toEqual(["image-2.png", "image.png"]);
    expect(new TextDecoder().decode(await bytesAt(look, `${uploads}/image.png`))).toBe("one");
  });

  it("keeps a name that tries to leave the directory inside it", async () => {
    const { files, look } = fresh();

    for (const name of ["..%2F..%2Fescape", "...", "%2Fworkspace%2Fescape", "..%5C..%5Cescape"]) {
      expect((await call(files, "PUT", name, "x")).status).toBe(201);
    }

    expect(await names(look, uploads)).toEqual(
      ["attachment", "escape", "workspace-escape", "escape-2"].sort(),
    );
    expect(await names(look, "/workspace")).toEqual([".agents", ".cloudpid"]);
  });

  it("removes one that was not sent, and only it", async () => {
    const { files, look } = fresh();

    await call(files, "PUT", "a.txt", "a");
    await call(files, "PUT", "b.txt", "b");

    expect((await call(files, "DELETE", "a.txt")).status).toBe(204);
    expect((await call(files, "DELETE", "..%2Fa.txt")).status).toBe(204);
    expect(await names(look, uploads)).toEqual(["b.txt"]);
  });

  it("stores one of almost the limit, and refuses one over it without writing", async () => {
    const { files, look } = fresh();
    const near = new Uint8Array(MAX_ATTACHMENT_BYTES - 1024).fill(7);

    expect((await call(files, "PUT", "near.bin", near)).status).toBe(201);
    expect((await bytesAt(look, `${uploads}/near.bin`)).byteLength).toBe(near.byteLength);

    const over = await call(files, "PUT", "over.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1));

    expect(over.status).toBe(413);
    expect(await names(look, uploads)).toEqual(["near.bin"]);
  });
});
