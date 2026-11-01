// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import {
  envReference,
  isSecretName,
  rewriteReferences,
  secretEnvName,
  secretReference,
  secretReferencesByName,
} from "./references.ts";

// Built from parts, so the agent writing this file never writes a reference itself.
const ref = secretReference;
const env = envReference;

describe("secretReferencesByName", () => {
  it("finds both forms in nested string arguments", () => {
    const args = {
      command: `curl -H "Authorization: Bearer $${env("API_TOKEN")}" https://example.com`,
      files: [{ content: `PASSWORD=${ref("DB_PASSWORD")}` }],
    };

    expect([...secretReferencesByName(args).keys()]).toEqual(["API_TOKEN", "DB_PASSWORD"]);
  });

  it("keeps each reference as the call wrote it, with the shell expansion that opens it", () => {
    const references = (text: string) => secretReferencesByName({ text }).get("TOKEN");

    expect(references(`x=${ref("TOKEN")}`)).toEqual([{ form: "placeholder", text: ref("TOKEN") }]);
    expect(references(`curl -u $${env("TOKEN")}`)).toEqual([
      { form: "expansion", text: `$${env("TOKEN")}` },
    ]);
    expect(references(`curl -u "\${${env("TOKEN")}}"`)).toEqual([
      { form: "expansion", text: `\${${env("TOKEN")}}` },
    ]);
    expect(references(`echo \${${env("TOKEN")}:-none}`)).toEqual([
      { form: "expansion", text: `\${${env("TOKEN")}` },
    ]);
    expect(references(`set ${env("TOKEN")} first`)).toEqual([{ form: "word", text: env("TOKEN") }]);
  });

  it("lists a name's references in order of appearance, each text once", () => {
    const args = {
      doc: `${env("TOKEN")} is unset: echo $${env("TOKEN")}`,
      again: [`${ref("TOKEN")} ${ref("TOKEN")} $${env("TOKEN")}`],
    };

    expect(secretReferencesByName(args).get("TOKEN")).toEqual([
      { form: "word", text: env("TOKEN") },
      { form: "expansion", text: `$${env("TOKEN")}` },
      { form: "placeholder", text: ref("TOKEN") },
    ]);
  });

  it("names malformed references too, so a call naming one can be refused", () => {
    const references = secretReferencesByName({
      text: `${ref("lower")} ${ref("")} $${env("lower")}`,
    });

    expect([...references]).toEqual([
      [
        "lower",
        [
          { form: "placeholder", text: ref("lower") },
          { form: "expansion", text: `$${env("lower")}` },
        ],
      ],
      ["", [{ form: "placeholder", text: ref("") }]],
    ]);
  });

  it("ignores the bare prefix and a name glued to a longer word", () => {
    expect(secretReferencesByName({ command: `env | grep ${secretEnvName("")}` }).size).toBe(0);
    expect(secretReferencesByName({ command: `MY${env("TOKEN")}` }).size).toBe(0);
  });

  it("ignores references escaped with a backslash, and the shell's own escapes", () => {
    const args = {
      doc: `\\${ref("TOKEN")} and \\${env("TOKEN")}`,
      command: `echo \\$${env("TOKEN")} \\\${${env("TOKEN")}}`,
    };

    expect(secretReferencesByName(args).size).toBe(0);
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
