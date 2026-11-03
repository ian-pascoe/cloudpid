// @effect-diagnostics missingPipeableSignature:off -- builders of plain values, not combinators.

// What the owner's actions in the MCP servers section write (docs/architecture/mcp-configuration.md → Scopes, adjustments and
// the set; → The Settings page's "MCP servers" section): at Global, the Global document with a server's entry set or taken
// out; at an Environment, a patch of its Overrides, where a Global server's switch, select and tool exposure write an
// adjustment (`mcp.servers.<name>.enabled|exposure|toolExposure`, an Override even when equal to Global's) and an entry of
// its own is an Override of its own (`mcp.servers.<name>`). Each is made from the document as the Registry has it when the
// owner acts, so what the agent changed meanwhile stands.

import { isJsonObject, isMcpFullEntry, type McpExposure } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { isFollowedRow, type McpRow, mcpServersIn, repoBaseOf } from "./mcp-model.ts";

/**
 * What a switch, select or tool exposure change is of, as the row it was made on showed it: the Scope's own entry (the
 * key inside it; at Global, its only kind), or, at an Environment, an adjustment of a Global server (the key beside it).
 * A change whose target is no longer what the Registry holds writes nothing.
 */
export type McpChangeTarget = "own" | "adjustment";

/** One thing the owner does to the servers of a Scope. */
export type McpChange =
  /** Switch a server on or off. */
  | {
      readonly kind: "enabled";
      readonly name: string;
      readonly target: McpChangeTarget;
      readonly enabled: boolean;
    }
  /** Set a server's Exposure. */
  | {
      readonly kind: "exposure";
      readonly name: string;
      readonly target: McpChangeTarget;
      readonly exposure: McpExposure;
    }
  /** Set a server's `toolExposure`, whole. */
  | {
      readonly kind: "toolExposure";
      readonly name: string;
      readonly target: McpChangeTarget;
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

/** A change of one key of a server: the switch, the Exposure or the tool exposure. */
type McpKeyChange = Extract<McpChange, { readonly target: McpChangeTarget }>;

/** `object` with `key` as `value`: where it was if it held it, else last. */
const setKey = (object: Schema.JsonObject, key: string, value: Schema.Json): Schema.JsonObject =>
  Record.fromEntries([...Record.toEntries(object), [key, value] as const]);

/** The key a change sets, and its value. */
const keyOf = (change: McpKeyChange): readonly [string, Schema.Json] => {
  switch (change.kind) {
    case "enabled":
      return ["enabled", change.enabled];
    case "exposure":
      return ["exposure", change.exposure];
    case "toolExposure":
      return ["toolExposure", change.toolExposure];
  }
};

/** `document` with the servers of its `mcp.servers` as `servers`: an empty `mcp` root is left out. */
const withServers = (document: Schema.Json, servers: Schema.JsonObject): Schema.JsonObject => {
  const rest = Record.filter(isJsonObject(document) ? document : {}, (_, key) => key !== "mcp");

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

  switch (change.kind) {
    case "enabled":
    case "exposure":
    case "toolExposure": {
      const held = servers[change.name];
      const [key, value] = keyOf(change);

      return change.target === "own" && isJsonObject(held) && isMcpFullEntry(held)
        ? Result.succeed(
            withServers(document, withEntry(servers, change.name, setKey(held, key, value))),
          )
        : Result.fail(NOT_THERE(change.name));
    }

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
    case "reset":
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
 * under the name. `globalServers` are the names of the Global servers now: an adjustment of one that is no longer there
 * would be an orphan the Registry accepts, so it fails. Fails with why the change does not apply to what the Registry
 * holds now.
 */
export const mcpOverridesPatch = (
  overrides: Schema.Json,
  change: McpChange,
  globalServers: ReadonlyArray<string>,
): Result.Result<McpOverridesPatch, string> => {
  const servers = mcpServersIn(overrides);

  switch (change.kind) {
    case "enabled":
    case "exposure":
    case "toolExposure": {
      const written = servers[change.name];
      const [key, value] = keyOf(change);
      const own = isJsonObject(written) && isMcpFullEntry(written) ? written : undefined;

      // The row showed an own entry and it is gone (or an adjustment and an own entry is there now): writing the key
      // would adjust Global's server of the same name, or an entry the owner never saw, so it writes nothing.
      if ((own !== undefined) !== (change.target === "own")) {
        return Result.fail(NOT_THERE(change.name));
      }

      // An adjustment needs the Global server it adjusts: gone since the row was shown, it would be an orphan.
      if (own === undefined && !Arr.contains(globalServers, change.name)) {
        return Result.fail(NOT_THERE(change.name));
      }

      return Result.succeed({
        set: serversPatch({
          [change.name]: own === undefined ? { [key]: value } : setKey(own, key, value),
        }),
      });
    }

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
  }
};

/** The Override fields of a server's adjustment keys, as a Reset names them. */
export const mcpAdjustmentFields = (
  name: string,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => Arr.map(keys, (key) => `mcp.servers.${name}.${key}`);

/**
 * What a row's switch and Exposure select write: the row's server, aimed at what the row showed (`McpChangeTarget`: a
 * Global server followed at an Environment is adjusted, any other row's own entry is changed). The rendered controls and
 * their tests make their changes with this one builder.
 */
export const mcpRowChanges = (row: McpRow) => {
  const target: McpChangeTarget = isFollowedRow(row) ? "adjustment" : "own";

  return {
    enabled: (enabled: boolean): McpChange => ({
      kind: "enabled",
      name: row.name,
      target,
      enabled,
    }),
    exposure: (exposure: McpExposure): McpChange => ({
      kind: "exposure",
      name: row.name,
      target,
      exposure,
    }),
  };
};

/**
 * What a Repo's server's switch and Exposure write (D9: a Repo's server is only switched off here): switching off or
 * hiding writes the adjustment; what the Repo's file says is what Reset brings back, so choosing it resets the key.
 */
export const mcpRepoRowChanges = (row: McpRow) => {
  const base = repoBaseOf(row);
  const changes = mcpRowChanges(row);

  const resetOf = (key: string): McpChange => ({
    kind: "reset",
    fields: mcpAdjustmentFields(row.name, [key]),
  });

  return {
    enabled: (enabled: boolean): McpChange =>
      enabled === base.enabled ? resetOf("enabled") : changes.enabled(enabled),
    exposure: (exposure: McpExposure): McpChange =>
      exposure === base.exposure ? resetOf("exposure") : changes.exposure(exposure),
  };
};
