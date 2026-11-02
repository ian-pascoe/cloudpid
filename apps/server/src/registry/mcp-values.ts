// The `${NAME}` values of an MCP server (`docs/architecture/mcp-configuration.md` → `${NAME}` values): resolved at use,
// per Environment, never in the set the Registry keeps or hashes. An owner's entry resolves a name against the
// Environment's Secrets (its own, then Global's: `usedSecrets` hands them merged), then its Variables; a Repo's entry
// against Variables only. The host keeps the answer in memory only. Nothing here logs a value.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import type { McpResolvedServer } from "@cloudpid/config";
import type { McpServerValuesAnswer } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

/** What `${NAME}` is read from. */
export type McpValueSources = {
  /** The Secrets the Environment uses, by name (its own over Global's). */
  readonly secrets: Readonly<Record<string, string>>;
  /** The Variables in force, by name (the Environment's own over Global's). */
  readonly variables: Readonly<Record<string, string>>;
};

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Values = Extract<McpServerValuesAnswer, { readonly status: "values" }>;

/** `text` with each `${NAME}` replaced by its value; a name with none stays as written and is added to `missing`. */
const resolveText = (
  text: string,
  sources: McpValueSources,
  allowSecrets: boolean,
  missing: Set<string>,
): string =>
  text.replaceAll(REFERENCE, (reference, name: string) => {
    const secret = allowSecrets ? Record.get(sources.secrets, name) : Option.none();
    const found = Option.orElse(secret, () => Record.get(sources.variables, name));

    if (Option.isNone(found)) {
      missing.add(name);

      return reference;
    }

    return found.value;
  });

/**
 * The `env` (a stdio server's) and `headers` (an HTTP server's) of `resolved` with every `${NAME}` resolved, and the
 * names that resolved to nothing, which stay as written for the host to skip the server or connect without them.
 */
export const resolveMcpServerValues = (
  resolved: McpResolvedServer,
  sources: McpValueSources,
): Values => {
  const missing = new Set<string>();
  const { server } = resolved;
  const given = server.type === "stdio" ? server.env : server.headers;

  const values = Record.map(given, (text) =>
    resolveText(text, sources, resolved.resolvesSecrets, missing),
  );

  return {
    status: "values",
    env: server.type === "stdio" ? values : {},
    headers: server.type === "http" ? values : {},
    missing: Arr.sort(Arr.fromIterable(missing), Order.String),
  };
};
