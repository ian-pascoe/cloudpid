// @effect-diagnostics nodeBuiltinImport:off -- node:crypto makes the test GitHub App's key; this config runs in Node.
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config, { testTimeout } from "@cloudpid/config/vitest";
import { WEB_NOT_FOUND_HANDLING } from "./src/assets-config.ts";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/** A GitHub App's private key (PKCS#1 PEM, as GitHub hands it out) for the Workspaces that mint tokens in a test. */
const githubAppKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

/** The asset tests need the `ASSETS` binding, which only their own test Worker has. */
const webAssets = "src/assets.workerd.test.ts";

/**
 * A file's first Durable Object call starts its objects cold, and a `beforeAll` that makes it (`files.workerd.test.ts`'s
 * writes) took over Vitest's 10 s default on CI's runners, though not stuck: hooks get the tests' timeout.
 */
const hookTimeout = testTimeout;

/**
 * Tests of the Workspace DO alone, in a test Worker that hosts it and the Worker Shell's loader: the environment
 * conformance cases, the Changes, the Comparisons, the Run copies and the read of unpushed work (over repos real git
 * made, `changes.setup.ts` and `comparison.setup.ts`), the Container previews and the MCP bridge.
 */
const workspaceOnly = [
  "src/workspace/env.workerd.test.ts",
  "src/workspace/container-preview.workerd.test.ts",
  "src/workspace/mcp-bridge.workerd.test.ts",
  "src/workspace/changes*.workerd.test.ts",
  "src/workspace/comparison*.workerd.test.ts",
  "src/workspace/github-token*.workerd.test.ts",
  "src/workspace/runs*.workerd.test.ts",
  "src/workspace/work-state*.workerd.test.ts",
  "src/workspace/notify.workerd.test.ts",
];

/** Every other Workspace test (Sessions and tools on a Workspace) runs in a test Worker that also hosts a Session host. */
const onWorkspace = "src/workspace/**/*.workerd.test.ts";

/** Node tests use the shared base; `*.workerd.test.ts` run inside workerd, against real Durable Object storage and alarms. */
export default defineConfig({
  test: {
    projects: [
      mergeConfig(
        config,
        defineProject({ test: { name: "node", exclude: [...configDefaults.exclude, workerd] } }),
      ),
      defineProject({
        // Project-wide, for the `workerd` project only: every `workerd` test file resolves `@alchemy.run/cloudflare` to `registry/alchemy.fixture.ts`, a stub of
        // only what `registry/Registry.ts` reads when it loads (the package itself cannot load in workerd). The real Registry
        // runs in a test Durable Object (`registry/registry.fixture.ts`); a test that needs more from Alchemy extends the stub.
        resolve: {
          alias: {
            "@alchemy.run/cloudflare": fileURLToPath(
              new URL("./src/registry/alchemy.fixture.ts", import.meta.url).href,
            ),
          },
        },
        plugins: [
          cloudflareTest({
            main: "./src/workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                SESSIONS: { className: "TestSession", useSQLite: true },
                SUBAGENT_SESSIONS: { className: "TestSubagentSession", useSQLite: true },
                REGISTRIES: { className: "TestRegistry", useSQLite: true },
                REAL_REGISTRIES: { className: "RealRegistry", useSQLite: true },
                MCP_HOSTS: { className: "TestMcpHost", useSQLite: true },
                TRIGGERS: { className: "TestTrigger", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workerd",
          testTimeout,
          hookTimeout,
          include: [workerd],
          exclude: [...configDefaults.exclude, "src/workspace/**", webAssets],
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/assets-worker.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              // The real asset layer, as the deploy configures the web app's, `WEB_NOT_FOUND_HANDLING` included.
              assets: {
                directory: "./src/assets.fixture",
                binding: "ASSETS",
                assetConfig: { not_found_handling: WEB_NOT_FOUND_HANDLING },
              },
            },
          }),
        ],
        test: { name: "workerd-assets", testTimeout, include: [webAssets] },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/workspace/workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                WORKSPACES: { className: "TestWorkspace", useSQLite: true },
              },
              workerLoaders: { LOADER: {} },
              // The key the Workspace DO seals its copy of the Environment's Secrets under.
              bindings: {
                SECRETS_ENCRYPTION_KEY: "test-master-key-0123456789abcdef0123456789",
                // The GitHub App of a Workspace named with `GITHUB_APP_WORKSPACE` (`TestWorkspace`); no other Workspace has one.
                TEST_GITHUB_APP_ID: "123456",
                TEST_GITHUB_APP_PRIVATE_KEY: githubAppKey,
              },
            },
          }),
        ],
        test: {
          name: "workerd-workspace",
          include: workspaceOnly,
          testTimeout,
          hookTimeout,
          // Real git makes the repos the Changes and Comparison tests read, in Node (`inject("changesRepos")`,
          // `inject("comparisonRepos")`).
          globalSetup: ["./src/workspace/changes.setup.ts", "./src/workspace/comparison.setup.ts"],
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/workspace/session.workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                WORKSPACES: { className: "TestWorkspace", useSQLite: true },
                WORKSPACE_SESSIONS: { className: "TestWorkspaceSession", useSQLite: true },
                CODEMODE_SESSIONS: { className: "TestCodemodeSession", useSQLite: true },
                MCP_CODEMODE_SESSIONS: { className: "TestMcpCodemodeSession", useSQLite: true },
                CODEMODE_SANDBOX: { className: "CodemodeSandbox", useSQLite: true },
              },
              // The Session's `read` prepares images with it; miniflare emulates it with sharp.
              images: { binding: "IMAGES" },
              workerLoaders: { LOADER: {} },
              // pi-codemode's QuickJS engine is a `.wasm` import, which Wrangler compiles by default.
              modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
            },
          }),
        ],
        test: {
          name: "workerd-session",
          testTimeout,
          hookTimeout,
          include: [onWorkspace],
          exclude: [...configDefaults.exclude, ...workspaceOnly],
        },
      }),
    ],
  },
});
