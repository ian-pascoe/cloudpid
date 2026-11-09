// The GitHub calls of a cloudpid report over a fake GitHub (`issues.ts`; `docs/architecture/agent-capabilities.md` →
// cloudpid reports, ADR-0051): when a rate limit says to ask again, a refused token, an answer that is not an issue, and a
// GitHub that can't be reached. Never GitHub itself.
// @effect-diagnostics asyncFunction:off -- GitHub is asked with `fetch`, a Promise API.
import { describe, expect, it } from "vitest";
import { createIssue, type IssueCalls, labelExists } from "./issues.ts";

/** 2026-11-09, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 9, 12);

/** Calls whose every request GitHub answers `answer`. */
const answering = (answer: () => Response): IssueCalls => ({
  fetch: async () => answer(),
  now: () => NOW,
});

const ISSUE = { title: "bash ignores its timeout", body: "x".repeat(60), labels: [] };

describe("a cloudpid report's GitHub calls", () => {
  it.each<[string, Response, number]>([
    [
      "retry-after's seconds",
      new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
      NOW + 30_000,
    ],
    [
      "the rate limit's reset, with none",
      new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((NOW + 120_000) / 1000),
        },
      }),
      NOW + 120_000,
    ],
    ["a minute, with neither", new Response("{}", { status: 429 }), NOW + 60_000],
  ])("waits out a rate limit until %s says", async (_, response, until) => {
    const made = await createIssue(
      answering(() => response),
      "ghs_token",
      ISSUE,
    );

    expect(made).toMatchObject({ refused: { kind: "rate_limited", until } });
  });

  it("tells a token GitHub refused (a 401) apart, so it is not handed out again", async () => {
    const calls = answering(() => Response.json({ message: "Bad credentials" }, { status: 401 }));

    expect(await createIssue(calls, "ghs_token", ISSUE)).toMatchObject({
      refused: { kind: "refused_token" },
    });
    expect(await labelExists(calls, "ghs_token", "cloudpid-report")).toMatchObject({
      kind: "refused_token",
    });
  });

  it("reads a 201 that is not an issue as a post that may have been made", async () => {
    const made = await createIssue(
      answering(() => Response.json({ unexpected: true }, { status: 201 })),
      "ghs_token",
      ISSUE,
    );

    expect(made).toHaveProperty("sent");
  });

  it("fails the label's check when GitHub can't be reached", async () => {
    const calls: IssueCalls = {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      now: () => NOW,
    };

    expect(await labelExists(calls, "ghs_token", "cloudpid-report")).toMatchObject({
      kind: "failed",
    });
  });
});
