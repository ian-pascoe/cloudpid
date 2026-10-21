// The `bash` tool's backend argument, through a real Harness with a scripted model: the call reaches the environment's
// Worker Shell or Container as asked, and the model's description of the two is what tells it which to pick.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { describe, expect, it } from "vitest";
import { type BackendCall, openCodingHarness } from "./coding-tools.fixture.ts";
import { fakeImage, fakeImages } from "./images.fixture.ts";
import { MAX_IMAGE_CHARACTERS, MAX_IMAGE_FILE_BYTES } from "./images.ts";

describe("bash", () => {
  it.each([
    ["cat README.md", "worker"],
    ["grep -rn TODO src | head", "worker"],
    ["git status", "worker"],
    ["node script.js", "container"],
    ["npm test", "container"],
    ["gh pr list", "container"],
    ["cat a.txt && npm test", "container"],
  ] as const)(
    "routes `%s` to the %s backend when no backend is asked for",
    async (command, backend) => {
      const { call, calls } = await openCodingHarness({ backends: true });

      expect(await call("bash", { command })).toEqual({
        text: `${backend}: ${command}`,
        isError: false,
      });
      expect(calls).toEqual<BackendCall[]>([{ backend, command }]);
    },
  );

  it("runs an explicit backend whatever the command is", async () => {
    const { call, calls } = await openCodingHarness({ backends: true });

    await call("bash", { command: "npm test", backend: "worker" });
    await call("bash", { command: "cat README.md", backend: "container" });

    expect(calls).toEqual<BackendCall[]>([
      { backend: "worker", command: "npm test" },
      { backend: "container", command: "cat README.md" },
    ]);
  });

  it("runs on the environment itself when it has no backends, whatever the command is", async () => {
    const { call, calls } = await openCodingHarness({ backends: false });

    expect(await call("bash", { command: "node -v" })).toEqual({
      text: "default: node -v",
      isError: false,
    });
    expect(calls).toEqual<BackendCall[]>([{ backend: undefined, command: "node -v" }]);
  });

  it.each(["worker", "container"] as const)(
    "runs on the %s backend when asked",
    async (backend) => {
      const { call, calls } = await openCodingHarness({ backends: true });

      expect(await call("bash", { command: "uname", backend })).toEqual({
        text: `${backend}: uname`,
        isError: false,
      });
      expect(calls).toEqual<BackendCall[]>([{ backend, command: "uname" }]);
    },
  );

  it("keeps the exit status and timeout of a container call", async () => {
    const { call, calls } = await openCodingHarness({ backends: true, exitCode: 3 });

    const result = await call("bash", { command: "false", backend: "container", timeout: 5 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Command exited with code 3");
    expect(calls).toEqual<BackendCall[]>([{ backend: "container", command: "false", timeout: 5 }]);
  });

  it("refuses a backend the schema does not list, and runs nothing", async () => {
    const { call, calls } = await openCodingHarness({ backends: true });

    const result = await call("bash", { command: "ls", backend: "gpu" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("tells the model when its environment has no Container, and runs nothing", async () => {
    const { call, calls } = await openCodingHarness({ backends: false });

    const result = await call("bash", { command: "ls", backend: "container" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("container");
    expect(calls).toEqual([]);
  });

  it("still runs the default backend in an environment without backends", async () => {
    const { call, calls } = await openCodingHarness({ backends: false });

    expect(await call("bash", { command: "echo hi", backend: "worker" })).toEqual({
      text: "default: echo hi",
      isError: false,
    });
    expect(calls).toEqual<BackendCall[]>([{ backend: undefined, command: "echo hi" }]);
  });

  it("describes both backends to the model", async () => {
    const { tool } = await openCodingHarness({ backends: true });

    expect(tool("bash")?.description).toMatch(/worker/i);
    expect(tool("bash")?.description).toMatch(/container/i);
    expect(tool("bash")?.description).toMatch(/ELF|native binar/i);
    expect(tool("bash")?.description).toMatch(/automatic/i);
    expect(tool("bash")?.description).toMatch(/override|explicit/i);
    expect(JSON.stringify(tool("bash")?.parameters)).toContain("container");
  });
});

describe("read", () => {
  const PHOTO = "/workspace/photo.jpg";

  it("gives the model an image over the conversation's bound reduced to fit it, and says so", async () => {
    const { images } = fakeImages({ bytesPerPixel: () => 0.05 });

    const { call } = await openCodingHarness({
      backends: true,
      files: { [PHOTO]: fakeImage(4000, 3000, { size: 3_000_000, header: "jpeg" }) },
      images,
    });

    const result = await call("read", { path: "photo.jpg" });

    expect(result.isError).toBe(false);
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.data.length).toBeLessThanOrEqual(MAX_IMAGE_CHARACTERS);
    expect(result.text).toContain("Resized from 4000x3000 to 2000x1500");
  });

  it("leaves out an image it cannot reduce, and tells the model why", async () => {
    const { images } = fakeImages({ leastBytes: 600_000 });

    const { call } = await openCodingHarness({
      backends: true,
      files: { [PHOTO]: fakeImage(4000, 3000, { size: 3_000_000, header: "jpeg" }) },
      images,
    });

    const result = await call("read", { path: "photo.jpg" });

    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.text).toContain(
      "photo.jpg is an image (image/jpeg) that was left out: it could not be reduced to 750,000 base64 characters",
    );
  });

  it("leaves out an image when the Images binding fails, and tells the model why", async () => {
    const { images } = fakeImages({ failing: "ERROR 9422: monthly transformations exceeded" });

    const { call } = await openCodingHarness({
      backends: true,
      files: { [PHOTO]: fakeImage(4000, 3000, { size: 3_000_000, header: "jpeg" }) },
      images,
    });

    const result = await call("read", { path: "photo.jpg" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "was left out: the image service failed (ERROR 9422: monthly transformations exceeded)",
    );
  });

  it("leaves out an image file over the Images binding's input limit without reading it", async () => {
    const { images, outputs } = fakeImages();

    const { call, reads } = await openCodingHarness({
      backends: true,
      files: { [PHOTO]: fakeImage(8000, 6000, { size: 25 * 1024 * 1024, header: "jpeg" }) },
      images,
    });

    const result = await call("read", { path: "photo.jpg" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "photo.jpg is an image file of 25.0 MB, over the 20.0 MB an image may be; it was left out",
    );
    expect(reads.largest).toBeLessThan(MAX_IMAGE_FILE_BYTES);
    expect(outputs).toEqual([]);
  });

  it("offers the formats the Images binding takes, and leaves out a BMP saying how to read it", async () => {
    const { images } = fakeImages();

    const { call, tool } = await openCodingHarness({
      backends: true,
      files: { "/workspace/scan.bmp": fakeImage(800, 600, { size: 2000, header: "bmp" }) },
      images,
    });

    expect(tool("read")?.description).toContain("(jpg, png, gif, webp)");

    const result = await call("read", { path: "scan.bmp" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "scan.bmp is an image (image/bmp) that was left out: BMP images are not supported; convert it to PNG first and read that.",
    );
  });

  it("says when an image was only re-encoded to fit", async () => {
    // 1.5 megapixels: 600 KB (800,000 base64 characters) at quality 80, 450 KB at 60.
    const { images } = fakeImages({ bytesPerPixel: (quality) => quality / 200 });

    const { call } = await openCodingHarness({
      backends: true,
      files: { [PHOTO]: fakeImage(1500, 1000, { size: 1_000_000, header: "jpeg" }) },
      images,
    });

    const result = await call("read", { path: "photo.jpg" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "Re-encoded at quality 60 to fit the conversation's limit of 750,000 base64 characters.",
    );
  });
});
