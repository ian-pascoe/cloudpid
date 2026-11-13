// This package's tasks for `vp run` (packages/config/src/tasks.ts).
import { tasks } from "@cloudpid/config/tasks";
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      ...tasks,
      // Uncached: to record what a cached task reads on macOS, Vite Task runs the system's coreutils (`/bin/sleep`,
      // `/bin/mkdir`) as uutils', and the supervisor's memory-guard tests, which run the image's bash scripts, fail under
      // them. Linux (CI, the Container) is unaffected; the tests are seconds either way.
      test: { ...tasks.test, cache: false },
    },
  },
});
