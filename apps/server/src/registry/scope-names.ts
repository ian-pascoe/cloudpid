// What a Scope is called in an answer or a Notification (`docs/architecture/mcp-endpoint.md` → Retries: `request_id`,
// and After a change, and Notifications): the change-request ledger's answers and the MCP change Notification's body.
import { GLOBAL_SCOPE, SETTINGS_SCOPE } from "@cloudpid/protocol";
import type { RegistryStore } from "./store.ts";

/** What a Scope is called: Global's, the Settings', or an Environment's name (its id once it is gone). */
export const scopeNameOf =
  (store: Pick<RegistryStore, "getEnvironment">) =>
  (scope: string): string =>
    scope === GLOBAL_SCOPE
      ? "Global"
      : scope === SETTINGS_SCOPE
        ? "Settings"
        : (store.getEnvironment(scope)?.name ?? scope);
