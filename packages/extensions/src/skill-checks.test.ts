import { describe, expect, it } from "vite-plus/test";

import { problemsIn } from "./skill-checks.ts";

// A stateless installation token (`ghs_<app id>_<JWT>`): GitHub's format for every new one since 2026-10-02.
const STATELESS =
  "ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIiLCJpbnN0YWxsYXRpb24iOjk4NzY1fQ." +
  "aB3-_x9Q".repeat(50);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("problemsIn", () => {
  it("refuses a file holding a stateless GitHub installation token", () => {
    expect(problemsIn("notes.md", bytes(`export GH_TOKEN=${STATELESS}\n`))).not.toEqual([]);
  });

  it("passes a file that only names the prefix", () => {
    expect(problemsIn("notes.md", bytes("App tokens start with ghs_.\n"))).toEqual([]);
  });
});
