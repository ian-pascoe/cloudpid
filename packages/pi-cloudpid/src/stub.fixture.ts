// @effect-diagnostics *:off -- a test fixture, on the owner's machine, not Effect code.
/**
 * The test fixtures of `/cloudpid`: a stub endpoint (cloudpid's own handler, `serveMcp`, over a fake `api` that keeps
 * an import in memory), a checkout with a bare remote to import from, and a scripted pi UI.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveMcp, toolGate, unobserved, type McpServerApi } from "@cloudpid/mcp/server";
import { apiFailure, apiOk, MAX_MCP_SLICE_BYTES, MCP_API_LIMITS } from "@cloudpid/protocol/mcp-api";
import { MCP_TOOL_OPERATIONS } from "@cloudpid/protocol/mcp-tools";
import type { Config } from "./config.ts";
import { connectEndpoint, type Endpoint } from "./endpoint.ts";
import type { Ui } from "./flow.ts";

// The owner's own git config (identity, url rewrites, hooks) must not reach a test: `gitIn` runs with the process's environment.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

process.env.GIT_CONFIG_NOSYSTEM = "1";

export const ENDPOINT_URL = "https://cloudpid.test/mcp";

export const ORIGIN = "https://github.com/acme/app.git";

/** One import the stub holds. */
export interface StubImport {
  readonly id: string;
  readonly request: Parameters<McpServerApi["importBegin"]>[0];
  /** The bytes appended so far, as the endpoint holds them. */
  chunks: Array<Buffer>;
  received: number;
  /** Every append the stub accepted: [offset, bytes]. */
  appends: Array<readonly [offset: number, bytes: number]>;
  finished: { readonly sha256: string } | undefined;
  cancelled: boolean;
}

export interface StubOptions {
  /** `max_slice_bytes` begin answers; small, to make the file several slices. */
  readonly maxSliceBytes?: number;
  /** Branch names another Workspace holds (`branch_taken`). */
  readonly taken?: ReadonlyArray<string>;
  /** The Environments `environments_list` answers. */
  readonly environments?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly urls: ReadonlyArray<string>;
  }>;
  /** Appends to answer `offset_mismatch` the first time, by the nth (1-based) append. */
  readonly mismatchAt?: number;
  /** The status finish answers. */
  readonly status?: "idle" | "importing";
  /** The tools (by operation) the endpoint serves; all by default. */
  readonly operations?: ReadonlyArray<string>;
  /** The `carry_ref` begin answers, in place of the import's own: a stale one, to see it deleted. */
  readonly carryRef?: string;
  /** The HTTP status to answer every request with, as Access does for a token it does not know. */
  readonly httpStatus?: number;
}

export interface Stub {
  readonly imports: Array<StubImport>;
  /** The headers of every request that reached the endpoint. */
  readonly headers: Array<Headers>;
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly endpoint: (config: Config) => Promise<Endpoint>;
}

const textOf = (chunks: ReadonlyArray<Buffer>): string => Buffer.concat(chunks).toString("utf8");

export const receivedText = (held: StubImport): string => textOf(held.chunks);

export const stubEndpoint = (options: StubOptions = {}): Stub => {
  const imports: Array<StubImport> = [];
  const headers: Array<Headers> = [];
  let appends = 0;
  let mismatched = false;

  const byId = (id: string) => imports.find((held) => held.id === id);

  const missing = apiFailure("not_found", "No such import.");

  const api: McpServerApi = {
    describe: () => ({
      operations: options.operations ?? Object.values(MCP_TOOL_OPERATIONS),
      limits: MCP_API_LIMITS,
    }),
    environments: () =>
      Promise.resolve(
        apiOk({
          environments: (
            options.environments ?? [{ id: "env-1", name: "Default", urls: [ORIGIN] }]
          ).map((environment) => ({
            id: environment.id,
            name: environment.name,
            default: true,
            repos: environment.urls.map((url, index) => ({ name: `repo${String(index)}`, url })),
            running_sessions: 0,
          })),
          models: { available: ["m1"], default: "m1" },
        }),
      ),
    sessions: () => Promise.resolve(apiOk({ sessions: [] })),
    session: () => Promise.resolve(apiFailure("not_found", "No Session.")),
    transcript: () => Promise.resolve(apiFailure("unsupported", "No.")),
    start: () => Promise.resolve(apiFailure("unsupported", "No.")),
    send: () => Promise.resolve(apiFailure("unsupported", "No.")),
    stop: () => Promise.resolve(apiFailure("unsupported", "No.")),
    wait: () => Promise.resolve(apiFailure("unsupported", "No.")),
    importBegin: (request) => {
      if (request.branch !== undefined && options.taken?.includes(request.branch) === true) {
        return Promise.resolve(
          apiFailure("branch_taken", `Another Workspace is already on branch ${request.branch}.`, {
            details: {
              workspace: "ws-1",
              sessions: [
                {
                  id: "s-1",
                  url: "https://cloudpid.test/sessions/s-1",
                  title: "Earlier work",
                  status: "idle",
                },
              ],
            },
          }),
        );
      }

      const id = randomUUID();

      imports.push({
        id,
        request,
        chunks: [],
        received: 0,
        appends: [],
        finished: undefined,
        cancelled: false,
      });

      return Promise.resolve(
        apiOk({
          import_id: id,
          session_id: id,
          url: `https://cloudpid.test/sessions/${id}`,
          received: 0,
          max_slice_bytes: options.maxSliceBytes ?? MAX_MCP_SLICE_BYTES,
          expires_at: "2099-01-01T00:00:00.000Z",
          carry_ref: options.carryRef ?? `refs/cloudpid/import/${id}`,
        }),
      );
    },
    importAppend: (request) => {
      const held = byId(request.import_id);

      if (held === undefined) return Promise.resolve(missing);

      appends += 1;

      if (options.mismatchAt === appends && !mismatched) {
        mismatched = true;

        return Promise.resolve(
          apiFailure("offset_mismatch", "offset is not where the import ends.", {
            details: { received: held.received },
          }),
        );
      }

      if (request.offset !== held.received) {
        return Promise.resolve(
          apiFailure("offset_mismatch", "offset is not where the import ends.", {
            details: { received: held.received },
          }),
        );
      }

      const bytes = Buffer.from(request.data, "utf8");

      held.chunks.push(bytes);
      held.appends.push([request.offset, bytes.length]);
      held.received += bytes.length;

      return Promise.resolve(apiOk({ received: held.received }));
    },
    importFinish: (request) => {
      const held = byId(request.import_id);

      if (held === undefined) return Promise.resolve(missing);

      if (held.received !== held.request.size_bytes) {
        return Promise.resolve(
          apiFailure("offset_mismatch", "bytes are missing.", {
            details: { received: held.received },
          }),
        );
      }

      if (
        createHash("sha256").update(Buffer.concat(held.chunks)).digest("hex") !== request.sha256
      ) {
        return Promise.resolve(apiFailure("checksum_mismatch", "the sha256 is not the file's."));
      }

      held.finished = { sha256: request.sha256 };

      return Promise.resolve(
        apiOk({
          session_id: held.id,
          status: options.status ?? "idle",
          url: `https://cloudpid.test/sessions/${held.id}`,
          cursor: "1",
          summary: { cut: 0, dropped: { "custom:other": 2 }, closed: 0 },
          warnings: [],
        }),
      );
    },
    importCancel: (request) => {
      const held = byId(request.import_id);

      if (held !== undefined) held.cancelled = true;

      return Promise.resolve(apiOk({ cancelled: true as const }));
    },
    auth: "service_token",
  };

  const gate = toolGate();

  const fetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);

    headers.push(request.headers);

    if (options.httpStatus !== undefined) {
      return Promise.resolve(new Response("Forbidden", { status: options.httpStatus }));
    }

    return serveMcp(request, { api, version: "stub", gate, observe: unobserved });
  };

  return {
    imports,
    headers,
    fetch,
    endpoint: (config) => connectEndpoint(config, { fetch, sleep: () => Promise.resolve() }),
  };
};

/** Git in `cwd`, for a test's own set-up; output trimmed. */
export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

export interface Checkout {
  /** The directory the test made everything in. */
  readonly directory: string;
  /** The owner's checkout. */
  readonly work: string;
  /** The remote `origin` points at (a bare repo; the URL git sees is rewritten to it). */
  readonly remote: string;
  readonly cleanup: () => void;
}

/**
 * A checkout of a repo with one commit on `main`, whose `origin` is `ORIGIN` (the URL an Environment lists) and is
 * served from a bare repo beside it, as `url.<path>.insteadOf` would on a laptop.
 */
export const makeCheckout = (): Checkout => {
  const directory = mkdtempSync(join(tmpdir(), "pi-cloudpid-test-"));
  const remote = join(directory, "remote.git");
  const work = join(directory, "work");

  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=main", "--quiet");
  mkdirSync(work);
  git(work, "init", "--initial-branch=main", "--quiet");
  git(work, "config", "user.name", "Owner");
  git(work, "config", "user.email", "owner@example.test");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "remote.origin.url", ORIGIN);
  git(work, "config", `url.${remote}.insteadOf`, ORIGIN);
  git(work, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  writeFileSync(join(work, "README.md"), "# app\n");
  writeFileSync(join(work, "tracked.txt"), "one\n");
  writeFileSync(join(work, ".gitignore"), "*.env\nbuild/\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "push", "--quiet", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");

  return {
    directory,
    work,
    remote,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

/** A scripted pi UI: answers in order, and keeps every prompt it was asked. */
export interface ScriptedUi extends Ui {
  readonly asked: Array<{
    readonly kind: string;
    readonly title: string;
    readonly message: string;
  }>;
  readonly notices: Array<{ readonly message: string; readonly type: string }>;
}

export const scriptedUi = (answers: {
  readonly confirm?: ReadonlyArray<boolean>;
  readonly editor?: ReadonlyArray<string | undefined>;
  readonly select?: ReadonlyArray<
    string | ((options: ReadonlyArray<string>) => string) | undefined
  >;
}): ScriptedUi => {
  const confirms = [...(answers.confirm ?? [])];
  const editors = [...(answers.editor ?? [])];

  const selects = (answers.select ?? []).map((answer) =>
    Predicate.isFunction(answer) ? answer : () => answer,
  );

  const asked: ScriptedUi["asked"] = [];
  const notices: ScriptedUi["notices"] = [];

  return {
    asked,
    notices,
    confirm: (title, message) => {
      asked.push({ kind: "confirm", title, message });

      return Promise.resolve(confirms.shift() ?? false);
    },
    editor: (title, prefill) => {
      asked.push({ kind: "editor", title, message: prefill ?? "" });

      return Promise.resolve(editors.shift());
    },
    select: (title, options) => {
      asked.push({ kind: "select", title, message: options.join("\n") });

      return Promise.resolve(selects.shift()?.(options));
    },
    notify: (message, type = "info") => {
      notices.push({ message, type });
    },
    setStatus: () => undefined,
  };
};

export interface DiskSession {
  readonly manager: SessionManager;
  readonly cleanup: () => void;
}

/** A pi Session on disk with a conversation and a title, made by pi's own SessionManager. */
export const makeSession = (): DiskSession => {
  const directory = mkdtempSync(join(tmpdir(), "pi-cloudpid-session-"));
  const manager = SessionManager.create(directory, directory);

  manager.appendMessage({ role: "user", content: "Fix the flaky test ✓ 日本語 🎉", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "On it." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  manager.appendSessionInfo("Flaky test");

  return { manager, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};
