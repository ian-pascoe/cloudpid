// The Run-end Notification of the Run's Agent changes and cloudpid reports (`agent-changes.ts`;
// `docs/architecture/agent-capabilities.md` → cloudpid reports): one push, a clause for each list that has something.
import { describe, expect, it } from "vitest";
import { runNotice } from "./agent-changes.ts";

const change = { tool: "environment_variable_set", environmentName: "Web", field: "API_URL" };

describe("runNotice", () => {
  it.each<[string, Parameters<typeof runNotice>, string]>([
    [
      "the Agent changes alone",
      [[change], []],
      '1 Agent change: environment_variable_set "Web" API_URL',
    ],
    [
      "the reports alone",
      [[], [{ number: 123, title: "bash ignores its timeout" }]],
      "cloudpid report #123 filed: bash ignores its timeout",
    ],
    [
      "both, the changes first",
      [[change], [{ number: 123, title: "bash ignores its timeout" }]],
      '1 Agent change: environment_variable_set "Web" API_URL; cloudpid report #123 filed: bash ignores its timeout',
    ],
    [
      "each report, its title cut to 80 characters",
      [
        [],
        [
          { number: 1, title: "a".repeat(81) },
          { number: 2, title: "short" },
        ],
      ],
      `cloudpid report #1 filed: ${"a".repeat(79)}…; cloudpid report #2 filed: short`,
    ],
  ])("tells %s", (_, [changes, reports], body) => {
    expect(runNotice(changes, reports)).toEqual({ kind: "notice", body });
  });
});
