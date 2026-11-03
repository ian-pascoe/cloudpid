import { MCP_LOG_DATA_MAX, MCP_LOG_RING } from "@cloudpid/mcp/types";
import { describe, expect, it } from "vitest";
import { callLogs, secretsOf } from "./logs.ts";

const collector = (
  tokens: ReadonlySet<string> = new Set(),
  secrets: ReadonlyArray<string> = [],
) => {
  let now = 0;

  return callLogs({ now: () => ++now, tokens: () => tokens, secrets });
};

describe("callLogs", () => {
  it("keeps the last 50, oldest first", () => {
    const logs = collector();

    for (let n = 0; n < MCP_LOG_RING + 5; n++) {
      logs.hear({ level: "warning", data: `message ${n}` });
    }

    const entries = logs.entries();

    expect(entries).toHaveLength(MCP_LOG_RING);
    expect(entries[0]?.data).toBe("message 5");
    expect(entries.at(-1)?.data).toBe(`message ${MCP_LOG_RING + 4}`);
  });

  it("cuts data to 2 KiB, and keeps JSON data as JSON text", () => {
    const logs = collector();

    logs.hear({ level: "error", data: { big: "x".repeat(5000) } });
    logs.hear({ level: "info", logger: "db", data: { n: 1 } });

    const [big, small] = logs.entries();

    expect(big?.data).toHaveLength(MCP_LOG_DATA_MAX);
    expect(small).toMatchObject({ level: "info", logger: "db", data: '{"n":1}' });
  });

  it("scrubs the tokens sent so far, as they are when the entries are made, and the header values", () => {
    const tokens = new Set<string>();
    const logs = collector(tokens, secretsOf({ "x-api-key": "key-0123456789", accept: "json" }));

    logs.hear({
      level: "warning",
      data: "bad token tok-abcdef or key-0123456789",
      logger: "tok-abcdef",
    });

    // The token arrives after the log did (a refresh): the entries still do not show it.
    tokens.add("tok-abcdef");

    const [entry] = logs.entries();

    expect(JSON.stringify(entry)).not.toContain("tok-abcdef");
    expect(JSON.stringify(entry)).not.toContain("key-0123456789");
    expect(entry?.data).toBe("bad token [REDACTED] or [REDACTED]");
  });

  it("scrubs before it cuts, so no token is left cut in half", () => {
    const token = "t".repeat(40);
    const logs = collector(new Set([token]));

    logs.hear({ level: "warning", data: `${"a".repeat(MCP_LOG_DATA_MAX - 20)}${token}` });

    const [entry] = logs.entries();

    expect(entry?.data).not.toContain("tttt");
    expect(entry?.data).toHaveLength(MCP_LOG_DATA_MAX - 20 + "[REDACTED]".length);
  });

  it("keeps nothing for data that has no JSON", () => {
    const logs = collector();

    logs.hear({ level: "warning", data: undefined });

    expect(logs.entries()[0]?.data).toBe("");
  });
});

describe("secretsOf", () => {
  it("takes each header value, and the credential after a scheme, and leaves short ones", () => {
    expect(
      secretsOf({ authorization: "Bearer abcdefgh", accept: "json", "x-key": "abcdef" }),
    ).toEqual(["Bearer abcdefgh", "abcdefgh", "abcdef"]);
    expect(secretsOf(undefined)).toEqual([]);
  });
});
