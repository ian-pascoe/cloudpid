// `McpServer` in workerd, as it deploys (`vitest.config.ts` bundles `McpWorker` without `nodejs_compat`): pi-mcp's own
// `McpClient` drives it through `MCP_SERVER.serve(request, api)` with an `RpcTarget` of canned answers for `api`. That
// it runs at all is the answer to "does `createMcpHandler` run without `nodejs_compat`".
// workerd's RPC APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalFetch:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off schemaSync:off
import { env, RpcTarget } from "cloudflare:workers";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  type EnvironmentsResult,
  MCP_API_LIMITS,
  type McpSessionSummary,
  type SessionDetail,
  type SessionsQuery,
  type TranscriptPage,
  type WaitResult,
} from "@cloudpid/protocol/mcp-api";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import type { McpServerBinding } from "./binding.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_SERVER: McpServerBinding;
    }
  }
}

const URL_OF_ENDPOINT = "https://cloudpid.test/mcp";

const SESSION = "01900000-0000-7000-8000-000000000001";

const ENVIRONMENTS: EnvironmentsResult = {
  environments: [
    {
      id: "default",
      name: "Default",
      default: true,
      repos: [{ name: "cloudpid", url: "https://github.com/ian-pascoe/cloudpid" }],
      running_sessions: 1,
    },
  ],
  models: { available: ["anthropic/claude-opus-5-5"], default: "anthropic/claude-opus-5-5" },
};

const SUMMARY: McpSessionSummary = {
  session_id: SESSION,
  title: "Fix the bug",
  environment: { id: "default", name: "Default" },
  status: "running",
  updated_at: "2026-11-02T14:00:00.000Z",
  archived: false,
  url: `https://cloudpid.test/sessions/${SESSION}`,
};

const DETAIL: SessionDetail = {
  ...SUMMARY,
  status: "waiting_for_owner",
  waiting: [
    {
      kind: "approval",
      request_id: "req-1",
      agent_id: "root",
      summary: "Approve git push (origin)",
      since: 1_800_000_000_000,
      url: `/sessions/${SESSION}?request=req-1`,
    },
  ],
  agents: [{ agent_id: "agent-1", parent: "root", role: "small", status: "working" }],
  workspace: { branch: "cloudpid/ab12cd34", base: null, repos: ["cloudpid"] },
  model: "anthropic/claude-opus-5-5",
  thinking: "high",
  cursor: "cursor-1",
};

const PAGE: TranscriptPage = {
  entries: [
    { entry_id: 1, role: "user", at: "2026-11-02T14:00:00.000Z", text: "### user · 14:00\nHello" },
  ],
  newer: "newer-1",
};

/** Canned answers for the `api` target of one request, as the main Worker's `McpApi` would give. */
class FakeApi extends RpcTarget {
  readonly calls: Array<string> = [];
  /** What `limited` answers: over the rate when set. */
  over: { readonly retryAfterS: number } | undefined;
  // The Server's operations are read once per isolate (`toolGate`), so every case sees the same tools.
  operations = ["environments", "sessions", "session", "transcript", "wait"];

  describe() {
    return { operations: this.operations, limits: MCP_API_LIMITS };
  }

  environments(): ApiResult<EnvironmentsResult> {
    this.calls.push("environments");

    return apiOk(ENVIRONMENTS);
  }

  sessions(query: SessionsQuery): ApiResult<{ sessions: ReadonlyArray<McpSessionSummary> }> {
    this.calls.push(`sessions ${JSON.stringify(query)}`);

    return apiOk({ sessions: [SUMMARY] });
  }

  session(id: string): ApiResult<SessionDetail> {
    this.calls.push(`session ${id}`);

    return id === SESSION ? apiOk(DETAIL) : apiFailure("not_found", `No Session ${id}.`);
  }

  transcript(request: {
    readonly session_id: string;
  }): ApiResult<TranscriptPage & { session_id: string }> {
    this.calls.push(`transcript ${JSON.stringify(request)}`);

    return apiOk({ ...PAGE, session_id: request.session_id });
  }

  /** How long `wait` takes to answer: a real RPC that stays open while the stream does. */
  waitMs = 150;

  async wait(request: { readonly session_id: string; readonly after?: string }) {
    this.calls.push(`wait ${JSON.stringify(request)}`);

    await new Promise((resolve) => setTimeout(resolve, this.waitMs));

    return apiOk<WaitResult>({
      session_id: request.session_id,
      status: "idle",
      ended_by: "run_ended",
      outcome: { result: "answered" },
      waiting: [],
      activity: { entries: 2, tool_calls: 1, latest: ["assistant: done"] },
      answer: { text: "All done", truncated: false },
      cursor: "cursor-2",
    });
  }

  get limited() {
    return this.over;
  }

  get auth() {
    return "service_token" as const;
  }
}

/** A `fetch` that serves every request through `MCP_SERVER`, as the main Worker forwards it. */
const through =
  (api: FakeApi, headers: Record<string, string> = {}): typeof fetch =>
  (input, init) => {
    // RPC carries no `AbortSignal`: the request is rebuilt without the client's, as the main Worker forwards it.
    const { signal: _signal, headers: sent, ...rest } = init ?? {};

    const request = new Request(input, {
      ...rest,
      headers: { ...Object.fromEntries(new Headers(sent)), ...headers },
    });

    return env.MCP_SERVER.serve(request, api);
  };

const connected = async (api: FakeApi, headers: Record<string, string> = {}) => {
  const client = new McpClient({ name: "pi-test", version: "1.0.0" });

  await client.connect(
    new StreamableHttpTransport({ url: URL_OF_ENDPOINT, fetch: through(api, headers) }),
  );

  return client;
};

describe("McpServer", () => {
  it("serves the read tools and session_wait to pi-mcp's McpClient, with the text and the same structuredContent", async () => {
    const api = new FakeApi();
    const client = await connected(api, { "x-cloudpid-client": "pi-cloudpid/abc1234" });

    try {
      expect(client.serverInfo?.name).toBe("cloudpid");
      expect(client.serverCapabilities?.tools).toEqual({ listChanged: false });
      expect(client.instructions?.split("\n")[0]).toMatch(
        /^cloudpid: the owner's hosted coding agent/,
      );

      const tools = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        "environments_list",
        "sessions_list",
        "session_get",
        "session_wait",
        "session_transcript",
      ]);

      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
        expect(tool.outputSchema).toBeDefined();
      }

      const environments = await client.callTool("environments_list", {});

      expect(environments.isError).not.toBe(true);
      expect(environments.structuredContent).toMatchObject(ENVIRONMENTS);
      expect(environments.content).toEqual([
        { type: "text", text: expect.stringContaining("Default [default] (default)") },
      ]);

      const sessions = await client.callTool("sessions_list", { status: "running", limit: 5 });

      expect(sessions.structuredContent).toMatchObject({ sessions: [SUMMARY] });
      expect(api.calls).toContain('sessions {"status":"running","limit":5}');

      const detail = await client.callTool("session_get", { session_id: SESSION });

      expect(detail.structuredContent).toMatchObject({
        status: "waiting_for_owner",
        cursor: "cursor-1",
      });
      expect(detail.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(SESSION),
      });

      const transcript = await client.callTool("session_transcript", { session_id: SESSION });

      expect(transcript.structuredContent).toMatchObject({ session_id: SESSION, newer: "newer-1" });
    } finally {
      await client.close();
    }
  });

  it("serves session_wait over a stream that reports progress to the client's progress token", async () => {
    const api = new FakeApi();
    const client = await connected(api);

    try {
      const seen: Array<{ progress: number; message?: string }> = [];

      const waited = await client.callTool(
        "session_wait",
        { session_id: SESSION, after: "cursor-1", timeout_s: 30 },
        {
          onProgress: (progress) => {
            seen.push(progress);
          },
        },
      );

      expect(api.calls).toContain(
        `wait {"session_id":"${SESSION}","after":"cursor-1","timeout_s":30}`,
      );
      expect(waited.isError).not.toBe(true);
      expect(waited.structuredContent).toMatchObject({
        ended_by: "run_ended",
        cursor: "cursor-2",
        answer: { text: "All done" },
      });
      // Progress at the start, from McpServer's own timer; the next would come 10 s later.
      expect(seen[0]).toMatchObject({ progress: 0, message: "Waiting for the Run · 0s" });
    } finally {
      await client.close();
    }
  });

  it("answers a domain failure as an isError result with a code, and a bad argument as the SDK's", async () => {
    const client = await connected(new FakeApi());

    try {
      const missing = await client.callTool("session_get", {
        session_id: "00000000-0000-7000-8000-00000000dead",
      });

      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        error: { code: "not_found", retryable: false },
      });

      const bad = await client.callTool("sessions_list", { limit: 500 });

      expect(bad.isError).toBe(true);
      expect(bad.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("limit"),
      });
    } finally {
      await client.close();
    }
  });

  it("answers rate_limited, not an HTTP 429, once the api says the caller is over its rate", async () => {
    const api = new FakeApi();

    api.over = { retryAfterS: 12 };

    const client = await connected(api);

    try {
      const limited = await client.callTool("environments_list", {});

      expect(limited.isError).toBe(true);
      expect(limited.structuredContent).toMatchObject({
        error: { code: "rate_limited", retryable: true, details: { retry_after_s: 12 } },
      });
      // The tool never ran.
      expect(api.calls).not.toContain("environments");
      // Listing is no call: it is not limited.
      expect(await client.listTools()).toHaveLength(5);
    } finally {
      await client.close();
    }
  });

  it("answers 405 to GET and DELETE, 400 to a foreign Origin, and keeps no session", async () => {
    const api = new FakeApi();

    const send = (init: RequestInit) =>
      env.MCP_SERVER.serve(new Request(URL_OF_ENDPOINT, init), api);

    expect((await send({ method: "GET" })).status).toBe(405);
    expect((await send({ method: "DELETE" })).status).toBe(405);

    const foreign = await send({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(foreign.status).toBe(400);

    const initialized = await send({
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });

    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    await initialized.body?.cancel();
  });
});
