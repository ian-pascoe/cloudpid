// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off -- runs on node, on the owner's machine; native array methods over plain values.
/**
 * The publish job of `.github/workflows/ci.yml` (docs/development/infra.md → CI): the job's gate and what it runs. A
 * workflow has no test of its own, so this reads it as text, as far as the two ways the job has failed need.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
  "utf8",
);

/** The text of one top-level job: from its `  <name>:` line to the next job's. */
const jobOf = (name: string): string => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);

  expect(start).toBeGreaterThan(-1);

  const length = lines.slice(start + 1).findIndex((line) => /^ {2}(?:#|[a-z][\w-]*:)/.test(line));

  return lines.slice(start, length === -1 ? undefined : start + 1 + length).join("\n");
};

describe("the pi-cloudpid publish job", () => {
  const job = jobOf("pi-cloudpid");

  it("runs after a deploy that succeeded although `docs` and `manifests` were skipped", () => {
    // Without a status function the `if` carries an implicit `success()`, which fails on the skipped jobs `deploy`
    // waits on (a push runs neither), so the job never ran.
    expect(job).toMatch(/^ {4}needs: deploy$/m);
    expect(job).toMatch(
      /^ {4}if: \$\{\{ !cancelled\(\) && needs\.deploy\.result == 'success' \}\}$/m,
    );
  });

  it("does not put an older build on a newer one when an older run is rerun", () => {
    expect(job).toContain("merge-base --is-ancestor");
    expect(job).toMatch(/fetch-depth: 0/);
  });

  it("is gated like the deploy it follows", () => {
    expect(jobOf("deploy")).toContain("!cancelled()");
  });
});
