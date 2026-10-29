// `read` of an image over the conversation's bound, through a Session on a real Workspace and the Images binding (which
// miniflare emulates with sharp): the image the model gets is held to the conversation's bound, the result says it was
// reduced, and the Session keeps running (docs/architecture/workspace.md → Filesystem and tools). One image this size
// stays within the 8 MiB a row holds (workerd#7493), so the sizes are what is checked, not a failure the bound
// prevents. workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { MAX_IMAGE_CHARACTERS } from "@cloudpid/extensions/images";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { call, uniqueWorkspace } from "./session.workerd.helpers.ts";

/** The CRC-32 of `bytes`, as PNG chunks carry it. */
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typed = new Uint8Array(4 + data.length);

  typed.set(new TextEncoder().encode(type));
  typed.set(data, 4);

  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));

  return out;
};

/** A `size` x `size` RGB PNG of noise, which does not compress: about 3 bytes a pixel. */
const noisyPng = async (size: number): Promise<Uint8Array> => {
  const rows = new Uint8Array(size * (1 + size * 3));
  let seed = 0x2545f491;

  for (let index = 0; index < rows.length; index++) {
    // xorshift32; each row's first byte is its filter type, 0.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    rows[index] = index % (1 + size * 3) === 0 ? 0 : seed & 0xff;
  }

  const compressed = new Uint8Array(
    await new Response(
      new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);

  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8);

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];

  return new Uint8Array(await new Blob(parts).arrayBuffer());
};

describe("a Session's read of a large image", () => {
  it("gives the model the image reduced to the bound, says so, and keeps running", async () => {
    const slug = uniqueWorkspace();
    const png = await noisyPng(1000);

    // Far over `MAX_IMAGE_CHARACTERS`, as base64 and as bytes.
    expect(png.byteLength).toBeGreaterThan(2_900_000);

    const workspace = new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName(slug),
      id: `computer:${slug}`,
      cwd: "/workspace",
    });

    getOrThrow(await workspace.writeFile("/workspace/noise.png", png, BACKGROUND_CONTEXT));

    const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

    await runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug);
      instance.script([
        call("read", { path: "noise.png" }),
        call("bash", { command: "echo still here", backend: "worker" }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      const [read, bash] = await instance.toolResults();

      expect(read).toContain("Resized from 1000x1000 to");
      expect(read).toContain("Converted from image/png to image/webp.");
      expect(bash).toBe("still here\n");

      const images = await instance.toolResultImages();

      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe("image/webp");
      expect(images[0]?.characters).toBeLessThanOrEqual(MAX_IMAGE_CHARACTERS);
      expect(instance.longestHarnessRow()).toBeLessThan(1_000_000);
    });
  });
});
