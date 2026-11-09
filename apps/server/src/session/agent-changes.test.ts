// The Run-end Notification of the Run's Agent changes and cloudpid reports (`agent-changes.ts`;
// `docs/architecture/agent-capabilities.md` → cloudpid reports): one push, at most a clause for each list, and the reports
// kept for it once each.
// @effect-diagnostics asyncFunction:off -- vitest's tests are Promise-based.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { runCloudpidReports, runNotice } from "./agent-changes.ts";
import type { SettingsKv } from "./settings.ts";

const change = { tool: "environment_variable_set", environmentName: "Web", field: "API_URL" };

const report = { number: 123, title: "bash ignores its timeout" };

/** How many times `part` is in `text`. */
const count = (text: string, part: string) => text.split(part).length - 1;

describe("runNotice", () => {
  it("tells the Agent changes alone, each by its tool, Environment and field", () => {
    const { kind, body } = runNotice([change], []);

    expect(kind).toBe("notice");
    expect(body).toContain('environment_variable_set "Web" API_URL');
    expect(body).not.toContain("cloudpid report");
  });

  it("tells one report by its number and title", () => {
    const { body } = runNotice([], [report]);

    expect(body).toContain("#123");
    expect(body).toContain(report.title);
    expect(count(body, "cloudpid report")).toBe(1);
  });

  it("tells several reports in one clause, by count, number and title, each title cut to 80 characters", () => {
    const { body } = runNotice(
      [],
      [
        { number: 1, title: "a".repeat(81) },
        { number: 2, title: "short" },
      ],
    );

    expect(count(body, "cloudpid report")).toBe(1);
    // The format is the contract (D12): at most two clauses, one per kind, so several reports open with their count.
    expect(body).toMatch(/^2 cloudpid reports/);
    expect(body).toContain(`#1 ${"a".repeat(79)}…`);
    expect(body).not.toContain("a".repeat(80));
    expect(body).toContain("#2 short");
    expect(body.indexOf("#1")).toBeLessThan(body.indexOf("#2"));
  });

  it("tells both, the changes' clause before the reports'", () => {
    const { body } = runNotice([change], [report, { number: 124, title: "ls hangs" }]);

    expect(body.indexOf("API_URL")).toBeLessThan(body.indexOf("cloudpid report"));
    expect(count(body, "cloudpid report")).toBe(1);
    expect(body).toContain("#123");
    expect(body).toContain("#124");
  });
});

describe("runCloudpidReports", () => {
  it("keeps a report once, though a rerun of its call records it again", async () => {
    const stored = new Map<string, unknown>();

    const kv: SettingsKv = {
      // SAFETY: the map holds only what `put` was given under each key.
      get: <T>(key: string) => stored.get(key) as T | undefined,
      put: (key, value) => {
        stored.set(key, value);
      },
    };

    const reports = runCloudpidReports(kv);

    await Effect.runPromise(reports.record(report));
    await Effect.runPromise(reports.record(report));
    await Effect.runPromise(reports.record({ number: 124, title: "ls hangs" }));

    expect(await Effect.runPromise(reports.pending)).toEqual([
      report,
      { number: 124, title: "ls hangs" },
    ]);
  });
});
