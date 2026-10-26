import type { ChangeEntry } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { foldReason, LARGE_FILE_LINES } from "./folding.ts";

const modified = (path: string, more: Partial<ChangeEntry> = {}): ChangeEntry => ({
  path,
  status: "modified",
  additions: 3,
  deletions: 1,
  ...more,
});

describe("foldReason", () => {
  it("leaves an ordinary source file open", () => {
    expect(foldReason(modified("src/app.ts"))).toBeUndefined();
    expect(foldReason(modified("README.md"))).toBeUndefined();
  });

  it("folds lockfiles by name, wherever they are", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "apps/web/package-lock.json",
      "yarn.lock",
      "Cargo.lock",
      "go.sum",
      "Gemfile.lock",
      "poetry.lock",
      "uv.lock",
      "bun.lockb",
      "mise.lock",
    ]) {
      expect(foldReason(modified(path)), path).toBe("lockfile");
    }
  });

  it("does not take a file that only mentions a lock for one", () => {
    expect(foldReason(modified("src/lock.ts"))).toBeUndefined();
    expect(foldReason(modified("docs/yarn.lock.md"))).toBeUndefined();
  });

  it("folds generated and minified names", () => {
    for (const path of [
      "dist/app.min.js",
      "public/style.min.css",
      "dist/app.js.map",
      "api/service.pb.go",
      "api/service_pb2.py",
      "lib/model.g.dart",
      "src/workspace/bundled-skills.generated.ts",
    ]) {
      expect(foldReason(modified(path)), path).toBe("generated");
    }
  });

  it("folds files under generated, __generated__, vendor and third_party directories", () => {
    expect(foldReason(modified("src/generated/schema.ts"))).toBe("generated");
    expect(foldReason(modified("src/__generated__/graphql.ts"))).toBe("generated");
    expect(foldReason(modified("vendor/github.com/x/y.go"))).toBe("vendored");
    expect(foldReason(modified("libs/third_party/zlib/inflate.c"))).toBe("vendored");
  });

  it("goes by directories, not by a file of that name", () => {
    expect(foldReason(modified("src/vendor.ts"))).toBeUndefined();
    expect(foldReason(modified("src/generated.ts"))).toBeUndefined();
    expect(foldReason(modified("docs/vendored/notes.md"))).toBeUndefined();
  });

  it("folds what the root .gitattributes marks linguist-generated or linguist-vendored", () => {
    expect(foldReason(modified("src/schema.ts", { generated: true }))).toBe("generated");
    expect(foldReason(modified("assets/jquery.js", { vendored: true }))).toBe("vendored");
  });

  it("opens what the .gitattributes unmarks, whatever its name or directory says", () => {
    expect(foldReason(modified("src/generated/schema.ts", { generated: false }))).toBeUndefined();
    expect(foldReason(modified("app.min.js", { generated: false }))).toBeUndefined();
    expect(foldReason(modified("pnpm-lock.yaml", { generated: false }))).toBeUndefined();
    expect(foldReason(modified("vendor/lib.go", { vendored: false }))).toBeUndefined();
  });

  it("folds a file with more than 1,000 changed lines, not one with 1,000", () => {
    expect(LARGE_FILE_LINES).toBe(1000);
    expect(foldReason(modified("src/big.ts", { additions: 600, deletions: 401 }))).toBe("large");
    expect(foldReason(modified("src/big.ts", { additions: 600, deletions: 400 }))).toBeUndefined();
  });

  it("counts approximate counts too, and nothing for a file whose counts are not known", () => {
    expect(
      foldReason(modified("src/big.ts", { additions: 900, deletions: 900, approximate: true })),
    ).toBe("large");
    expect(
      foldReason(modified("image.png", { additions: null, deletions: null, binary: true })),
    ).toBeUndefined();
  });

  it("folds deleted files, before any other reason", () => {
    expect(foldReason(modified("src/old.ts", { status: "deleted" }))).toBe("deleted");
    expect(foldReason(modified("pnpm-lock.yaml", { status: "deleted" }))).toBe("deleted");
  });

  it("names a lockfile before a large file", () => {
    expect(foldReason(modified("pnpm-lock.yaml", { additions: 5000, deletions: 3000 }))).toBe(
      "lockfile",
    );
  });

  it("judges a rename by its new path", () => {
    expect(
      foldReason(modified("src/kept.ts", { status: "renamed", oldPath: "vendor/kept.ts" })),
    ).toBeUndefined();
    expect(
      foldReason(modified("vendor/moved.ts", { status: "renamed", oldPath: "src/moved.ts" })),
    ).toBe("vendored");
  });
});
