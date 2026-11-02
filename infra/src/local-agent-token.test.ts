import { describe, expect, it } from "vitest";
import {
  formatLocalAgentToken,
  localAgentTokenFromState,
  localAgentTokenStatePath,
} from "./local-agent-token.ts";

interface Attr {
  readonly serviceTokenId?: string;
  readonly clientId?: string;
  readonly clientSecret?: { readonly __redacted__: string };
  readonly expiresAt?: string;
}

const record = (attr: Attr) =>
  JSON.stringify({
    resourceType: "Cloudflare.Access.ServiceToken",
    fqn: "Server/LocalAgentToken",
    attr,
  });

describe("the Local agent token's state path", () => {
  it.each(["prod", "pr-438", "dev_ian"])(
    "is the stack's, the stage's and the token's, for %s",
    (stage) => {
      expect(localAgentTokenStatePath(stage)).toBe(`cloudpid/${stage}/Server/LocalAgentToken`);
    },
  );
});

describe("reading the token from its state record", () => {
  const attr = {
    serviceTokenId: "id",
    clientId: "abc.access",
    clientSecret: { __redacted__: "s3cret" },
    expiresAt: "2027-01-01T00:00:00Z",
  };

  it("reads the client id, the secret (alchemy's redaction marker undone) and the expiry", () => {
    expect(localAgentTokenFromState(record(attr))).toEqual({
      clientId: "abc.access",
      clientSecret: "s3cret",
      expiresAt: "2027-01-01T00:00:00Z",
    });
  });

  it("says to deploy first when the record has no attributes", () => {
    expect(() => localAgentTokenFromState('{"status":"creating"}')).toThrow(/deploy it first/);
    expect(() => localAgentTokenFromState("null")).toThrow(/deploy it first/);
  });

  it("refuses a record with no secret, and says how to get one", () => {
    expect(() => localAgentTokenFromState(record({ clientId: "abc.access" }))).toThrow(
      /clientSecretVersion/,
    );
  });
});

describe("the script's output", () => {
  it("is the two variables /cloudpid reads, then the expiry", () => {
    expect(
      formatLocalAgentToken({
        clientId: "abc.access",
        clientSecret: "s3cret",
        expiresAt: "2027-01-01",
      }),
    ).toBe(
      "CLOUDPID_ACCESS_CLIENT_ID=abc.access\nCLOUDPID_ACCESS_CLIENT_SECRET=s3cret\n# expires 2027-01-01",
    );
  });

  it("says when the expiry is unknown", () => {
    expect(
      formatLocalAgentToken({ clientId: "a", clientSecret: "b", expiresAt: undefined }),
    ).toContain("# expires at an unknown time");
  });
});
