import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { pageBrowser, registerServiceWorker, syncPush } from "./push.ts";
import { connectRegistry } from "./registry.ts";
import "./styles.css";

// The service worker shows notifications and installs the app. A device that already gets them is re-told to the
// Registry, so a subscription the browser renewed is not lost.
void registerServiceWorker().then(() =>
  syncPush(pageBrowser(), connectRegistry(window.location.origin)),
);

const root = document.getElementById("root");

if (root === null) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
