// This package's tasks for `vp run` (packages/config/src/tasks.ts).
import { tasks } from "./src/tasks.ts";
import { defineConfig } from "vite-plus";

export default defineConfig({ run: { tasks } });
