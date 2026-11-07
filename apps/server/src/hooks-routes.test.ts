import { describe, expect, it } from "vitest";
import { HOOKS_ROUTE_TEMPLATE } from "./hooks-path.ts";
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
    ["a trailing slash on the bare prefix", "/hooks/"],
    ["an id with no token", `/hooks/${id}`],
    ["a trailing slash", `/hooks/${id}/${token}/`],
    ["a sub-path", `/hooks/${id}/${token}/x`],
    ["a short token", `/hooks/${id}/${token.slice(1)}`],
    ["a long token", `/hooks/${id}/${token}x`],
    ["a token with a character outside base64url", `/hooks/${id}/${token.slice(1)}+`],
    ["an id that is no UUIDv7", `/hooks/0190f0a8-1b2c-4d3e-8f40-123456789abc/${token}`],
    ["an id in capitals", `/hooks/${id.toUpperCase()}/${token}`],
    ["another capitalisation of the prefix", `/Hooks/${id}/${token}`],
    ["all capitals", `/HOOKS/${id}/${token}`],
    ["a doubled slash", `//hooks/${id}/${token}`],
    ["a doubled slash inside", `/hooks//${id}/${token}`],
    ["a dot segment", `/hooks/./${id}/${token}`],
    ["a parent segment", `/hooks/x/../${id}/${token}`],
    ["an escaped slash", `/hooks%2f${id}/${token}`],
    ["an escaped letter", `/hook%73/${id}/${token}`],
    ["a double-escaped slash", `/hooks%252f${id}/${token}`],
    ["a path parameter", `/hooks;x=1/${id}/${token}`],
    ["a backslash", `/hooks\\${id}\\${token}`],
    ["an unrelated path", "/hooks/anything"],
  ])("refuses %s", (_, path) => {
    expect(hooksRoute(path)).toEqual({ kind: "refused" });
  });
});

describe("the route template", () => {
  it("names neither the id nor the token", () => {
    expect(HOOKS_ROUTE_TEMPLATE).toBe("/hooks/:id/:token");
  });
});
