// @effect-diagnostics processEnv:off -- Vite's config is plain Node, read once at start.

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ServerOptions } from "vite";

/** Where `alchemy dev` serves the main Worker (`pnpm --filter @cloudpid/infra run dev`). */
const WORKER = "http://localhost:1337";

// The main Worker serves the build as static assets (apps/server/src/worker.ts). `vite dev` proxies the Worker's
// routes to a running `alchemy dev`, so the page and its Session socket share one origin there as well.
const server: ServerOptions = {
  proxy: {
    "/rpc": WORKER,
    // Only the socket and the Attachments: the page at /sessions/:id is the app itself.
    "^/sessions/[^/]+/socket$": { target: WORKER, ws: true },
    "^/sessions/[^/]+/attachments/": WORKER,
  },
};

// `VITE_POLL=1` makes the dev server poll for changes: on a cloudpid Container `/workspace` is a FUSE mount whose
// changes made through the Workspace (the file tools, the Worker Shell) raise no inotify events, so Vite never hears
// of them.
if (process.env["VITE_POLL"] === "1") server.watch = { usePolling: true, interval: 300 };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server,
});
