// The App tools of the inventory, as `mcp_app_tools` lists them (`docs/architecture/mcp-apps.md` → Declaring and reading
// Apps, Socket messages).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- builders over plain values.
import { mcpToolNames } from "@cloudpid/config";
import { appUriOfMeta } from "@cloudpid/mcp/types";
import { MAX_MCP_APP_TOOLS, type McpAppTool } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";
import { visibilityOf } from "./apps.ts";
import { listedTools, type McpBuildServer } from "./tools.ts";

/**
 * The App tools of `servers`: each tool whose `_meta.ui.resourceUri` names a `ui://` resource, by its model-facing name
 * (the one it is registered under, or would be: an `["app"]`-only tool is never registered), in the servers' and the
 * tools' order, at most `MAX_MCP_APP_TOOLS`. A server switched off has none.
 */
export const appToolsOf = (servers: ReadonlyArray<McpBuildServer>): ReadonlyArray<McpAppTool> =>
  Arr.take(
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

        return Result.succeed(app);
      });
    }),
    MAX_MCP_APP_TOOLS,
  );
