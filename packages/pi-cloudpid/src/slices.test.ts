// @effect-diagnostics *:off -- a test, on the owner's machine, not Effect code.
import { describe, expect, it } from "vitest";
import { fileBytes, sha256Hex, type Slice, sliceAt } from "./slices.ts";

/** Every slice of `bytes` of at most `max` bytes, as the upload cuts them. */
const sliced = (bytes: Uint8Array, max: number): ReadonlyArray<Slice> => {
  const slices: Array<Slice> = [];

  for (let offset = 0; ;) {
    const slice = sliceAt(bytes, offset, max);

    if (slice === undefined) return slices;

    slices.push(slice);
    offset += slice.bytes;
  }
};

const MIXED = `{"a":"x"}\n{"text":"héllo wörld ✓ 日本語 🎉 end"}\n{"emoji":"👩‍👩‍👧‍👦"}\n`;

describe("sliceAt", () => {
  it("is one slice when the file fits", () => {
    const bytes = fileBytes("abc\n");

    expect(sliced(bytes, 100)).toEqual([{ offset: 0, data: "abc\n", bytes: 4 }]);
  });

  it("is none for an empty file, or at its end", () => {
    expect(sliceAt(fileBytes(""), 0, 10)).toBeUndefined();
    expect(sliceAt(fileBytes("ab"), 2, 10)).toBeUndefined();
  });

  it.each([4, 5, 7, 8, 13, 64])(
    "cuts at character boundaries, at most %i bytes, and loses nothing",
    (max) => {
      const bytes = fileBytes(MIXED);
      const slices = sliced(bytes, max);

      expect(slices.length).toBeGreaterThan(1);

      for (const slice of slices) {
        expect(slice.bytes).toBeLessThanOrEqual(max);
        // The slice is whole characters: its bytes are its own text's.
        expect(fileBytes(slice.data).length).toBe(slice.bytes);
      }

      // Each starts where the last ended, and together they are the file.
      expect(slices.map((slice) => slice.offset)).toEqual(
        slices.map((_slice, index) =>
          slices.slice(0, index).reduce((sum, slice) => sum + slice.bytes, 0),
        ),
      );
      expect(slices.map((slice) => slice.data).join("")).toBe(MIXED);
      expect(sha256Hex(fileBytes(slices.map((slice) => slice.data).join("")))).toBe(
        sha256Hex(bytes),
      );
    },
  );

  it("backs a cut off a character it would split", () => {
    // "é" is two bytes: a 2-byte slice of "aé" holds the "a" alone, then the "é".
    expect(sliced(fileBytes("aé"), 2).map((slice) => slice.data)).toEqual(["a", "é"]);
    // "✓" is three, "🎉" four.
    expect(sliced(fileBytes("✓🎉"), 4).map((slice) => slice.data)).toEqual(["✓", "🎉"]);
  });

  it("starts a slice at an offset the endpoint names, as a resume does", () => {
    const bytes = fileBytes("héllo");

    expect(sliceAt(bytes, 3, 100)).toEqual({ offset: 3, data: "llo", bytes: 3 });
  });

  it("keeps a byte order mark that the file begins with", () => {
    expect(sliceAt(fileBytes("\uFEFFabc"), 0, 100)?.data).toBe("\uFEFFabc");
  });

  it("refuses an offset inside a character and a max too small for one", () => {
    expect(() => sliceAt(fileBytes("é"), 1, 10)).toThrow(/inside a character/);
    expect(() => sliceAt(fileBytes("🎉"), 0, 3)).toThrow(/no whole character/);
  });
});

describe("sha256Hex", () => {
  it("is the lowercase hex digest of the bytes", () => {
    expect(sha256Hex(fileBytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
