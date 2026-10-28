// Cloudflare's usage analytics of a Workspace's Containers (`docs/architecture/operations.md` → Usage): the GraphQL Analytics
// API's `containersUsageAdaptiveGroups`, the dataset behind the dashboard's usage estimate, which counts the Container's
// micro VM too. Each Container is launched with the Workspace's label (`ContainerLaunch`), so one filter on it finds
// every launch of the Workspace. Needs an API token with Account Analytics Read (`CLOUDPID_ANALYTICS_TOKEN`).
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off missingPipeableSignature:off schemaSync:off missedPipeableOpportunity:off
import type { ContainerUsageSums } from "@cloudpid/config";
import * as Schema from "effect/Schema";

/**
 * The label every Container of a Workspace is launched with, and the key analytics are filtered by. workerd refuses a
 * launch whose label names are over 16 bytes (`CONTAINER_LABEL_LIMITS`).
 */
export const WORKSPACE_LABEL = "cloudpid-ws";

/** workerd's limits on a Container's labels (`requireValidLabels`, `src/workerd/api/container.c++`). */
export const CONTAINER_LABEL_LIMITS = { count: 10, nameBytes: 16, valueBytes: 64 } as const;

/** The labels the Containers of the Workspace `workspace` (its Durable Object's id) are launched with. */
export const workspaceLabels = (workspace: string) => ({
  [WORKSPACE_LABEL]: workspace,
});

/** A span of time, epoch milliseconds, `to` excluded. */
export type AnalyticsWindow = { readonly from: number; readonly to: number };

/** The usage of the Containers labelled `workspace` in each window, in order. */
export type ContainerAnalytics = (
  workspace: string,
  windows: ReadonlyArray<AnalyticsWindow>,
) => Promise<ReadonlyArray<ContainerUsageSums>>;

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** How long a query may take before it counts as failed. */
const QUERY_TIMEOUT_MS = 10_000;

const Sums = Schema.Struct({
  cpuTimeSec: Schema.NullOr(Schema.Finite),
  allocatedMemory: Schema.NullOr(Schema.Finite),
  allocatedDisk: Schema.NullOr(Schema.Finite),
  txBytes: Schema.NullOr(Schema.Finite),
});

const Answer = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      viewer: Schema.Struct({
        accounts: Schema.Array(
          Schema.Record(Schema.String, Schema.Array(Schema.Struct({ sum: Sums }))),
        ),
      }),
    }),
  ),
  errors: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String }))),
  ),
});

const decodeAnswer = Schema.decodeUnknownSync(Answer);

/** The query for `windows` of the Containers labelled `workspace`, one aliased field per window. */
export const usageQuery = (
  accountId: string,
  workspace: string,
  windows: ReadonlyArray<AnalyticsWindow>,
): string => {
  const fields = windows.map(
    ({ from, to }, index) =>
      `w${index}: containersUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: ${JSON.stringify(new Date(from).toISOString())}, datetime_lt: ${JSON.stringify(new Date(to).toISOString())}, labels_has: ${JSON.stringify(`${WORKSPACE_LABEL}=${workspace}`)} }) { sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } }`,
  );

  return `{ viewer { accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) { ${fields.join(" ")} } } }`;
};

export type ContainerAnalyticsOptions = {
  readonly token: string;
  readonly accountId: string;
  readonly fetch?: typeof fetch;
};

/** `ContainerAnalytics` over the GraphQL Analytics API. A window with no usage is all zeros. */
export const containerAnalytics =
  ({ token, accountId, fetch: send = fetch }: ContainerAnalyticsOptions): ContainerAnalytics =>
  async (workspace, windows) => {
    if (windows.length === 0) return [];

    const response = await send(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: usageQuery(accountId, workspace, windows) }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Container analytics answered ${response.status} ${response.statusText}`);
    }

    const answer = decodeAnswer(await response.json());

    if (answer.errors !== undefined && answer.errors !== null && answer.errors.length > 0) {
      throw new Error(
        `Container analytics refused the query: ${answer.errors.map((error) => error.message).join("; ")}`,
      );
    }

    const account = answer.data?.viewer.accounts[0];

    if (account === undefined) throw new Error("Container analytics answered no account");

    return windows.map((_, index) => {
      const sum = account[`w${index}`]?.[0]?.sum;

      return {
        cpuTimeSec: sum?.cpuTimeSec ?? 0,
        allocatedMemory: sum?.allocatedMemory ?? 0,
        allocatedDisk: sum?.allocatedDisk ?? 0,
        txBytes: sum?.txBytes ?? 0,
      };
    });
  };
