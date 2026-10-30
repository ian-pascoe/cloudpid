#!/usr/bin/env node
// PROTOTYPE (#383), throwaway. The cost of a stdio server's first answer: spawn it, send `initialize`, time the reply.
// Each server runs with a fresh package cache (cold: the download included) and once more on that cache (warm). No
// dependencies, so it runs on a cloudpid Container as is. There, `CACHE_ROOT=/root KEEP=1 node cold.mjs` keeps the
// caches on the disk a Snapshot holds; after the idle stop, the same command finds them and times one start on each
// (restored).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SERVERS = [
  {
    name: "everything (npx)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything@2.1.0"],
  },
  {
    name: "filesystem (npx)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  },
  { name: "time (uvx)", command: "uvx", args: ["mcp-server-time"] },
  { name: "fetch (uvx)", command: "uvx", args: ["mcp-server-fetch"] },
];

const initialize = (server, env) =>
  new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn(server.command, server.args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    createInterface({ input: proc.stderr }).on("line", (l) => stderr.push(l));
    const timer = setTimeout(
      () => done(`timeout; stderr: ${stderr.slice(-3).join(" | ")}`),
      180_000,
    );
    const done = (outcome) => {
      clearTimeout(timer);
      proc.kill();
      resolve({ ms: Date.now() - start, outcome });
    };
    createInterface({ input: proc.stdout }).on("line", (line) => {
      try {
        if (JSON.parse(line).id === 1) done("ok");
      } catch {}
    });
    proc.on("exit", (code) => done(`exited ${code}; stderr: ${stderr.slice(-3).join(" | ")}`));
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "p383", version: "0" },
        },
      })}\n`,
    );
  });

const root = process.env.CACHE_ROOT ?? tmpdir();
for (const server of SERVERS) {
  const cache = join(root, "p383-cache", server.name.replace(/\W+/g, "-"));
  const restored = existsSync(cache);
  mkdirSync(cache, { recursive: true });
  const env = {
    npm_config_cache: join(cache, "npm"),
    UV_CACHE_DIR: join(cache, "uv"),
    UV_TOOL_DIR: join(cache, "uv-tools"),
  };
  if (restored) {
    const run = await initialize(server, env);
    console.log(`${server.name.padEnd(18)} restored ${String(run.ms).padStart(6)} ms (${run.outcome})`);
    continue;
  }
  const cold = await initialize(server, env);
  const warm = await initialize(server, env);
  console.log(
    `${server.name.padEnd(18)} cold ${String(cold.ms).padStart(6)} ms (${cold.outcome})   warm ${String(warm.ms).padStart(6)} ms (${warm.outcome})   cache ${cache}`,
  );
  if (!process.env.KEEP) rmSync(cache, { recursive: true, force: true });
}
