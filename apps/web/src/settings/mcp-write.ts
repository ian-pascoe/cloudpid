// @effect-diagnostics missingPipeableSignature:off -- builders of plain values, not combinators.

// What the owner's actions in the MCP servers section write (docs/architecture/mcp-configuration.md → Scopes, adjustments and
// the set; → The Settings page's "MCP servers" section): at Global, the Global document with a server's entry set or taken
// out; at an Environment, a patch of its Overrides, where a Global server's switch, select and tool exposure write an
// adjustment (`mcp.servers.<name>.enabled|exposure|toolExposure`, an Override even when equal to Global's) and an entry of
// its own is an Override of its own (`mcp.servers.<name>`). Each is made from the document as the Registry has it when the
// owner acts, so what the agent changed meanwhile stands.

import { isMcpFullEntry, type McpExposure } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { mcpServersIn } from "./mcp-model.ts";

/** One thing the owner does to the servers of a Scope. */
export type McpChange =
  /** Switch a server on or off. */
  | { readonly kind: "enabled"; readonly name: string; readonly enabled: boolean }
  /** Set a server's Exposure. */
  | { readonly kind: "exposure"; readonly name: string; readonly exposure: McpExposure }
  /** Set a server's `toolExposure`, whole. */
  | {
      readonly kind: "toolExposure";
      readonly name: string;
      readonly toolExposure: Readonly<Record<string, McpExposure>>;
    }
  /** At an Environment, reset Override fields (`mcp.servers.<name>.enabled`, an orphan's) so they inherit again. */
  | { readonly kind: "reset"; readonly fields: ReadonlyArray<string> }
  /** Keep a server's entry: an Add, an Edit, an import's Replace. */
  | { readonly kind: "put"; readonly name: string; readonly entry: Schema.Json }
  /** Take a server's own entry away. */
  | { readonly kind: "remove"; readonly name: string }
  /** Keep every entry of an import. */
  | {
      readonly kind: "import";
      readonly entries: ReadonlyArray<{ readonly name: string; readonly entry: Schema.Json }>;
    };

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** `object` with `key` as `value`: where it was if it held it, else last. */
const setKey = (object: Schema.JsonObject, key: string, value: Schema.Json): Schema.JsonObject =>
  Record.fromEntries([...Record.toEntries(object), [key, value] as const]);

/** The adjustable key a change sets, and its value; none for a change that is not one. */
const keyOf = (change: McpChange): readonly [string, Schema.Json] | undefined => {
  switch (change.kind) {
    case "enabled":
      return ["enabled", change.enabled];
    case "exposure":
      return ["exposure", change.exposure];
    case "toolExposure":
      return ["toolExposure", change.toolExposure];
    default:
      return undefined;
  }
};

/** `document` with the servers of its `mcp.servers` as `servers`: an empty `mcp` root is left out. */
const withServers = (document: Schema.Json, servers: Schema.JsonObject): Schema.JsonObject => {
  const rest = Record.filter(isObject(document) ? document : {}, (_, key) => key !== "mcp");

  return Arr.isArrayEmpty(Record.toEntries(servers)) ? rest : setKey(rest, "mcp", { servers });
};

const withEntry = (
  servers: Schema.JsonObject,
  name: string,
  entry: Schema.Json,
): Schema.JsonObject => setKey(servers, name, entry);

const NOT_THERE = (name: string): string =>
  `${name} is not one of this Scope's servers any more: it changed since the page read it`;

/**
 * Global's saved document `document` after `change`: a server's switch, Exposure and tool exposure are keys of its entry.
 * The rest of the document is as it was. Fails with why the change does not apply to what the Registry holds now.
 */
export const mcpGlobalDocument = (
  document: Schema.Json,
  change: McpChange,
): Result.Result<Schema.JsonObject, string> => {
  const servers = mcpServersIn(document);
  const key = keyOf(change);

  if (key !== undefined && "name" in change) {
    const held = servers[change.name];

    return isObject(held) && isMcpFullEntry(held)
      ? Result.succeed(
          withServers(document, withEntry(servers, change.name, setKey(held, key[0], key[1]))),
        )
      : Result.fail(NOT_THERE(change.name));
  }

  switch (change.kind) {
    case "put":
      return Result.succeed(withServers(document, withEntry(servers, change.name, change.entry)));
    case "remove":
      return Result.succeed(
        withServers(
          document,
          Record.filter(servers, (_, name) => name !== change.name),
        ),
      );
    case "import":
      return Result.succeed(
        withServers(
          document,
          Arr.reduce(change.entries, servers, (held, { name, entry }) =>
            withEntry(held, name, entry),
          ),
        ),
      );
    default:
      return Result.fail("Global holds no adjustment to reset");
  }
};

/** A patch of an Environment's Overrides, as `updateSettingsOverrides` takes it. */
export interface McpOverridesPatch {
  readonly set?: Schema.Json;
  readonly reset?: ReadonlyArray<string>;
}

/** `{ mcp: { servers: servers } }`, the shape `set` is a deep partial of. */
const serversPatch = (servers: Schema.JsonObject): Schema.JsonObject => ({ mcp: { servers } });

/**
 * The patch that makes `change` of an Environment's servers, over its Overrides `overrides` as saved now: a Global
 * server's switch, Exposure and tool exposure set the adjustment key (never a copy of Global's entry), those of the
 * Environment's own server the key inside its entry; an entry is one Override, replacing whatever the Environment held
 * under the name. Fails with why the change does not apply to what the Registry holds now.
 */
export const mcpOverridesPatch = (
  overrides: Schema.Json,
  change: McpChange,
): Result.Result<McpOverridesPatch, string> => {
  const servers = mcpServersIn(overrides);
  const key = keyOf(change);

  if (key !== undefined && "name" in change) {
    const own = servers[change.name];

    return Result.succeed({
      set: serversPatch({
        [change.name]:
          isObject(own) && isMcpFullEntry(own) ? setKey(own, key[0], key[1]) : { [key[0]]: key[1] },
      }),
    });
  }

  switch (change.kind) {
    case "reset":
      return Result.succeed({ reset: change.fields });
    case "put":
      return Result.succeed({ set: serversPatch({ [change.name]: change.entry }) });
    case "remove":
      return Result.succeed({ reset: [`mcp.servers.${change.name}`] });
    case "import":
      return Result.succeed({
        set: serversPatch(
          Arr.reduce(change.entries, {}, (held: Schema.JsonObject, { name, entry }) =>
            withEntry(held, name, entry),
          ),
        ),
      });
    default:
      return Result.fail(NOT_THERE(""));
  }
};

/** The Override fields of a server's adjustment keys, as a Reset names them. */
export const mcpAdjustmentFields = (
  name: string,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => Arr.map(keys, (key) => `mcp.servers.${name}.${key}`);
