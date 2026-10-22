// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { MAX_ATTACHMENT_BYTES } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it } from "vitest";
import { type AttachmentFiles, answerAttachment } from "./attachments.ts";
import { serveAttachment } from "./serve-attachment.ts";
import { attachmentRoute } from "./routes.ts";

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const uploads = `/workspace/.uploads/${session}`;

/** A Workspace's files in memory, keyed by path. */
const memory = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, text]));
  const decoder = new TextDecoder();

  const api: AttachmentFiles = {
    names: async (directory) =>
      new Set(
        [...files.keys()].flatMap((path) =>
          path.startsWith(`${directory}/`) ? [path.slice(directory.length + 1)] : [],
        ),
      ),
    write: async (path, bytes) => {
      files.set(path, decoder.decode(bytes));
    },
    remove: async (path) => {
      files.delete(path);
    },
  };

  return { files, api };
};

const call = async (
  method: "PUT" | "DELETE",
  name: string,
  files: AttachmentFiles,
  body?: BodyInit,
  headers?: HeadersInit,
) => {
  const url = `http://worker.test/sessions/${session}/attachments/${name}`;

  // A stream body needs `duplex`, which the DOM's `RequestInit` does not list.
  const init: RequestInit & { duplex: "half" } = {
    method,
    body: body ?? null,
    headers: headers ?? {},
    duplex: "half",
  };

  const request = new Request(url, init);
  const route = attachmentRoute(HttpServerRequest.fromWeb(request));

  if (route === undefined) throw new Error(`Not routed: ${method} ${url}`);

  return answerAttachment(request, route, files);
};

describe("an upload", () => {
  it("stores the body under the Session's .uploads and answers with its name and path", async () => {
    const workspace = memory();
    const response = await call("PUT", "notes.txt", workspace.api, "hello");

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "notes.txt", path: `${uploads}/notes.txt` });
    expect(Object.fromEntries(workspace.files)).toEqual({ [`${uploads}/notes.txt`]: "hello" });
  });

  it("suffixes a name that is taken", async () => {
    const workspace = memory({ [`${uploads}/a.png`]: "one", [`${uploads}/a-2.png`]: "two" });
    const response = await call("PUT", "a.png", workspace.api, "three");

    expect(await response.json()).toEqual({ name: "a-3.png", path: `${uploads}/a-3.png` });
    expect(workspace.files.get(`${uploads}/a.png`)).toBe("one");
  });

  it("keeps a name that tries to leave the directory inside it", async () => {
    const workspace = memory();
    const response = await call("PUT", "..%2F..%2F.bashrc", workspace.api, "x");

    expect(await response.json()).toEqual({ name: "bashrc", path: `${uploads}/bashrc` });
    expect([...workspace.files.keys()]).toEqual([`${uploads}/bashrc`]);
  });

  it("refuses a body over the limit, by its length or as it is read, and stores nothing", async () => {
    const workspace = memory();

    const declared = await call("PUT", "big.bin", workspace.api, "x", {
      "content-length": String(MAX_ATTACHMENT_BYTES + 1),
    });

    expect(declared.status).toBe(413);

    const streamed = await call(
      "PUT",
      "big.bin",
      workspace.api,
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );

    expect(streamed.status).toBe(413);
    expect(await streamed.text()).toBe("An attachment is at most 25 MB.");
    expect(workspace.files.size).toBe(0);
  });

  it("answers 400, storing nothing, for a body cut off or longer than its length says", async () => {
    const workspace = memory();

    const short = await call("PUT", "a.txt", workspace.api, "abc", { "content-length": "10" });
    const long = await call("PUT", "a.txt", workspace.api, "abc", { "content-length": "2" });

    const broken = await call(
      "PUT",
      "a.txt",
      workspace.api,
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(new Uint8Array(3));
          controller.error(new Error("the client went away"));
        },
      }),
    );

    expect([short.status, long.status, broken.status]).toEqual([400, 400, 400]);
    expect(await broken.text()).toBe("The upload was cut off.");
    expect(workspace.files.size).toBe(0);
  });

  it("stores a body that is exactly its declared length", async () => {
    const workspace = memory();
    const response = await call("PUT", "a.txt", workspace.api, "abc", { "content-length": "3" });

    expect(response.status).toBe(201);
    expect(workspace.files.get(`${uploads}/a.txt`)).toBe("abc");
  });

  it("answers 400 for a name whose escapes cannot be read", async () => {
    expect((await call("PUT", "%E0%A4%A", memory().api, "x")).status).toBe(400);
  });

  it("answers 502 with why when the Workspace cannot store it", async () => {
    const failing: AttachmentFiles = {
      ...memory().api,
      write: async () => {
        throw new Error("EROFS");
      },
    };

    const response = await call("PUT", "a.txt", failing, "x");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("EROFS");
  });
});

describe("a removal", () => {
  it("deletes the stored file, and answers 204 also when it is gone", async () => {
    const workspace = memory({ [`${uploads}/a.png`]: "one", [`${uploads}/b.png`]: "two" });

    expect((await call("DELETE", "a.png", workspace.api)).status).toBe(204);
    expect((await call("DELETE", "a.png", workspace.api)).status).toBe(204);
    expect([...workspace.files.keys()]).toEqual([`${uploads}/b.png`]);
  });
});

describe("serveAttachment", () => {
  const known = session;

  const serve = async (sessionId: string) => {
    const workspace = memory();
    const slugs: string[] = [];

    // SAFETY: `serveAttachment` calls only `getByName`, and on its result only `getSession`.
    const registries = {
      getByName: () => ({
        getSession: ({ id }: { id: string }) =>
          Effect.succeed(id === known ? { id, machine: "cloudpid" } : null),
      }),
    } as never;

    const request = HttpServerRequest.fromWeb(
      new Request(`http://worker.test/sessions/${sessionId}/attachments/a.txt`, {
        method: "PUT",
        body: "hi",
      }),
    );

    const route = attachmentRoute(request);

    if (route === undefined) throw new Error("Not routed");

    const response = await serveAttachment(
      registries,
      (slug) => {
        slugs.push(slug);

        return workspace.api;
      },
      route,
    ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.runPromise);

    return {
      status: response.status,
      body: await HttpServerResponse.toWeb(response).text(),
      slugs,
      stored: [...workspace.files.keys()],
    };
  };

  it("stores an upload in the Workspace the Session is bound to", async () => {
    expect(await serve(known)).toEqual({
      status: 201,
      body: JSON.stringify({ name: "a.txt", path: `${uploads}/a.txt` }),
      slugs: ["cloudpid"],
      stored: [`${uploads}/a.txt`],
    });
  });

  it("answers 404 for a Session the Registry does not know, and touches no Workspace", async () => {
    const unknown = "0190f0a8-1b2c-7d3e-8f40-000000000000";

    expect(await serve(unknown)).toMatchObject({ status: 404, slugs: [], stored: [] });
  });
});
