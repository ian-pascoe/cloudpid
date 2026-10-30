import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { StaleBuildGuard } from "./stale-build-guard.tsx";
import "./styles.css";
import { McpAppPrototype } from "./prototype-mcp-app/page.tsx";

const root = document.getElementById("root");

if (root === null) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <StaleBuildGuard />
      {/* PROTOTYPE (throwaway, never merged): #384's MCP App rendering variants. */}
      {import.meta.env.DEV && window.location.pathname === "/prototype/mcp-app" ? (
        <McpAppPrototype />
      ) : (
        <App />
      )}
    </RegistryProvider>
  </StrictMode>,
);
