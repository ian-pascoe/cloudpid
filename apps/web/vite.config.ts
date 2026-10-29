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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server,
});
