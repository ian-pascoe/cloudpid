// @effect-diagnostics nodeBuiltinImport:off -- the dev.env is read back by a real bash.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAppManifest, withDevEnvValues } from "./github-app.ts";

/** What `set -a; . file` gives bash for `name`, as a deploy from a workstation loads dev.env. */
const sourced = (text: string, name: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), "dev-env-")), "dev.env");

  writeFileSync(file, text);

  return execFileSync(
    "bash",
    ["-c", `set -a; . "$1"; set +a; printf '%s' "\${${name}}"`, "-", file],
    {
      encoding: "utf8",
    },
  );
};

const KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEow'IBAAKCAQEA\nzz$HOME`x`\n-----END RSA PRIVATE KEY-----\n";

describe("the manifest the setup registers the GitHub App from", () => {
  it("is a public app named as asked, with the permissions ADR-0025 lists, no webhook, and the setup's redirect", () => {
    expect(
      githubAppManifest({
        name: "cloudpid",
        homepage: "https://pi.ianpascoe.dev",
        redirect: "http://127.0.0.1:4567/done",
      }),
    ).toEqual({
      name: "cloudpid",
      url: "https://pi.ianpascoe.dev",
      redirect_url: "http://127.0.0.1:4567/done",
      public: true,
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        workflows: "write",
        actions: "read",
        checks: "read",
        statuses: "read",
        metadata: "read",
      },
      default_events: [],
    });
  });
});

describe("the dev.env the setup writes the app's secrets into", () => {
  it("gets them at its end, each read back by bash as written, the key over its lines", () => {
    const written = withDevEnvValues("MODEL_PROXY_URL=https://api.example\n", {
      CLOUDPID_GITHUB_APP_ID: "123456",
      CLOUDPID_GITHUB_APP_PRIVATE_KEY: KEY,
    });

    expect(written.startsWith("MODEL_PROXY_URL=https://api.example\n")).toBe(true);
    expect(sourced(written, "CLOUDPID_GITHUB_APP_ID")).toBe("123456");
    expect(sourced(written, "CLOUDPID_GITHUB_APP_PRIVATE_KEY")).toBe(KEY);
    expect(sourced(written, "MODEL_PROXY_URL")).toBe("https://api.example");
  });

  it("replaces the values it had, a key over several lines included, and keeps every other line", () => {
    const before = withDevEnvValues("A=1\n# a note\n", {
      CLOUDPID_GITHUB_APP_ID: "1",
      CLOUDPID_GITHUB_APP_PRIVATE_KEY: KEY,
    });

    const after = withDevEnvValues(`${before}B=2`, {
      CLOUDPID_GITHUB_APP_ID: "2",
      CLOUDPID_GITHUB_APP_PRIVATE_KEY: "new key",
    });

    expect(after).toBe(
      "A=1\n# a note\nCLOUDPID_GITHUB_APP_ID='2'\nCLOUDPID_GITHUB_APP_PRIVATE_KEY='new key'\nB=2\n",
    );
  });
});
