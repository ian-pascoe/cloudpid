// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import {
  envReference,
  isSecretName,
  referencedSecretNames,
  rewriteReferences,
  secretEnvName,
  secretReference,
} from "./references.ts";

// Built from parts, so the agent writing this file never writes a reference itself.
const ref = secretReference;
const env = envReference;

describe("referencedSecretNames", () => {
  it("finds both forms in nested string arguments", () => {
    const args = {
      command: `curl -H "Authorization: Bearer $${env("API_TOKEN")}" https://example.com`,
      files: [{ content: `PASSWORD=${ref("DB_PASSWORD")}` }],
    };

    expect([...referencedSecretNames(args)].toSorted()).toEqual(["API_TOKEN", "DB_PASSWORD"]);
  });

  it("names malformed placeholders too, so a call naming one can be refused", () => {
    expect([...referencedSecretNames({ text: `${ref("lower")} ${ref("")}` })]).toEqual([
      "lower",
      "",
    ]);
  });

  it("ignores the bare prefix and a name glued to a longer word", () => {
    expect(referencedSecretNames({ command: `env | grep ${secretEnvName("")}` }).size).toBe(0);
    expect(referencedSecretNames({ command: `MY${env("TOKEN")}` }).size).toBe(0);
  });

  it("ignores references escaped with a backslash, and the shell's own escapes", () => {
    const args = {
      doc: `\\${ref("TOKEN")} and \\${env("TOKEN")}`,
      command: `echo \\$${env("TOKEN")} \\\${${env("TOKEN")}}`,
    };

    expect(referencedSecretNames(args).size).toBe(0);
  });
});

describe("rewriteReferences", () => {
  const resolve = (name: string) => `<${name} value>`;

  it("replaces placeholders with their values and leaves environment references to the shell", () => {
    const args = { command: `curl -u me:${ref("PASS")} -H "X: $${env("KEY")}"` };

    expect(rewriteReferences(args, resolve)).toEqual({
      command: `curl -u me:<PASS value> -H "X: $${env("KEY")}"`,
    });
  });

  it("drops the backslash of an escaped reference, so the tool receives the literal form", () => {
    expect(rewriteReferences({ doc: `\\${ref("A")} \\${env("B")}` }, resolve)).toEqual({
      doc: `${ref("A")} ${env("B")}`,
    });
  });

  it("leaves a shell escape exactly as written", () => {
    const command = `echo \\$${env("TOKEN")}`;

    expect(rewriteReferences({ command }, resolve)).toEqual({ command });
  });

  it("returns the same value when nothing changed", () => {
    const args = { command: "ls -la", nested: [1, true, null, { x: "y" }] };

    expect(rewriteReferences(args, resolve)).toBe(args);
  });
});

describe("isSecretName", () => {
  it("accepts environment-variable style names only", () => {
    expect(isSecretName("GITHUB_TOKEN")).toBe(true);
    expect(isSecretName("_X1")).toBe(true);
    expect(isSecretName("lower")).toBe(false);
    expect(isSecretName("1ABC")).toBe(false);
    expect(isSecretName("")).toBe(false);
  });
});
