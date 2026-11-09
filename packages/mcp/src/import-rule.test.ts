/**
 * The import rule's lint test (docs/architecture/mcp.md → Packages and objects): oxlint's `no-restricted-imports`
 * fails an `@modelcontextprotocol/*` import outside `packages/mcp`, and `apps/web` may import types only from
 * `@modelcontextprotocol/ext-apps`. Each case plants a file in a real package, so that package's own `.oxlintrc.json`
 * decides, and runs oxlint on it as the package's `lint` script does.
 */
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off nodeBuiltinImport:off preferEffectArray:off
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

const root = (path: string) => resolve(import.meta.dirname, "../../..", path);

const OXLINT = root("node_modules/.bin/oxlint");

/** A planted import statement and whether `no-restricted-imports` must report it. */
type Planted = readonly [statement: string, reported: boolean];

const planted = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...planted].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  planted.clear();
});

/**
 * Plants each of `statements` in a file of its own, so one parse error cannot hide another case's report. The files
 * are in `.gitignore` (`planted-*`), so a crashed run leaves nothing to commit.
 */
const reportedCases = async (packageDirectory: string, statements: ReadonlyArray<string>) => {
  const directory = root(`${packageDirectory}/src/planted-${crypto.randomUUID()}`);

  planted.add(directory);
  await mkdir(directory, { recursive: true });

  // Named files, not the directory: oxlint skips `planted-*` directories (`.gitignore`) when it walks one.
  const files = statements.map((_statement, index) => `${directory}/case-${index}.ts`);

  await Promise.all(files.map((file, index) => writeFile(file, `${statements[index]}\n`)));

  const { stdout } = await run(OXLINT, ["--format=unix", ...files], {
    cwd: root(packageDirectory),
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));

  return stdout
    .split("\n")
    .filter((line) => line.includes("no-restricted-imports"))
    .map((line) => Number(/case-(\d+)\.ts/.exec(line)?.[1]))
    .sort((a, b) => a - b);
};

const check = async (packageDirectory: string, cases: ReadonlyArray<Planted>) => {
  const reported = await reportedCases(
    packageDirectory,
    cases.map(([statement]) => statement),
  );

  expect(reported).toEqual(cases.flatMap(([, reported], index) => (reported ? [index] : [])));
};

describe("only packages/mcp imports @modelcontextprotocol/*", () => {
  it("fails a planted import in apps/server", async () => {
    await check("apps/server", [
      [`import { Client } from "@modelcontextprotocol/client";`, true],
      [`import type { Tool } from "@modelcontextprotocol/client";`, true],
      [`import { type Tool } from "@modelcontextprotocol/client";`, true],
      [`import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";`, true],
      [`import { createMcpHandler } from "@modelcontextprotocol/server";`, true],
      [`import { ZodError } from "@modelcontextprotocol/core";`, true],
      [`import { tasks } from "@modelcontextprotocol/ext-tasks";`, true],
      [`import { App } from "@modelcontextprotocol/ext-apps";`, true],
      [`export { Client } from "@modelcontextprotocol/client";`, true],
      [`import "@modelcontextprotocol/client";`, true],
    ]);
  });
});

describe("packages/pi-cloudpid runs on the owner's machine", () => {
  it("fails what belongs to the Workers side", async () => {
    await check("packages/pi-cloudpid", [
      [`import { env } from "cloudflare:workers";`, true],
      [`import type { Fetcher } from "@cloudflare/workers-types";`, true],
      [`import { Computer } from "@cloudflare/computer";`, true],
      [`import "workerd";`, true],
      [`import { Resource } from "alchemy";`, true],
      [`import { Worker } from "alchemy/cloudflare";`, true],
      [`import { Worker } from "@alchemy.run/cloudflare";`, true],
      [`import { Harness } from "@earendil-works/pi-durable";`, true],
      [`import { Todo } from "@cloudpid/extensions/todo";`, true],
      [`import { Todo } from "@cloudpid/extensions";`, true],
    ]);
  });

  it("imports the SDK's client and nothing else of the SDK", async () => {
    await check("packages/pi-cloudpid", [
      [`import { Client } from "@modelcontextprotocol/client";`, false],
      [`import { createMcpHandler } from "@modelcontextprotocol/server";`, true],
      [`import { ZodError } from "@modelcontextprotocol/core";`, true],
      [`import { tasks } from "@modelcontextprotocol/ext-tasks";`, true],
      [`import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";`, true],
    ]);
  });

  it("imports only types from @cloudpid/protocol", async () => {
    await check("packages/pi-cloudpid", [
      [`import type { SessionImportBeginInput } from "@cloudpid/protocol/mcp-tools";`, false],
      [`import { type SessionImportBeginInput } from "@cloudpid/protocol/mcp-tools";`, false],
      [`import type { MAX_TITLE_LENGTH } from "@cloudpid/protocol";`, false],
      [`export type { ApiResult } from "@cloudpid/protocol/mcp-api";`, false],
      [`import { MAX_TITLE_LENGTH } from "@cloudpid/protocol";`, true],
      [`import { apiOk } from "@cloudpid/protocol/mcp-api";`, true],
      [`import { type ApiResult, apiOk } from "@cloudpid/protocol/mcp-api";`, true],
      [`import "@cloudpid/protocol/mcp-tools";`, true],
    ]);
  });
});

describe("apps/web imports types only from @modelcontextprotocol/ext-apps", () => {
  it("passes a type-only import and fails every other", async () => {
    await check("apps/web", [
      [`import type { App } from "@modelcontextprotocol/ext-apps";`, false],
      [`import { type App } from "@modelcontextprotocol/ext-apps";`, false],
      [`import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";`, false],
      [`import { type AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";`, false],
      [`export type { App } from "@modelcontextprotocol/ext-apps";`, false],
      [`import { App } from "@modelcontextprotocol/ext-apps";`, true],
      [`import { type App, applyHostStyles } from "@modelcontextprotocol/ext-apps";`, true],
      [`import { useApp } from "@modelcontextprotocol/ext-apps/react";`, true],
      [`import "@modelcontextprotocol/ext-apps";`, true],
      [`import { Client } from "@modelcontextprotocol/client";`, true],
      [`import type { Tool } from "@modelcontextprotocol/client";`, true],
      [`import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";`, true],
      [`import { createMcpHandler } from "@modelcontextprotocol/server";`, true],
      [`import { ZodError } from "@modelcontextprotocol/core";`, true],
      [`import { tasks } from "@modelcontextprotocol/ext-tasks";`, true],
      [`import { Client } from "@modelcontextprotocol/sdk/client/index.js";`, true],
      [`import type { Client } from "@modelcontextprotocol/sdk";`, true],
      [`import { createServer } from "@modelcontextprotocol/node";`, true],
    ]);
  });
});
