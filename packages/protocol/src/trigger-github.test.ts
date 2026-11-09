// The GitHub trimmer (`trigger-github.ts`), over real GitHub payloads (`trigger-github.samples/`, from
// octokit/webhooks' payload examples): the inline body of a `github` Fire drops the API links and shrinks the four
// objects to their names.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off -- the samples are read from disk, and walked as plain JSON.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { trimGitHubBody } from "./trigger-github.ts";

const sample = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./trigger-github.samples/${name}.json`, import.meta.url).href),
    "utf8",
  );

/** Every key of `value`, at every depth, as dotted paths (an array's items under their index). */
const paths = (value: Schema.Json, prefix = ""): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return value.flatMap((field, index) => paths(field, `${prefix}${String(index)}.`));
  }

  if (!Predicate.isObject(value)) return [];

  // SAFETY: an object of parsed JSON that is no array is a JSON object.
  return Object.entries(value as Schema.JsonObject).flatMap(([key, field]) => [
    `${prefix}${key}`,
    ...paths(field, `${prefix}${key}.`),
  ]);
};

const trimmed = (body: string) => JSON.parse(trimGitHubBody(body) ?? "null");

describe("trimGitHubBody", () => {
  it("drops every *_url key but html_url, at every depth, and keeps the rest of a workflow run", () => {
    const body = sample("workflow_run.completed");
    const trim = trimmed(body);

    expect(
      paths(trim).filter((path) => path.endsWith("_url") && !path.endsWith("html_url")),
    ).toEqual([]);
    expect(trim.workflow_run).toMatchObject({
      conclusion: "success",
      head_branch: "master",
      html_url: "https://github.com/octo-org/octo-repo/actions/runs/289782451",
    });
    expect(trimGitHubBody(body)?.length).toBeLessThan(body.length / 2);
  });

  it("shrinks repository, organization and sender to their names, at every depth", () => {
    const trim = trimmed(sample("workflow_run.completed"));

    expect(trim).toMatchObject({
      repository: "octo-org/octo-repo",
      organization: "octo-org",
      sender: "Codertocat",
    });
    // The run's own repository too; a fork's head_repository is no named object and keeps its fields.
    expect(trim.workflow_run.repository).toBe("octo-org/octo-repo");
    expect(trim.workflow_run.head_repository.full_name).toBe("octo-org/octo-repo");
  });

  it("shrinks the installation to its id, and keeps a pull request's user but its links", () => {
    const trim = trimmed(sample("pull_request.opened"));

    expect(trim).toMatchObject({ installation: 1, sender: "Codertocat" });
    expect(trim.pull_request.user).toMatchObject({ login: "Codertocat" });
    expect(trim.pull_request.user).not.toHaveProperty("avatar_url");
  });

  it("shows a named object with no name as null, and keeps a __proto__ key as a field", () => {
    const body =
      '{"sender":{"url":"u"},"repository":{"id":1},"__proto__":{"login":"x","hooks_url":"y"}}';

    expect(trimGitHubBody(body)).toBe(
      '{"sender":null,"repository":null,"__proto__":{"login":"x"}}',
    );
  });

  it("trims the JSON in a form-encoded body's payload field, and leaves a body with no JSON alone", () => {
    const form = `payload=${encodeURIComponent(JSON.stringify({ sender: { login: "a", url: "u" }, hooks_url: "x" }))}`;

    expect(trimmed(form)).toEqual({ sender: "a" });
    expect(trimGitHubBody("not json")).toBeUndefined();
  });
});
