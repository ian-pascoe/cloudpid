// The Server Worker's startup budget (`docs/development/workers.md` → Startup). The platform refuses a version whose
// global scope takes more than its startup CPU limit (`ScriptStartupError`, code 10021) when the deploy uploads it, so
// CI checks the startup here first, on a pull request, against two budgets:
//
// - the bytes of the modules the Worker's global scope evaluates (the entry chunk and its static imports): deterministic,
//   and what the parse and most of the evaluation scale with;
// - the CPU time of that evaluation in workerd, profiled as `wrangler check startup` does (a module that `import()`s the
//   entry, under the inspector's CPU profiler), the median of `RUNS` fresh isolates. Machines differ, so this budget is the
//   coarse one.
//
// The bundle is alchemy's own (`WorkerBundle`, as a deploy makes it: the generated entry, rolldown's Cloudflare plugins,
// minified), written with its profile to `node_modules/.cache/startup/`. Run it with Node (Bun's WebSocket loses the
// inspector's answers):
//
//   bun run --cwd apps/server startup
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { SERVER_COMPATIBILITY, SERVER_DURABLE_OBJECTS } from "../src/worker-shape.ts";

/** The startup modules' bytes: the guard that does not depend on the machine (the figures are in `workers.md` → Startup). */
const BYTES_BUDGET = 1024 * 1024;

/** The startup's CPU time, median, in ms: about 2.5 times the Server's on a laptop. The platform's limit is 1 s. */
const CPU_BUDGET_MS = 120;

const RUNS = Number(process.env.RUNS ?? 5);

const main = new URL("../src/worker.ts", import.meta.url).href;

/** The compatibility the deploy bundles and uploads with: `getCompatibility`, alchemy's default flags added. */
const deployed = getCompatibility({ compatibility: SERVER_COMPATIBILITY, main });

const out = fileURLToPath(new URL("../node_modules/.cache/startup/", import.meta.url));

const bundle = await Effect.runPromise(
  Effect.gen(function* () {
    const bundler = yield* WorkerBundle;

    return yield* bundler.build({
      id: "Server",
      main,
      compatibility: deployed,
      // The generated entry exports the Worker's Durable Object classes (`worker-init.ts`'s Layers), as a plan finds them.
      entry: {
        kind: "effect",
        exports: Object.fromEntries(
          SERVER_DURABLE_OBJECTS.map((name) => [name, { kind: "durableObject" }]),
        ),
      },
      stack: { name: "cloudpid", stage: "prod" },
      extraOptions: undefined,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

await rm(out, { recursive: true, force: true });

const modules = [];

for (const file of bundle.files) {
  const path = join(out, file.path);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.content);

  if (file.path.endsWith(".js")) modules.push({ path: file.path, code: String(file.content) });
}

const ENTRY = "worker.js";
const byPath = new Map(modules.map((module) => [module.path, module]));

/** A chunk's static imports (`import … from "./x.js"`, `import "./x.js"`, `export … from "./x.js"`), not its `import()`s. */
const staticImports = (module) =>
  Array.from(
    module.code.matchAll(
      /(?:^|[;}\n])\s*(?:import|export)\s*(?:[^'"()]*?from\s*)?["'](\.\/[^"']+)["']/g,
    ),
    (match) => posix.join(posix.dirname(module.path), match[1]),
  );

/** The entry and every chunk it reaches through static imports: what the global scope evaluates. */
const startupModules = new Map();

const visit = (path) => {
  const module = byPath.get(path);

  if (module === undefined || startupModules.has(path)) return;

  startupModules.set(path, module);

  for (const next of staticImports(module)) visit(next);
};

visit(ENTRY);

const bytes = (list) => list.reduce((total, module) => total + Buffer.byteLength(module.code), 0);
const startupBytes = bytes([...startupModules.values()]);

/** One cold startup's CPU profile: a fresh workerd whose only request imports the entry. */
const profileStartup = async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "profiler",
      compatibilityDate: deployed.date,
      compatibilityFlags: deployed.flags,
      modulesRoot: "/",
      modules: [
        {
          type: "ESModule",
          path: "/__startup__.js",
          contents: `export default { async fetch() { await import("./${ENTRY}"); return new Response("ok"); } };`,
        },
        ...modules.map((module) => ({
          type: "ESModule",
          path: `/${module.path}`,
          contents: module.code,
        })),
      ],
      inspectorPort: 0,
      handleStructuredLogs: () => undefined,
    }),
  );

  try {
    await mf.ready;

    const socket = new WebSocket(new URL("/core:user:profiler", (await mf.getInspectorURL()).href));

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const answers = new Map();
    let id = 0;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));

      answers.get(message.id)?.(message);
    });

    const send = (method) =>
      new Promise((resolve) => {
        answers.set(++id, resolve);
        socket.send(JSON.stringify({ id, method }));
      });

    await send("Profiler.enable");
    await send("Profiler.start");

    const response = await mf.dispatchFetch("https://startup.invalid/");
    const text = await response.text();

    if (!response.ok)
      throw new Error(`The Worker's global scope failed (${response.status}): ${text}`);

    const { result } = await send("Profiler.stop");

    socket.close();

    return result.profile;
  } finally {
    await mf.dispose();
  }
};

/** The profile's sampled time less its idle time, in ms: `wrangler check startup`'s "active time". */
const activeMs = (profile) => {
  const idle = new Set(
    profile.nodes.filter((node) => node.callFrame.functionName === "(idle)").map((node) => node.id),
  );

  let active = 0;

  profile.timeDeltas.forEach((delta, index) => {
    if (!idle.has(profile.samples[index])) active += delta;
  });

  return active / 1000;
};

const runs = [];
let profile;

for (let run = 0; run < RUNS; run++) {
  profile = await profileStartup();
  runs.push(activeMs(profile));
}

await writeFile(join(out, "startup.cpuprofile"), JSON.stringify(profile));

const sorted = runs.toSorted((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;

const report = [
  `Server Worker startup (${out})`,
  `  compatibility: ${deployed.date}, ${deployed.flags.join(", ")}`,
  `  bundle: ${modules.length} modules, ${kib(bytes(modules))}`,
  `  startup modules: ${[...startupModules.keys()].join(", ")}: ${kib(startupBytes)} (budget ${kib(BYTES_BUDGET)})`,
  `  startup CPU: median ${median.toFixed(1)} ms of ${runs.map((ms) => ms.toFixed(1)).join(", ")} (budget ${CPU_BUDGET_MS} ms)`,
  "  the last run's profile is startup.cpuprofile: open it in Chrome DevTools or VS Code",
];

console.log(report.join("\n"));

const problems = [
  startupBytes > BYTES_BUDGET &&
    `the startup modules are ${kib(startupBytes)}, over the budget of ${kib(BYTES_BUDGET)}`,
  median > CPU_BUDGET_MS &&
    `the startup takes ${median.toFixed(1)} ms of CPU, over the budget of ${CPU_BUDGET_MS} ms`,
].filter(Boolean);

for (const problem of problems) {
  console.error(
    `::error::Server Worker startup: ${problem}. Keep heavy code out of the Worker's global scope: worker.ts's props import only light modules, and the rest loads from worker-init.ts (docs/development/workers.md → Startup).`,
  );
}

if (problems.length > 0) process.exit(1);
