import { describe, expect, it } from "vitest";
import { hooksRoute } from "./hooks-routes.ts";

const id = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const token = "A".repeat(20) + "b_-" + "9".repeat(20);

describe("hooksRoute", () => {
  it("takes the exact shape, and says the id and token as they were sent", () => {
    expect(hooksRoute(`/hooks/${id}/${token}`)).toEqual({ kind: "delivery", id, token });
  });

  it("leaves the bare /hooks, and every path that is not under it, to the guard", () => {
    for (const path of [
      "/hooks",
      "/",
      "/rpc",
      "/hooksfoo",
      "/mcp",
      "/oauth/mcp/callback",
      "/hook/x",
    ]) {
      expect(hooksRoute(path)).toBeUndefined();
    }
  });

  it.each([
    ["an id with no token", `/hooks/${id}`],
    ["a trailing slash", `/hooks/${id}/${token}/`],
    ["a short token", `/hooks/${id}/${token.slice(1)}`],
    ["a long token", `/hooks/${id}/${token}x`],
    ["an id that is no UUIDv7", `/hooks/0190f0a8-1b2c-4d3e-8f40-123456789abc/${token}`],
    ["an id in capitals", `/hooks/${id.toUpperCase()}/${token}`],
    ["an escaped slash", `/hooks%2f${id}/${token}`],
    ["a dot segment", `/hooks/./${id}/${token}`],
  ])("refuses %s", (_, path) => {
    expect(hooksRoute(path)).toEqual({ kind: "refused" });
  });
});
