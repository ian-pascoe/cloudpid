import { describe, expect, it } from "vite-plus/test";
import { isOwnHost } from "./own-hosts.ts";

describe("cloudpid's own hosts", () => {
  it.each([
    "pi.ianpascoe.dev",
    "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev",
    "ianpascoe.app",
    "abcdefghijklmnopqrstuvwxyz.ianpascoe.app",
    "abcdefghijklmnopqrstuvwxyz--dev.ianpascoe.app",
  ])("%s is one", (host) => {
    expect(isOwnHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "ianpascoe.dev",
    "evil-pi.ianpascoe.dev",
    "x.pi.ianpascoe.dev",
    "ianpascoe.app.example.com",
    "notianpascoe.app",
    "my-mcp.ian-g-pascoe.workers.dev",
    "cloudpid-server-dev.other.workers.dev",
    "a.cloudpid-server-dev.ian-g-pascoe.workers.dev",
  ])("%s is not", (host) => {
    expect(isOwnHost(host)).toBe(false);
  });
});
