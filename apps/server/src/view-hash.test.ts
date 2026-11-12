// docs/architecture/mcp-apps.md → The App sandbox (Origins). The hash is the first 26 characters of the unpadded lowercase
// base32 of SHA-256 over `"v1\0" + environmentId + "\0" + source + "\0" + normalizedName`.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off -- a reference implementation to check against.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { appOriginOf, viewHost } from "./view-host.ts";
import { viewHash, viewSourceOf, visualViewHash } from "./view-hash.ts";

/** An independent base32 (RFC 4648, lowercase, unpadded) of a digest, by bit string. */
const reference = (bytes: Uint8Array): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join("");

  let out = "";

  for (let at = 0; at < bits.length; at += 5) {
    out += alphabet[Number.parseInt(bits.slice(at, at + 5).padEnd(5, "0"), 2)];
  }

  return out;
};

const expected = (environment: string, source: string, name: string): string =>
  reference(createHash("sha256").update(`v1\0${environment}\0${source}\0${name}`).digest()).slice(
    0,
    26,
  );

describe("viewHash", () => {
  it("is the first 26 base32 characters of the SHA-256 the spec names", () => {
    for (const [environment, source, normalizedName] of [
      ["env-1", "owner", "linear"],
      ["env-1", "repo:ian-pascoe/cloudpid", "docs_server"],
      ["", "owner", ""],
      ["é", "owner", "ünï"],
    ] as const) {
      expect(viewHash({ environment, source, normalizedName })).toBe(
        expected(environment, source, normalizedName),
      );
    }
  });

  it("is a host label the sandbox parses, on prod and on a stage", () => {
    const hash = viewHash({ environment: "env-1", source: "owner", normalizedName: "linear" });

    expect(hash).toMatch(/^[a-z2-7]{26}$/);
    expect(appOriginOf(viewHost(hash, "prod"))).toBe("https://pi.ianpascoe.dev");
    expect(appOriginOf(viewHost(hash, "pr-1"))).toContain("cloudpid-server-pr-1");
  });

  it("separates Environments, sources and servers, and not a server's configuration", () => {
    const base = { environment: "env-1", source: "owner", normalizedName: "linear" };

    const hashes = new Set([
      viewHash(base),
      viewHash({ ...base, environment: "env-2" }),
      viewHash({ ...base, source: "repo:a/b" }),
      viewHash({ ...base, source: "repo:a/c" }),
      viewHash({ ...base, normalizedName: "linear2" }),
    ]);

    expect(hashes.size).toBe(5);
    expect(viewHash({ ...base })).toBe(viewHash(base));
  });

  it("does not let the fields run together", () => {
    expect(viewHash({ environment: "a", source: "bc", normalizedName: "d" })).not.toBe(
      viewHash({ environment: "ab", source: "c", normalizedName: "d" }),
    );
  });
});

describe("viewSourceOf", () => {
  it("names Global's and an Environment's servers owner, and a Repo's by its slug", () => {
    expect(viewSourceOf({ kind: "global" })).toBe("owner");
    expect(viewSourceOf({ kind: "environment" })).toBe("owner");

    expect(
      viewSourceOf({
        kind: "repo",
        directory: "cloudpid",
        slug: "ian-pascoe/cloudpid",
        path: ".pi/mcp.json",
      }),
    ).toBe("repo:ian-pascoe/cloudpid");
  });

  it("has none for a source this build does not know", () => {
    expect(viewSourceOf({ kind: "workspace" })).toBeUndefined();
  });
});

describe("visualViewHash (docs/architecture/visuals.md → Network and isolation: The origin)", () => {
  it("is the first 26 base32 characters of SHA-256 over the Session's ID, under a prefix of its own", () => {
    for (const session of ["s-1", "", "é"]) {
      expect(visualViewHash(session)).toBe(
        reference(createHash("sha256").update(`visual\0v1\0${session}`).digest()).slice(0, 26),
      );
    }
  });

  it("is one origin per Session, on the sandbox, and never an MCP server's", () => {
    const hash = visualViewHash("s-1");

    expect(hash).toMatch(/^[a-z2-7]{26}$/);
    expect(appOriginOf(viewHost(hash, "prod"))).toBe("https://pi.ianpascoe.dev");
    expect(visualViewHash("s-2")).not.toBe(hash);
    // No MCP server's parts make the Visual's: an MCP preimage always starts `v1\0`, a Visual's `visual\0`.
    expect(viewHash({ environment: "s-1", source: "", normalizedName: "" })).not.toBe(hash);
    expect(viewHash({ environment: "visual", source: "v1", normalizedName: "s-1" })).not.toBe(hash);
  });
});
