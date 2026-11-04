// @effect-diagnostics strictEffectProvide:off asyncFunction:off nodeBuiltinImport:off preferEffectRecord:off anyUnknownInErrorContext:off -- each test is its own entry point, on real files in a temporary directory, through alchemy's provider, whose failures are untyped.
// The WebBuild step's plan (docs/development/infra.md → CI): alchemy's own `Command.Build` diff, given `webBuildProps`'
// props and the state the last deploy stored, decides whether a deploy rebuilds the web app, and so whether `Server`,
// whose assets are the step's outputs, can plan a noop (#626).
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Build, BuildProvider, CommandExecutorLive } from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { afterEach, describe, expect, it } from "vitest";
import { webBuildProps } from "./web-build.ts";

/**
 * Stands in for Vite: `dist` holds what the app bundles (its page, its source, the protocol's and the config package's),
 * never a test. That the real build's bytes do not depend on a test, Markdown or the build info either (Tailwind scans
 * every file of the app for class names) is `apps/web/src/build.test.ts`'s.
 */
const BUILD_SCRIPT = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const bundled = ["index.html", "src/app.tsx", "../../packages/protocol/src/session.ts", "../../packages/config/src/index.ts"];
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", bundled.map((file) => readFileSync(file, "utf8")).join("\\n"));
`;

/** The fixture's build, in place of `bun run build`: the step runs it, and so does CI before the plan. */
const BUILD_COMMAND = "node build.mjs";

/** A checkout in miniature, laid out as the repository is: the app, the protocol package it imports, the lockfile. */
const FILES = {
  "bun.lock": "lockfile\n",
  "apps/web/package.json": '{ "name": "@cloudpid/web" }\n',
  "apps/web/index.html": '<script type="module" src="/src/app.tsx"></script>\n',
  "apps/web/build.mjs": BUILD_SCRIPT,
  "apps/web/src/app.tsx": "export const app = 1;\n",
  "apps/web/src/app.test.tsx": "it('renders', () => {});\n",
  "apps/web/src/view.test.ts": "it('views', () => {});\n",
  "apps/web/src/chat.testing.ts": "export const fakeChat = {};\n",
  "apps/web/src/view/fixtures/page.html.txt": "<p>fixture</p>\n",
  "apps/web/DESIGN.md": "# Design\n",
  "apps/web/tsconfig.tsbuildinfo": '{"root":["./src/app.tsx","./src/app.test.tsx"]}\n',
  // Written by tools, never read by the build: the `.gitignore` rules the step's `exclude` restates.
  "apps/web/node_modules/.vite/deps.json": "{}\n",
  "apps/web/.turbo/turbo-build.log": "built\n",
  "packages/protocol/src/session.ts": "export const session = 1;\n",
  "packages/protocol/src/session.test.ts": "it('decodes', () => {});\n",
  // Bundled, but not among the step's inputs (`web-build.ts`).
  "packages/config/src/index.ts": "export const TOOL_PATTERN = 1;\n",
};

type CheckoutFile = keyof typeof FILES;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "web-build-"));
  roots.push(root);

  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  const web = join(root, "apps/web");

  return {
    props: { ...webBuildProps(web), command: BUILD_COMMAND },
    // The next deploy runs on a new checkout, without the `dist` the last one built.
    fresh: () => rmSync(join(web, "dist"), { recursive: true, force: true }),
    edit: (path: CheckoutFile) => appendFileSync(join(root, path), "// edited\n"),
    // What CI does before the plan (`ci.yml`, `deploy` and `preview`): build the app as the step would.
    build: () => execSync(BUILD_COMMAND, { cwd: web }),
  };
};

type Props = ReturnType<typeof checkout>["props"];

const session: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

const run = <A, E>(effect: Effect.Effect<A, E, Provider.Provider<Build>>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        BuildProvider().pipe(
          Layer.provide(CommandExecutorLive()),
          // The provider's hashing reads the file system through the context, not through its own requirements. The
          // platform is Node's, as under alchemy's CLI.
          // @effect-diagnostics-next-line unstableApiUsage:off
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

const ID = { id: "WebBuild", fqn: "WebBuild", instanceId: "web-build" };

/** The state a deploy stores for the step: it runs the build, then hashes the inputs and `dist`. */
const deploy = (props: Props) =>
  run(
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Build>("Command.Build");

      return yield* provider.reconcile({
        ...ID,
        news: props,
        olds: undefined,
        output: undefined,
        session,
        bindings: [],
      });
    }),
  );

/** The action the next deploy's plan takes for the step, against what the last one stored. */
const plan = (props: Props, output: Build["Attributes"]) =>
  run(
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Build>("Command.Build");

      if (provider.diff === undefined) return "no diff";

      const diff = yield* provider.diff({
        ...ID,
        olds: props,
        news: props,
        output,
        oldBindings: [],
        newBindings: [],
      });

      return Predicate.hasProperty(diff, "action") ? diff.action : "no action";
    }),
  );

describe("the WebBuild step's plan", { timeout: 30_000 }, () => {
  it("updates on a checkout without the app's build, whose outputs the plan then cannot know", async () => {
    const { props, fresh } = checkout();
    const deployed = await deploy(props);

    fresh();

    expect(await plan(props, deployed)).toBe("update");
  });

  it("plans a noop when the app was built before the plan and nothing it hashes changed", async () => {
    const { props, fresh, build } = checkout();
    const deployed = await deploy(props);

    fresh();
    build();

    expect(await plan(props, deployed)).toBe("noop");
  });

  it.each<CheckoutFile>([
    "apps/web/src/app.test.tsx",
    "apps/web/src/view.test.ts",
    "apps/web/src/chat.testing.ts",
    "apps/web/src/view/fixtures/page.html.txt",
    "packages/protocol/src/session.test.ts",
    "apps/web/DESIGN.md",
    "apps/web/tsconfig.tsbuildinfo",
    "apps/web/node_modules/.vite/deps.json",
    "apps/web/.turbo/turbo-build.log",
  ])("plans a noop when only %s changed", async (changed) => {
    const { props, fresh, edit, build } = checkout();
    const deployed = await deploy(props);

    fresh();
    edit(changed);
    build();

    expect(await plan(props, deployed)).toBe("noop");
  });

  it.each<CheckoutFile>([
    "apps/web/src/app.tsx",
    "apps/web/index.html",
    "packages/protocol/src/session.ts",
    "bun.lock",
    "apps/web/package.json",
    // Not an input, but `dist` is built before the plan, so its hash shows the change.
    "packages/config/src/index.ts",
  ])("plans an update when %s changed", async (changed) => {
    const { props, fresh, edit, build } = checkout();
    const deployed = await deploy(props);

    fresh();
    edit(changed);
    build();

    expect(await plan(props, deployed)).toBe("update");
  });
});
