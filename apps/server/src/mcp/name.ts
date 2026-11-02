// The name of an Environment's MCP host object (`docs/architecture/mcp-connections.md` → The host object): `mcp:<environment id>`.
const PREFIX = "mcp:";

/** The name of the `McpHost` of `environment`. */
export const mcpHostName = (environment: string): string => `${PREFIX}${environment}`;

/** The Environment whose host is named `name`, or undefined for a name no host has. */
export const environmentOfMcpHost = (name: string | undefined): string | undefined =>
  name?.startsWith(PREFIX) === true && name.length > PREFIX.length
    ? name.slice(PREFIX.length)
    : undefined;
