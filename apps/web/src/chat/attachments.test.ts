import { describe, expect, it } from "vitest";
import {
  formatSize,
  isPictureType,
  laneText,
  outgoingMessage,
  requestedName,
} from "./attachments.ts";

const uploads = "/workspace/.cloudpid/uploads/0190f0a8-1b2c-7d3e-8f40-123456789abc";

describe("requestedName", () => {
  it("sanitises a file's name", () => {
    expect(requestedName("My Photo.png", [])).toBe("My-Photo.png");
  });

  it("names a file apart from the composer's other Attachments", () => {
    expect(requestedName("image.png", ["image.png"])).toBe("image-2.png");
    expect(requestedName("image.png", ["image.png", "image-2.png"])).toBe("image-3.png");
  });
});

describe("outgoingMessage", () => {
  it("sends text alone as it was typed", () => {
    expect(outgoingMessage("hello", [])).toEqual({ input: "hello", display: "hello" });
  });

  it("names every Attachment's path in a part after the text, and lists their names in the lanes", () => {
    expect(
      outgoingMessage("read these", [
        { name: "a.pdf", path: `${uploads}/a.pdf` },
        { name: "b.txt", path: `${uploads}/b.txt` },
      ]),
    ).toEqual({
      input: [
        { type: "text", text: "read these" },
        { type: "text", text: `@${uploads}/a.pdf\n@${uploads}/b.txt` },
      ],
      display: "read these · Attached: a.pdf, b.txt",
    });
  });

  it("sends the paths alone when nothing is typed", () => {
    expect(outgoingMessage("  ", [{ name: "a.pdf", path: `${uploads}/a.pdf` }])).toEqual({
      input: [{ type: "text", text: `@${uploads}/a.pdf` }],
      display: "Attached: a.pdf",
    });
  });

  it("puts the inline images after the text, in order, and still names their files", () => {
    const png = { mimeType: "image/png", data: "iVBO" };
    const jpeg = { mimeType: "image/jpeg", data: "/9j/" };

    expect(
      outgoingMessage("look", [
        { name: "a.png", path: `${uploads}/a.png`, inline: png },
        { name: "notes.md", path: `${uploads}/notes.md` },
        { name: "b.jpg", path: `${uploads}/b.jpg`, inline: jpeg },
      ]),
    ).toEqual({
      input: [
        { type: "text", text: "look" },
        { type: "text", text: `@${uploads}/a.png\n@${uploads}/notes.md\n@${uploads}/b.jpg` },
        { type: "image", ...png },
        { type: "image", ...jpeg },
      ],
      display: "look · Attached: a.png, notes.md, b.jpg",
    });
  });
});

describe("laneText", () => {
  it("is the typed text, with the Attachments' names when there are any", () => {
    expect(laneText("hi", [])).toBe("hi");
    expect(laneText("hi", ["a.png"])).toBe("hi · Attached: a.png");
    expect(laneText("", ["a.png"])).toBe("Attached: a.png");
  });
});

describe("formatSize", () => {
  it("reads as bytes, kilobytes or megabytes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(12_345)).toBe("12 KB");
    expect(formatSize(3_456_789)).toBe("3.3 MB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});

describe("isPictureType", () => {
  it("is a raster image the browser may decode, not a vector one", () => {
    for (const type of ["image/png", "image/jpeg", "image/heic", "image/gif", "image/avif"]) {
      expect(isPictureType(type)).toBe(true);
    }

    for (const type of ["image/svg+xml", "application/pdf", "text/plain", ""]) {
      expect(isPictureType(type)).toBe(false);
    }
  });
});
