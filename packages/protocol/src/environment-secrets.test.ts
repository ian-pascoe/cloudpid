import { describe, expect, it } from "vitest";
import {
  fieldSecret,
  keptSecretField,
  MAX_ENVIRONMENT_SECRET_BYTES,
  secretBuildField,
  secretNameProblem,
  secretValueProblem,
} from "./environment-secrets.ts";
import { unrevertableField } from "./lifecycle-changes.ts";

describe("secretNameProblem", () => {
  it("takes the names secret_ask takes", () => {
    for (const name of ["API_KEY", "_PRIVATE", "NPM_TOKEN2"]) {
      expect(secretNameProblem(name)).toBeUndefined();
    }
  });

  it("refuses names a shell variable or secret_ask would not take", () => {
    for (const name of ["", "api_key", "2FA", "API-KEY", "API KEY", "X".repeat(129)]) {
      expect(secretNameProblem(name)).toBeDefined();
    }
  });
});

describe("secretValueProblem", () => {
  it("takes any non-empty text up to the bound, multi-line included", () => {
    expect(secretValueProblem("-----BEGIN KEY-----\nabc\n-----END KEY-----\n")).toBeUndefined();
    expect(secretValueProblem("x".repeat(MAX_ENVIRONMENT_SECRET_BYTES))).toBeUndefined();
  });

  it("refuses an empty value, a NUL, and one over the bound in UTF-8, without quoting it", () => {
    const tooLong = "é".repeat(MAX_ENVIRONMENT_SECRET_BYTES / 2 + 1);

    for (const value of ["", "a\0b", tooLong]) {
      const problem = secretValueProblem(value);

      expect(problem).toBeDefined();
      expect(problem).not.toContain(value === "" ? "\u0000" : value);
    }
  });
});

describe("the Agent change fields of kept Secrets", () => {
  it("name a Secret kept and its Build mark apart, by the name only", () => {
    expect(keptSecretField("API_KEY")).toBe("secrets.API_KEY");
    expect(secretBuildField("API_KEY")).toBe("secrets.API_KEY.build");
    expect(fieldSecret("secrets.API_KEY")).toEqual({ name: "API_KEY", kind: "kept" });
    expect(fieldSecret("secrets.API_KEY.build")).toEqual({ name: "API_KEY", kind: "build" });
    expect(fieldSecret("variables.API_KEY")).toBeNull();
    expect(fieldSecret("idleMinutes")).toBeNull();
  });

  it("have a revert only for the Build mark: a kept value is not in the history to bring back", () => {
    expect(unrevertableField(keptSecretField("API_KEY"))).toBe(true);
    expect(unrevertableField(secretBuildField("API_KEY"))).toBe(false);
  });
});
