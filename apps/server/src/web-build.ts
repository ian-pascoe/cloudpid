// The web app's build step, in a module of its own that imports nothing at runtime (`worker.ts` imports only light
// modules: `docs/development/workers.md` → Startup). How its plan decides whether a deploy changes the Server:
// `docs/development/infra.md` → CI.
import type { BuildProps } from "alchemy/Command";

/**
 * The props of `Command.Build("WebBuild")` (`worker.ts`), which builds `apps/web` at `webDirectory` into the Server's
 * static assets.
 *
 * The step rebuilds, and plans an update, when the hash of its inputs (`memo`) or of its `dist` differs from what the
 * last deploy stored, or when there is no `dist` to hash (CI builds the app before the plan for that reason). An update
 * leaves its outputs unknown until it has run, so `Server`, whose assets they are, plans an update too, and its upload
 * resets every Durable Object still busy `max_delay` later. So the inputs leave out what the build does not read: every
 * test and Markdown file, and the typecheck's `tsconfig.tsbuildinfo`, which lists the tests. Tailwind scans the app's
 * files for class names, so `apps/web/src/styles.css` leaves the same files out (`@source not`), and a change to those
 * alone leaves `dist` as it was too (`apps/web/src/build.test.ts`): it plans a noop.
 *
 * The app also bundles parts of `@cloudpid/config` and `@cloudpid/mcp` (`/types`), whose sources are not inputs: both
 * change often, mostly for the Workers, and each change would rebuild the app and update `Server`. A `dist` built
 * before the plan, as CI's is, shows such a change in its hash; a local deploy over an older `dist` keeps it.
 */
export const webBuildProps = (webDirectory: string) =>
  ({
    command: "bun run build",
    cwd: webDirectory,
    outdir: "dist",
    memo: {
      // The app imports the protocol package's source, which the default scope (the app's own files) would miss.
      include: ["**/*", "../../packages/protocol/src/**"],
      // An `exclude` replaces the `.gitignore` rules alchemy would otherwise apply, so this restates the ones that
      // reach these files (`node_modules/`, `dist/`, `.turbo/`). `**` matches no `../` path, so the protocol's tests
      // are named on their own.
      exclude: [
        "node_modules/**",
        "dist/**",
        ".turbo/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.md",
        "tsconfig.tsbuildinfo",
        "../../packages/protocol/src/**/*.test.ts",
      ],
      lockfile: true,
    },
  }) satisfies BuildProps;
