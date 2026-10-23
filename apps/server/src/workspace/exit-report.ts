// The Container's account of why it stopped (docs/spec.md → Container and Toolchains → Exit reports). The platform keeps
// a Container's output where no API reads it, and computer logs only that the Container exited, so a computerd that
// dies left nothing in the Workers logs to say why. The image's supervisor (`apps/sandbox-image/image/supervise`) posts
// computerd's status and last lines to `EXIT_REPORT_HOST` when computerd exits on its own; the Workspace DO intercepts
// that host for each Container it starts (`withExitReports`), and `ContainerExitReports` (`worker.ts`) logs the report
// with `exitReport`.
//
// Anything running in the Container can post one, so a report is treated as the Container's output, not as fact: it is
// only ever logged, cut to size, with the GitHub token taken out, and with the Environment's kept Secrets taken out by
// the Workspace DO that holds them (`redact`); a report it cannot show free of them is logged without its lines.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { EXIT_REPORT_BYTES, EXIT_REPORT_PATH } from "@cloudpid/sandbox-image/supervisor";

/** The most of a report's body that is read, in bytes: the supervisor's lines and its two header lines. */
const MAX_BODY_BYTES = EXIT_REPORT_BYTES + 1_024;

/** What the Workspace DO gives `ContainerExitReports` when it intercepts the report host for its Container. */
export type ExitReportProps = {
  /** The Workspace DO's id. */
  readonly workspace: string;
};

/** What a report says, as logged. */
export type ExitReport = {
  readonly message: "workspace.container.output";
  /** The Workspace DO's id, which is also the Container instance's in the dashboard. */
  readonly workspace: string;
  /** computerd's exit status as the supervisor saw it (128 + the signal for one killed by a signal); null if unreadable. */
  readonly status: number | null;
  /** How long computerd ran, in seconds; null if unreadable. */
  readonly uptimeSeconds: number | null;
  /** computerd's last lines, oldest first; empty when they were withheld. */
  readonly output: string;
  /** Why the lines were withheld, or null when they are logged. */
  readonly withheld: string | null;
};

/**
 * Takes the Environment's kept Secrets out of a report's lines: undefined when the Workspace DO cannot show them free of
 * those (its copy does not open, or the DO cannot be reached).
 */
export type ExitReportRedaction = (output: string) => Promise<string | undefined>;

/** Why a report's lines are withheld when they cannot be shown free of the Environment's Secrets. */
export const WITHHELD_OUTPUT =
  "the lines are withheld: the Workspace could not take its Environment's Secrets out of them";

const header = (lines: readonly string[], name: string): number | null => {
  const value = lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);

  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
};

/** Reads the supervisor's body (`status=…`, `uptime=…`, a blank line, the output) and takes the secret out of it. */
export const parseExitReport = (
  body: string,
  workspace: string,
  secret: string | undefined,
): ExitReport => {
  const clean = secret === undefined || secret === "" ? body : body.replaceAll(secret, "***");
  const split = clean.indexOf("\n\n");
  const head = (split < 0 ? clean : clean.slice(0, split)).split("\n");

  return {
    message: "workspace.container.output",
    workspace,
    status: header(head, "status"),
    uptimeSeconds: header(head, "uptime"),
    output: split < 0 ? "" : clean.slice(split + 2).trimEnd(),
    withheld: null,
  };
};

/** `report` with its lines passed through `redact`, or withheld when that cannot be done (it never throws). */
export const redactExitReport = async (
  report: ExitReport,
  redact: ExitReportRedaction,
): Promise<ExitReport> => {
  if (report.output === "") return report;

  const output = await redact(report.output).catch(() => undefined);

  return output === undefined
    ? { ...report, output: "", withheld: WITHHELD_OUTPUT }
    : { ...report, output };
};

/** A body of at most `MAX_BODY_BYTES`: the rest of a longer one is not read. */
const readCapped = async (request: Request): Promise<string> => {
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(value);
    size += value.length;
  }

  await reader.cancel().catch(() => undefined);

  const bytes = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let at = 0;

  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at);

    bytes.set(part, at);
    at += part.length;
  }

  return new TextDecoder().decode(bytes);
};

/** Answers a request to the report host: a report is logged with `log`, anything else is refused. */
export const exitReport = async (
  request: Request,
  options: {
    readonly workspace: string;
    readonly secret: string | undefined;
    /** Takes the Environment's kept Secrets out of the lines (`ExitReportRedaction`). */
    readonly redact: ExitReportRedaction;
    readonly log: (report: ExitReport) => void;
  },
): Promise<Response> => {
  if (new URL(request.url).pathname !== EXIT_REPORT_PATH) {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const parsed = parseExitReport(await readCapped(request), options.workspace, options.secret);

  options.log(await redactExitReport(parsed, options.redact));

  return new Response(null, { status: 204 });
};

/**
 * `api` with the report host intercepted for each Container it launches: computer intercepts its own egress host after
 * every start, which is when `intercept` runs too, and again after a restart, which computer does not repeat. An
 * intercept lasts as long as its Container. One that cannot be set is reported and changes nothing else: the
 * Container then runs as before, without a report when it stops.
 */
export const withExitReports = (
  api: IWorkspaceContainerAPI,
  intercept: () => Promise<void>,
  warn: (message: string) => void,
): IWorkspaceContainerAPI => {
  const register = async () => {
    try {
      await intercept();
    } catch (cause) {
      warn(
        `The Container's exit reports could not be routed (${cause instanceof Error ? cause.message : String(cause)}): it runs without them`,
      );
    }
  };

  return {
    start: (spec) => api.start(spec),
    restart: async (spec) => {
      const info = await api.restart(spec);

      await register();

      return info;
    },
    interceptOutboundHttp: async (host, workspace) => {
      await api.interceptOutboundHttp(host, workspace);
      await register();
    },
    interceptAllOutboundHttp: (workspace, token) => api.interceptAllOutboundHttp(workspace, token),
    fetchPort: (port, input, init) => api.fetchPort(port, input, init),
    port: (port) => api.port(port),
    setInactivityTimeout: (durationMs) => api.setInactivityTimeout(durationMs),
    status: () => api.status(),
    exitInfo: () => api.exitInfo(),
  };
};
