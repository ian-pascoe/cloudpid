// The Container's exit reports (docs/spec.md → Container and Toolchains → Exit reports): what the supervisor posts is
// logged, cut to size and without the GitHub token, and the report host is intercepted for every Container launched.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import {
  EXIT_REPORT_BYTES,
  EXIT_REPORT_HOST,
  EXIT_REPORT_PATH,
} from "@cloudpid/sandbox-image/supervisor";
import { describe, expect, it } from "vitest";
import {
  type ExitReport,
  type ExitReportRedaction,
  exitReport,
  parseExitReport,
  WITHHELD_OUTPUT,
  withExitReports,
} from "./exit-report.ts";

const url = (path: string) => `http://${EXIT_REPORT_HOST}${path}`;

/** A GitHub App's token, as the Workspace DO mints them. */
const TOKEN = `ghs_${"0123456789".repeat(3)}abcdef`;

const post = (body: string, path = EXIT_REPORT_PATH) =>
  new Request(url(path), { method: "POST", body });

const handle = async (request: Request, redact: ExitReportRedaction = async (output) => output) => {
  const logged: ExitReport[] = [];

  const response = await exitReport(request, {
    workspace: "do-1",
    redact,
    log: (report) => logged.push(report),
  });

  return { response, logged };
};

describe("a report", () => {
  it("is logged with computerd's status, how long it ran, and its last lines", async () => {
    const { response, logged } = await handle(
      post("status=1\nuptime=780\n\nmounting /workspace\nError: FUSE session lost\n"),
    );

    expect(response.status).toBe(204);
    expect(logged).toEqual([
      {
        message: "workspace.container.output",
        workspace: "do-1",
        status: 1,
        uptimeSeconds: 780,
        output: "mounting /workspace\nError: FUSE session lost",
        withheld: null,
      },
    ]);
  });

  it("has anything shaped like a GitHub token taken out of it, before the Workspace DO sees it", async () => {
    const { logged } = await handle(
      post(`status=1\nuptime=3\n\nGET https://x-access-token:${TOKEN}@github.com\n`),
    );

    expect(logged[0]?.output).toBe("GET https://x-access-token:***@github.com");
  });

  it("has the Environment's Secrets taken out of its lines by the Workspace DO, after the token", async () => {
    const seen: string[] = [];

    const { logged } = await handle(
      post(`status=1\nuptime=3\n\ntoken ${TOKEN} key sk-live-0123\n`),
      async (output) => {
        seen.push(output);

        return output.replaceAll("sk-live-0123", "<API_KEY>");
      },
    );

    expect(seen).toEqual(["token *** key sk-live-0123"]);
    expect(logged[0]).toMatchObject({ output: "token *** key <API_KEY>", withheld: null });
  });

  it("is logged without its lines, with its status and uptime and why, when the DO cannot take the Secrets out", async () => {
    const body = "status=137\nuptime=42\n\nkey sk-live-0123\n";

    for (const redact of [
      async () => undefined,
      async () => {
        throw new Error("the Durable Object is unreachable");
      },
    ] satisfies ExitReportRedaction[]) {
      const { response, logged } = await handle(post(body), redact);

      expect(response.status).toBe(204);
      expect(logged).toEqual([
        {
          message: "workspace.container.output",
          workspace: "do-1",
          status: 137,
          uptimeSeconds: 42,
          output: "",
          withheld: WITHHELD_OUTPUT,
        },
      ]);
      expect(JSON.stringify(logged)).not.toContain("sk-live-0123");
    }
  });

  it("keeps what it can read of a body that is not the supervisor's", () => {
    expect(parseExitReport("status=nope\n", "do-1")).toEqual({
      message: "workspace.container.output",
      workspace: "do-1",
      status: null,
      uptimeSeconds: null,
      output: "",
      withheld: null,
    });
  });

  it("is read up to its limit, and the rest is not", async () => {
    const { logged } = await handle(
      post(`status=1\nuptime=1\n\n${"x".repeat(EXIT_REPORT_BYTES * 4)}`),
    );

    expect(logged[0]?.output.length).toBeLessThanOrEqual(EXIT_REPORT_BYTES + 1_024);
    expect(logged[0]?.output.length).toBeGreaterThan(EXIT_REPORT_BYTES);
  });

  it("is posted to its own path: nothing else is logged", async () => {
    const elsewhere = await handle(post("status=1\n\nhi", "/api"));
    const fetched = await handle(new Request(url(EXIT_REPORT_PATH)));

    expect(elsewhere.response.status).toBe(404);
    expect(fetched.response.status).toBe(405);
    expect([...elsewhere.logged, ...fetched.logged]).toEqual([]);
  });
});

describe("the report host", () => {
  const platform = (calls: string[]): IWorkspaceContainerAPI => ({
    start: async () => {
      calls.push("start");

      return { runtimeId: "r1", clientSecret: "s", outcome: "launched" };
    },
    restart: async () => {
      calls.push("restart");

      return { runtimeId: "r2", clientSecret: "s", outcome: "launched" };
    },
    interceptOutboundHttp: async (host) => {
      calls.push(`intercept ${host}`);
    },
    interceptAllOutboundHttp: async () => undefined,
    status: async () => ({ running: true, exit: null }),
    exitInfo: async () => null,
    setInactivityTimeout: async () => undefined,
    fetchPort: async () => new Response("ok"),
    port: () => {
      throw new Error("not used");
    },
  });

  it("is intercepted right after computer's own egress host, and again after a restart", async () => {
    const calls: string[] = [];

    const api = withExitReports(
      platform(calls),
      async () => {
        calls.push("reports");
      },
      () => undefined,
    );

    await api.start({ env: {}, enableInternet: true });
    await api.interceptOutboundHttp("computer.internal", { binding: "WORKSPACES", id: "do-1" });
    await api.restart({ env: {}, enableInternet: true });

    expect(calls).toEqual([
      "start",
      "intercept computer.internal",
      "reports",
      "restart",
      "reports",
    ]);
  });

  it("that cannot be intercepted leaves the Container to run without reports", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    const api = withExitReports(
      platform(calls),
      async () => {
        throw new Error("You can't configure more than 128 egress interceptors");
      },
      (message) => warnings.push(message),
    );

    await api.interceptOutboundHttp("computer.internal", { binding: "WORKSPACES", id: "do-1" });

    expect(calls).toEqual(["intercept computer.internal"]);
    expect(warnings).toEqual([
      "The Container's exit reports could not be routed (You can't configure more than 128 egress interceptors): it runs without them",
    ]);
  });
});
