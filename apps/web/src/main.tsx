import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { installStaleBuildReload } from "./stale-build.ts";
import "./styles.css";

// A tab left open across a deploy asks for chunks the new build no longer has: reload to fetch it (`stale-build.ts`).
installStaleBuildReload();

const root = document.getElementById("root");

if (root === null) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
);
