// A server that signs in on its own (`docs/architecture/mcp-sign-in.md` → Client Credentials, Settings): which entries do,
// and the row that says so, with no action to press.
import { describe, expect, it } from "vitest";
import { mcpClientGrantRow, MCP_CLIENT_GRANT_CHIP, signsInOnItsOwn } from "./mcp-client-grant.ts";

describe("signsInOnItsOwn", () => {
  it("is true for an HTTP entry whose grant is client_credentials, as written or as the host stores it", () => {
    expect(
      signsInOnItsOwn({
        type: "http",
        oauth: { grantType: "client_credentials", clientId: "a" },
      }),
    ).toBe(true);
    expect(signsInOnItsOwn({ oauth: { grantType: "client_credentials" } })).toBe(true);
  });

  it("is false for the code grant, for no grant, for no oauth, and for a stdio entry", () => {
    expect(signsInOnItsOwn({ type: "http", oauth: { grantType: "authorization_code" } })).toBe(
      false,
    );
    expect(signsInOnItsOwn({ type: "http", oauth: { clientId: "a" } })).toBe(false);
    expect(signsInOnItsOwn({ type: "http" })).toBe(false);
    expect(signsInOnItsOwn({ type: "http", oauth: null })).toBe(false);
    expect(signsInOnItsOwn({ type: "stdio", oauth: { grantType: "client_credentials" } })).toBe(
      false,
    );
  });
});

describe("mcpClientGrantRow", () => {
  it("says it signs in on its own, with the host of the pinned issuer, and offers nothing to press", () => {
    expect(
      mcpClientGrantRow({ grantType: "client_credentials", issuer: "https://auth.example.com/" }),
    ).toEqual({
      chip: MCP_CLIENT_GRANT_CHIP,
      issuerHost: "auth.example.com",
      text: "Signs in on its own · auth.example.com",
      actions: [],
    });
  });

  it("takes the host from authServerMetadataUrl when there is no issuer, and shows the chip alone with no pin", () => {
    expect(
      mcpClientGrantRow({
        grantType: "client_credentials",
        authServerMetadataUrl: "https://login.example.org/.well-known/oauth-authorization-server",
      }).text,
    ).toBe("Signs in on its own · login.example.org");
    expect(mcpClientGrantRow({ grantType: "client_credentials" })).toMatchObject({
      issuerHost: undefined,
      text: "Signs in on its own",
    });
  });
});
