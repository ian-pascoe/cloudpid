// @effect-diagnostics preferEffectArray:off
import { MCP_LOG_DATA_MAX, MCP_LOG_RING } from "@cloudpid/mcp/types";
import { describe, expect, it } from "vitest";
import { callLogs, secretsOf } from "./logs.ts";

const collector = (tokens: ReadonlySet<string> = new Set()) => {
  let now = 0;

  return callLogs({ now: () => ++now, tokens: () => tokens });
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

  it("scrubs the tokens and Secrets held so far, as they are when the entries are made", () => {
    const tokens = new Set<string>(["key-0123456789"]);
    const logs = collector(tokens);

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
});

describe("secretsOf", () => {
  const target = {
    kind: "http",
    conn: "c",
    name: "docs",
    url: "https://docs.example.test/mcp",
  } as const;

  it("takes the Secret values the host named, as far as four characters", () => {
    expect(secretsOf({ ...target, redact: ["abcdefgh", "abcd", "abc"] })).toEqual([
      "abcdefgh",
      "abcd",
    ]);
    expect(secretsOf(target)).toEqual([]);
  });

  it("takes from the credential headers only: the credential after a scheme, a Basic password, a cookie's values and a key's value", () => {
    expect(
      secretsOf({
        ...target,
        redact: ["named-secret"],
        headers: {
          authorization: "Bearer abcdefgh",
          "Proxy-Authorization": `Basic ${btoa("user:pa:ss")}`,
          cookie: 'a=one-value; b="two-value"; c=xy',
          "X-Api-Key": "key-0123456789",
          "x-org": "acme",
          accept: "application/json",
        },
      }),
    ).toEqual([
      "named-secret",
      "abcdefgh",
      btoa("user:pa:ss"),
      "pa:ss",
      "one-value",
      "two-value",
      "key-0123456789",
    ]);
  });

  it("finds nothing in a Basic credential that is not base64, or has no password", () => {
    expect(secretsOf({ ...target, headers: { authorization: "Basic !!!not-base64!!!" } })).toEqual([
      "!!!not-base64!!!",
    ]);
    expect(
      secretsOf({ ...target, headers: { authorization: `Basic ${btoa("only-a-user")}` } }),
    ).toEqual([btoa("only-a-user")]);
  });
});
