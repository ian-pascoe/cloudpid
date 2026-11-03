// What the composer's `/` menu offers of the Environment's MCP prompts (`docs/architecture/mcp-in-a-session.md` → The `/`
// menu and the catalog): the catalog's `prompts` and `mcpServers`, from the host's inventory alone, as pure functions.
// Nothing here reads a server, so the menu never wakes a Container.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over the inventory's JSON.
import { mcpToolNames } from "@cloudpid/config";
import {
  isJsonObject,
  type JsonObject,
  type McpServerInventory,
  readMcpServerState,
  type McpServerState,
} from "@cloudpid/mcp/types";
import type { McpCatalogServer, McpPromptArgument, McpPromptEntry } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { vetPrompt } from "../mcp/inventory.ts";

/** What `promptCatalog` answers: the catalog's two new lists. */
export type PromptCatalog = {
  readonly prompts: ReadonlyArray<McpPromptEntry>;
  readonly mcpServers: ReadonlyArray<McpCatalogServer>;
};

const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

/** Where a server's definition is, as the menu names it: `owner`, or `repo:<owner/repo>` for a Repo's `.pi/mcp.json`. */
const sourceOf = (source: McpServerInventory["source"]): string =>
  source.kind === "repo" && "slug" in source && Predicate.isString(source.slug)
    ? `repo:${source.slug}`
    : "owner";

/** Why a muted row has no prompts to show: it waits for discovery, for a sign-in, or neither. */
const rowState = (state: McpServerState): McpCatalogServer["state"] => {
  if (state === "sign_in" || state === "rejected") return "sign_in";

  return state === "not_discovered" || state === "connecting" ? "connecting" : "unavailable";
};

/** A vetted prompt's arguments as the form shows them. */
const argumentsOf = (prompt: JsonObject): ReadonlyArray<McpPromptArgument> =>
  Arr.filterMap(
    Option.getOrElse(decodeList(prompt["arguments"]), () => []),
    (each) => {
      if (!isJsonObject(each) || !Predicate.isString(each["name"])) return Result.failVoid;

      const argument: Mutable<McpPromptArgument> = {
        name: each["name"],
        required: each["required"] === true,
      };

      if (Predicate.isString(each["title"])) argument.title = each["title"];

      if (Predicate.isString(each["description"])) argument.description = each["description"];

      return Result.succeed(argument);
    },
  );

/** `prompt`, a vetted prompt of `server`, as a menu entry under `command`. */
const entryOf = (
  server: McpServerInventory,
  prompt: JsonObject,
  name: string,
  command: string,
): McpPromptEntry => {
  const entry: Mutable<McpPromptEntry> = {
    command,
    server: server.name,
    source: sourceOf(server.source),
    name,
    description: Predicate.isString(prompt["description"]) ? prompt["description"] : "",
    arguments: argumentsOf(prompt),
    // Completions are the next ticket's: the host does not tell the Session what a server declares yet.
    completions: false,
  };

  if (Predicate.isString(prompt["title"])) entry.title = prompt["title"];

  return entry;
};

/** One server's prompts: each vetted again (a row kept before the bounds existed is as it was discovered) and named. */
const promptsOf = (server: McpServerInventory): ReadonlyArray<McpPromptEntry> => {
  const vetted = Arr.filterMap(server.prompts ?? [], (prompt) => vetPrompt(prompt));

  const named = Arr.filterMap(vetted, (prompt) =>
    Predicate.isString(prompt["name"])
      ? Result.succeed({ prompt, name: prompt["name"] })
      : Result.failVoid,
  );

  const commands = mcpToolNames(
    server.name,
    Arr.map(named, ({ name }) => name),
  );

  return Arr.map(named, ({ prompt, name }) =>
    entryOf(server, prompt, name, `/${commands.get(name) ?? name}`),
  );
};

/**
 * The prompts of every server that is enabled and not `hidden` by its own `exposure` (the host reports both as
 * `disabled`), those of a stopped or failing server's inventory included, in the set's order, and a muted row for each
 * such server with no inventory yet. `servers` is the host's `servers` answer with the `prompts` part.
 */
export const promptCatalog = (servers: ReadonlyArray<McpServerInventory>): PromptCatalog => {
  const offered = Arr.filter(servers, (server) => server.state !== "disabled");
  const undiscovered = Arr.filter(offered, (server) => server.discoveredAt === undefined);
  const discovered = Arr.filter(offered, (server) => server.discoveredAt !== undefined);

  return {
    prompts: Arr.flatMap(discovered, promptsOf),
    mcpServers: Arr.map(undiscovered, (server) => ({
      server: server.name,
      state: rowState(readMcpServerState(server.state)),
    })),
  };
};
