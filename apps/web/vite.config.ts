import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ServerOptions } from "vite";

/** Where `alchemy dev` serves the main Worker (`bun run --cwd infra dev`). */
const WORKER = "http://localhost:1337";

// The main Worker serves the build as static assets (apps/server/src/worker.ts). `vite dev` proxies the Worker's
// routes to a running `alchemy dev`, so the page and its Session socket share one origin there as well.
const server: ServerOptions = {
  proxy: {
    "/rpc": WORKER,
    // Only the socket and the Attachments: the page at /sessions/:id is the app itself.
    "^/sessions/[^/]+/socket$": { target: WORKER, ws: true },
    "^/sessions/[^/]+/attachments/": WORKER,
    // MCP sign-ins (docs/architecture/mcp-sign-in.md → The client document and the callback outside Access): the start, and
    // the authorization server's answer at `http://localhost:5173/oauth/mcp/callback`. Vite's string form of a target sets
    // `changeOrigin`, which rewrites `Host` to the Worker's own; the Worker takes the origin a sign-in started on from
    // `Host`, so this one keeps the browser's.
    "/oauth/mcp/": { target: WORKER, changeOrigin: false },
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server,
});
