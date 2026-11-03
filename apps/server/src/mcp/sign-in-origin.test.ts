// The origin a sign-in starts on (`docs/architecture/mcp-sign-in.md` → The client document and the callback outside Access).
import { describe, expect, it } from "vitest";
import { callbackUrl, clientDocumentUrl, LOCAL_ORIGINS, signInOrigin } from "./sign-in-origin.ts";

const DEPLOYED = "https://cloudpid-server-pr-450.ian-g-pascoe.workers.dev";

describe("a live stage", () => {
  it("starts on its deploy-time origin, whatever Host says", () => {
    expect(signInOrigin({ deployedOrigin: DEPLOYED, localMode: false, host: "evil.example" })).toBe(
      DEPLOYED,
    );
    expect(signInOrigin({ deployedOrigin: DEPLOYED, localMode: false, host: undefined })).toBe(
      DEPLOYED,
    );
  });

  it.each([undefined, ""])(
    "refuses to start without an origin (%j), even with a good Host",
    (origin) => {
      expect(
        signInOrigin({ deployedOrigin: origin, localMode: false, host: "localhost:1337" }),
      ).toBe(undefined);
    },
  );
});

describe("alchemy dev", () => {
  it.each(LOCAL_ORIGINS)("starts on %s when Host names it", (origin) => {
    expect(
      signInOrigin({ deployedOrigin: undefined, localMode: true, host: new URL(origin).host }),
    ).toBe(origin);
  });

  it("reads Host case-insensitively", () => {
    expect(
      signInOrigin({ deployedOrigin: undefined, localMode: true, host: "LOCALHOST:5173" }),
    ).toBe("http://localhost:5173");
  });

  it.each([
    undefined,
    "",
    "localhost",
    "localhost:3000",
    "evil.example",
    "localhost:1337.evil.example",
    "127.0.0.1:1337",
  ])("answers nothing for Host %j", (host) => {
    expect(signInOrigin({ deployedOrigin: DEPLOYED, localMode: true, host })).toBe(undefined);
  });
});

describe("the URLs under an origin", () => {
  it("are the client document and the callback", () => {
    expect(clientDocumentUrl(DEPLOYED)).toBe(`${DEPLOYED}/oauth/mcp/client.json`);
    expect(callbackUrl(DEPLOYED)).toBe(`${DEPLOYED}/oauth/mcp/callback`);
  });
});
