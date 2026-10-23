// @effect-diagnostics asyncFunction:off
import * as Record from "effect/Record";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_LABEL_LIMITS,
  containerAnalytics,
  usageQuery,
  WORKSPACE_LABEL,
  workspaceLabels,
} from "./container-analytics.ts";

const FROM = Date.UTC(2026, 9, 20, 12, 0, 0);
const TO = Date.UTC(2026, 9, 20, 13, 0, 0);

/** A fake API that answers `text` (JSON) with `status`, and keeps the requests it was sent. */
const answering = (text: string, status = 200) => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

  const send: typeof fetch = async (input, init) => {
    requests.push({ url: input instanceof Request ? input.url : String(input), init });

    return new Response(text, { status });
  };

  return { requests, send };
};

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("workspaceLabels", () => {
  // workerd refuses to start a Container whose labels break these, so a launch would fail.
  it("keep within workerd's limits for a Durable Object id", () => {
    const labels = Record.toEntries(workspaceLabels("f".repeat(64)));

    expect(labels.length).toBeLessThanOrEqual(CONTAINER_LABEL_LIMITS.count);

    for (const [name, value] of labels) {
      expect(bytes(name)).toBeGreaterThan(0);
      expect(bytes(name)).toBeLessThanOrEqual(CONTAINER_LABEL_LIMITS.nameBytes);
      expect(bytes(value)).toBeLessThanOrEqual(CONTAINER_LABEL_LIMITS.valueBytes);
    }
  });
});

describe("usageQuery", () => {
  it("asks for each window's sums of the Containers with the Workspace's label", () => {
    const query = usageQuery("account", "abc", [
      { from: FROM, to: TO },
      { from: TO, to: TO + 60_000 },
    ]);

    expect(query).toContain('accountTag: "account"');
    expect(query).toContain(
      `w0: containersUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: "2026-10-20T12:00:00.000Z", datetime_lt: "2026-10-20T13:00:00.000Z", labels_has: "${WORKSPACE_LABEL}=abc" })`,
    );
    expect(query).toContain(
      'w1: containersUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: "2026-10-20T13:00:00.000Z"',
    );
    expect(query).toContain("sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }");
  });
});

describe("containerAnalytics", () => {
  it("posts the query with the token, and answers each window's sums, zeros where there was no usage", async () => {
    const { requests, send } = answering(
      JSON.stringify({
        data: {
          viewer: {
            accounts: [
              {
                w0: [
                  {
                    sum: {
                      cpuTimeSec: 12.5,
                      allocatedMemory: 100,
                      allocatedDisk: 200,
                      txBytes: 300,
                    },
                  },
                ],
                w1: [],
              },
            ],
          },
        },
        errors: null,
      }),
    );

    const sums = await containerAnalytics({ token: "secret", accountId: "account", fetch: send })(
      "abc",
      [
        { from: FROM, to: TO },
        { from: TO, to: TO + 60_000 },
      ],
    );

    expect(sums).toEqual([
      { cpuTimeSec: 12.5, allocatedMemory: 100, allocatedDisk: 200, txBytes: 300 },
      { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 },
    ]);
    expect(requests[0]?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("fails on the API's errors", async () => {
    const { send } = answering(
      JSON.stringify({ data: null, errors: [{ message: "not authorized" }] }),
    );

    await expect(
      containerAnalytics({ token: "t", accountId: "a", fetch: send })("abc", [
        { from: FROM, to: TO },
      ]),
    ).rejects.toThrow("not authorized");
  });

  it("fails on an HTTP error", async () => {
    const { send } = answering("{}", 403);

    await expect(
      containerAnalytics({ token: "t", accountId: "a", fetch: send })("abc", [
        { from: FROM, to: TO },
      ]),
    ).rejects.toThrow("403");
  });

  it("asks nothing for no window", async () => {
    const { requests, send } = answering("{}");

    expect(
      await containerAnalytics({ token: "t", accountId: "a", fetch: send })("abc", []),
    ).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
