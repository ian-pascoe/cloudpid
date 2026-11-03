// @effect-diagnostics preferEffectArray:off -- expected lists of a test are native arrays.

import { describe, expect, it } from "vitest";
import { mcpCredentialLiterals } from "./mcp-credentials.ts";

const keys = (value: Parameters<typeof mcpCredentialLiterals>[0]) =>
  mcpCredentialLiterals(value).map(({ where, key }) => `${where}.${key}`);

describe("mcpCredentialLiterals", () => {
  it("flags a literal in a credential header, after an optional scheme word", () => {
    expect(
      keys({
        headers: {
          Authorization: "Bearer abc123",
          "Proxy-Authorization": "abc",
          Cookie: "session=abc",
          "X-API-Key": "abc",
          "Api-Key": "abc",
        },
      }),
    ).toEqual([
      "headers.Authorization",
      "headers.Proxy-Authorization",
      "headers.Cookie",
      "headers.X-API-Key",
      "headers.Api-Key",
    ]);
  });

  it("accepts a header that is only ${NAME}, with or without a scheme word", () => {
    expect(
      keys({ headers: { Authorization: "Bearer ${LINEAR_TOKEN}", "X-API-Key": "${KEY}" } }),
    ).toEqual([]);
  });

  it("flags a literal beside a ${NAME}", () => {
    expect(keys({ headers: { Authorization: "Bearer ${A}-extra" } })).toEqual([
      "headers.Authorization",
    ]);
  });

  it("flags a literal under a key that ends TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, APIKEY, ACCESS_KEY or PRIVATE_KEY", () => {
    expect(
      keys({
        env: {
          GITHUB_TOKEN: "ghp_x",
          "client-secret": "x",
          DB_PASSWORD: "x",
          DB_PASSWD: "x",
          OPENAI_API_KEY: "x",
          STRIPEAPIKEY: "x",
          AWS_ACCESS_KEY: "x",
          SIGNING_PRIVATE_KEY: "x",
        },
      }),
    ).toHaveLength(8);
  });

  it("ignores case, - and _ in the key", () => {
    expect(keys({ env: { "my-Api-Key": "x" } })).toEqual(["env.my-Api-Key"]);
  });

  it("leaves other keys, empty values and ${NAME}-only values alone", () => {
    expect(
      keys({
        env: { REGION: "eu", GITHUB_TOKEN: "${GITHUB_TOKEN}", API_TOKEN: "" },
        headers: { "X-Team": "core", Accept: "application/json" },
      }),
    ).toEqual([]);
  });

  it("applies the header names to headers only", () => {
    expect(keys({ env: { Authorization: "abc" } })).toEqual([]);
  });

  it("says to keep it as a Secret and write ${NAME}", () => {
    expect(mcpCredentialLiterals({ env: { API_TOKEN: "x" } })[0]?.message).toBe(
      "env.API_TOKEN holds a literal that looks like a credential: keep it as a Secret and write ${NAME}",
    );
  });
});
