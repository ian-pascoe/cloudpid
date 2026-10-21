import { describe, expect, it } from "vitest";
import {
  attachmentPath,
  attachmentRoutePath,
  freeAttachmentName,
  isInlineImageType,
  MAX_ATTACHMENT_NAME_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  sanitizeAttachmentName,
  uploadsDirectory,
} from "./attachments.ts";

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

describe("sanitizeAttachmentName", () => {
  it("keeps an ordinary file name as it is", () => {
    expect(sanitizeAttachmentName("report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentName("Screenshot_2026-10-20.png")).toBe("Screenshot_2026-10-20.png");
    expect(sanitizeAttachmentName("résumé.docx")).toBe("résumé.docx");
    expect(sanitizeAttachmentName("図面.png")).toBe("図面.png");
  });

  it("turns spaces, separators and other punctuation into single dashes", () => {
    expect(sanitizeAttachmentName("My Photo (1).jpg")).toBe("My-Photo-1.jpg");
    expect(sanitizeAttachmentName("a/b\\c.txt")).toBe("a-b-c.txt");
    expect(sanitizeAttachmentName("tab\there\nnewline.md")).toBe("tab-here-newline.md");
    expect(sanitizeAttachmentName("$(rm -rf).sh")).toBe("rm-rf.sh");
  });

  it("never leaves a name that climbs out of its directory, hides, or reads as an option", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeAttachmentName("..")).toBe("attachment");
    expect(sanitizeAttachmentName(".")).toBe("attachment");
    expect(sanitizeAttachmentName(".env")).toBe("env");
    expect(sanitizeAttachmentName("-rf")).toBe("rf");
    expect(sanitizeAttachmentName("name.")).toBe("name");
    expect(sanitizeAttachmentName("")).toBe("attachment");
    expect(sanitizeAttachmentName("///")).toBe("attachment");
  });

  it("cuts a long name to the limit, keeping its extension", () => {
    const long = `${"a".repeat(300)}.tar.gz`;
    const name = sanitizeAttachmentName(long);

    expect(Array.from(name)).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH);
    expect(name.endsWith(".gz")).toBe(true);
    expect(sanitizeAttachmentName("b".repeat(300))).toBe("b".repeat(MAX_ATTACHMENT_NAME_LENGTH));
  });

  it("cuts a name of wide characters to the byte limit, keeping its extension", () => {
    const name = sanitizeAttachmentName(`${"図".repeat(100)}.png`);

    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(
      MAX_ATTACHMENT_NAME_BYTES,
    );
    expect(name).toBe(`${"図".repeat(65)}.png`);

    const suffixed = freeAttachmentName(name, new Set([name]));

    expect(new TextEncoder().encode(suffixed).byteLength).toBeLessThanOrEqual(
      MAX_ATTACHMENT_NAME_BYTES,
    );
    expect(suffixed).toBe(`${"図".repeat(64)}-2.png`);
  });

  it("is stable: a sanitised name sanitises to itself", () => {
    for (const raw of [
      "My Photo (1).jpg",
      "../../x",
      `${"c".repeat(200)}.png`,
      ".hidden",
      `${"図".repeat(100)}.png`,
    ]) {
      const once = sanitizeAttachmentName(raw);

      expect(sanitizeAttachmentName(once)).toBe(once);
    }
  });
});

describe("freeAttachmentName", () => {
  it("keeps a name nobody has", () => {
    expect(freeAttachmentName("a.png", new Set())).toBe("a.png");
  });

  it("adds the first numeric suffix that is free, before the extension", () => {
    expect(freeAttachmentName("a.png", new Set(["a.png"]))).toBe("a-2.png");
    expect(freeAttachmentName("a.png", new Set(["a.png", "a-2.png", "a-3.png"]))).toBe("a-4.png");
    expect(freeAttachmentName("notes", new Set(["notes"]))).toBe("notes-2");
  });

  it("stays within the length limit when it adds a suffix", () => {
    const name = sanitizeAttachmentName(`${"d".repeat(200)}.txt`);
    const free = freeAttachmentName(name, new Set([name]));

    expect(Array.from(free)).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH);
    expect(free.endsWith("-2.txt")).toBe(true);
  });
});

describe("where an Attachment goes", () => {
  it("is the Session's own directory under the Workspace's .uploads", () => {
    expect(uploadsDirectory(session)).toBe(`/workspace/.uploads/${session}`);
    expect(attachmentPath(session, "a.png")).toBe(`/workspace/.uploads/${session}/a.png`);
  });

  it("is uploaded to the Session's attachments route, the name escaped as one segment", () => {
    expect(attachmentRoutePath(session, "a b/c.png")).toBe(
      `/sessions/${session}/attachments/a%20b%2Fc.png`,
    );
  });
});

describe("isInlineImageType", () => {
  it("accepts the image types every provider takes inline, and nothing else", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isInlineImageType(type)).toBe(true);
    }

    for (const type of ["image/svg+xml", "image/heic", "application/pdf", ""]) {
      expect(isInlineImageType(type)).toBe(false);
    }
  });
});
