// The App tools of the inventory, as `mcp_app_tools` lists them (`docs/architecture/mcp-apps.md` → Declaring and reading
// Apps, Socket messages).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off -- builders over plain values; a schema's size is its JSON text's length.
import { mcpToolNames } from "@cloudpid/config";
import { appUriOfMeta, isJsonObject } from "@cloudpid/mcp/types";
import {
  MAX_MCP_APP_SCHEMA_BYTES,
  MAX_MCP_APP_SCHEMAS_BYTES,
  MAX_MCP_APP_TOOLS,
  type McpAppTool,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";
import { visibilityOf } from "./exposure.ts";
import { listedTools, type McpBuildServer } from "./tools.ts";

/**
 * The App tools of `servers`: each tool whose `_meta.ui.resourceUri` names a `ui://` resource, by its model-facing name
 * (the one it is registered under, or would be: an `["app"]`-only tool is never registered), in the servers' and the
 * tools' order, at most `MAX_MCP_APP_TOOLS`. A server switched off has none.
 */
export const appToolsOf = (servers: ReadonlyArray<McpBuildServer>): ReadonlyArray<McpAppTool> => {
  // What the schemas of the tools so far have used of the list's budget.
  let schemas = 0;

  return Arr.take(
    Arr.flatMap(servers, (server) => {
      if (server.state === "disabled") return [];

      const listed = listedTools(server);

      const names = mcpToolNames(
        server.name,
        Arr.map(listed, (tool) => tool.name),
      );

      return Arr.filterMap(listed, (tool) => {
        const uri = appUriOfMeta(tool._meta);

        if (uri === undefined) return Result.failVoid;

        const app: Mutable<McpAppTool> = {
          name: names.get(tool.name) ?? tool.name,
          server: server.name,
          tool: tool.name,
          uri,
          visibility: visibilityOf(tool._meta),
        };

        if (tool.title !== undefined) app.title = tool.title;

        // The tool's schema for the View's `toolInfo`, within its bounds.
        if (isJsonObject(tool.inputSchema)) {
          const size = JSON.stringify(tool.inputSchema).length;

          if (size <= MAX_MCP_APP_SCHEMA_BYTES && schemas + size <= MAX_MCP_APP_SCHEMAS_BYTES) {
            schemas += size;
            app.inputSchema = tool.inputSchema;
          }
        }

        return Result.succeed(app);
      });
    }),
    MAX_MCP_APP_TOOLS,
  );
};
