// @effect-diagnostics missingPipeableSignature:off -- builders over plain values.
// The resource tools of the `mcp` extension (`docs/architecture/mcp-in-a-session.md` → Resource tools): pi's
// `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, one set for all servers, registered when the
// host lists the `resources` feature and an enabled, non-`hidden` server has resources, at the widest Exposure of those
// servers (`direct` > `deferred` > `codemode`, each server's own `exposure` only, and `tools.offered` lifting a tool on its
// own). They are no server's and so are never `mcp__`-named, never wrapped by `tool_search`, never in `deferred_tools`.
// Registration is here, the lists are `./resource-list.ts` and the read `./resource-read.ts`.
import { type McpExposure, MCP_RESOURCE_TOOL_NAMES, resolveExposure } from "@cloudpid/config";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin, McpToolOptions } from "./exchange.ts";
import { exposureKeys } from "./exposure.ts";
import { listTool } from "./resource-list.ts";
import { readTool } from "./resource-read.ts";
import { hasResources } from "./resource-targets.ts";
import type { McpBuild, McpBuildServer } from "./tools.ts";

export { MAX_LISTED_BYTES, MAX_LISTED_ITEMS } from "./resource-list.ts";

/** The host feature the resource tools need: a host without it has no `resources/*` requests, and gets no tools. */
export const MCP_RESOURCE_FEATURE = "resources";

/** How wide an Exposure reaches: `direct` is in the tool list, `deferred` by `tool_search` and scripts, `codemode` by scripts. */
const REACH: Record<Exclude<McpExposure, "hidden">, number> = {
  codemode: 1,
  deferred: 2,
  direct: 3,
};

/**
 * The Exposure of resource tool `name`: the widest of those the servers give it. Each server's own `exposure` counts, not
 * its `toolExposure` (which names its own tools), and `tools.offered` lifts the tool to `direct` as it does any other.
 */
const widestExposure = (
  servers: ReadonlyArray<McpBuildServer>,
  name: string,
  offered: ReadonlyArray<string>,
): Exclude<McpExposure, "hidden"> => {
  let widest: Exclude<McpExposure, "hidden"> = "codemode";

  for (const server of servers) {
    const { exposure } = resolveExposure({
      server: { exposure: exposureKeys(server).exposure, toolExposure: {} },
      tool: name,
      modelName: name,
      offered,
    });

    if (exposure !== "hidden" && REACH[exposure] > REACH[widest]) widest = exposure;
  }

  return widest;
};

/**
 * The resource tools of `build`: none unless the host lists `resources` and a server the tools reach has resources.
 * Built purely from the inventory and the offered tools, so equal builds give byte-identical declarations.
 */
export const resourceTools = (
  build: McpBuild,
  client: McpHostClientService,
  origin: McpCallOrigin,
  options: McpToolOptions,
): ReadonlyArray<ToolRegistration> => {
  if (!(build.features ?? []).includes(MCP_RESOURCE_FEATURE)) return [];

  const servers = Arr.filter(build.servers, hasResources);

  if (servers.length === 0) return [];

  const exposureOf = (name: string) => widestExposure(servers, name, build.offered);
  const [list, templates, read] = MCP_RESOURCE_TOOL_NAMES;
  const shared = { servers, client, origin, options };

  return [
    listTool({ ...shared, what: "resources", name: list }, exposureOf(list)),
    listTool({ ...shared, what: "templates", name: templates }, exposureOf(templates)),
    readTool({ ...shared, name: read }, exposureOf(read)),
  ];
};
