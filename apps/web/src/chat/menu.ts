// What the composer's menu lists for a trigger: the Slash commands, Prompt templates and Skills whose names match what
// is typed after `/`, a command's argument values, the Skills after `$`, or the files and folders after `@`. Pure, so
// the composer only renders it.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays, not combinators.

import { normalizeMcpName } from "@cloudpid/config";
import * as Match from "effect/Match";
import {
  type CatalogEntry,
  type McpCatalogServer,
  type McpMenuResource,
  type McpMenuServer,
  type McpPromptEntry,
  type McpResourceMenu,
  MENU_STATE,
  rank,
} from "@cloudpid/protocol";
import type { ComposerCommand } from "./commands.ts";
import type { CompletionRow, CompletionSection } from "./completion-menu.tsx";
import type { Trigger } from "./completion.ts";

/**
 * What a pick from the menu does: put text in place of the trigger, or run a command at once. An insert that `continues`
 * (a folder) is not followed by a space, so the trigger stays open on it and typing on narrows into it.
 */
export type MenuPick =
  | { readonly kind: "insert"; readonly text: string; readonly continues?: true }
  | { readonly kind: "run"; readonly command: ComposerCommand; readonly args: string }
  /** An MCP prompt: it leaves the text, and the composer asks for its arguments, or holds it as a chip at once. */
  | { readonly kind: "prompt"; readonly prompt: McpPromptEntry }
  /** An MCP resource of the `@` menu: it leaves the text, and the composer holds it as a chip to attach. */
  | { readonly kind: "resource"; readonly server: string; readonly resource: McpMenuResource }
  /** A muted row (a server whose prompts are not there yet): it cannot be picked. */
  | { readonly kind: "none" };

export type MenuEntry = CompletionRow & { readonly pick: MenuPick };

export type Completion = {
  /** What the list holds, for assistive technology. */
  readonly label: string;
  readonly sections: readonly CompletionSection[];
  /** Every row, across the sections, in order. */
  readonly entries: readonly MenuEntry[];
  /** What the menu says in place of rows when it has none: that it is searching, or found nothing. */
  readonly notice?: string;
};

/**
 * The Prompt templates and Skills of the conversation's directory, as far as the Session has said, and the Environment's
 * MCP prompts and the servers whose prompts are not there yet (`Catalog.prompts`, `Catalog.mcpServers`).
 */
export type MenuCatalog = {
  readonly templates: readonly CatalogEntry[];
  readonly skills: readonly CatalogEntry[];
  readonly prompts?: readonly McpPromptEntry[] | undefined;
  readonly mcpServers?: readonly McpCatalogServer[] | undefined;
};

const NO_CATALOG: MenuCatalog = { templates: [], skills: [] };

/** The Session's answers to the `@` menu's `files` requests, as far as they have come. */
export type FileResults = {
  /** The query `paths` answer, or null before the first answer. */
  readonly query: string | null;
  /** The paths that answer it, relative to the conversation's directory, best first; a folder's ends in `/`. */
  readonly paths: readonly string[];
  /** Whether the Session is being asked about another query than `query`. */
  readonly searching: boolean;
  /** Whether asking about the current query failed. */
  readonly failed: boolean;
};

const NOT_SEARCHED: FileResults = { query: null, paths: [], searching: true, failed: false };

/**
 * The `@` menu: the paths the Session answered for `query`, or, while it is asked about a new one, the last answer's
 * paths that match it (ranked as the Session ranks), so the list narrows as the owner types. With no rows it says
 * whether it is searching, found nothing, or could not search.
 */
const filesMenu = (query: string, files: FileResults): Completion => {
  const paths = files.query === query ? files.paths : rank(query, files.paths, (path) => path);

  const rows = paths.map((path): MenuEntry => {
    const folder = path.endsWith("/");
    // The name, a folder's with its `/`, and the folder it is in, which gives way first to a narrow menu.
    const split = path.slice(0, folder ? -1 : undefined).lastIndexOf("/") + 1;
    const directory = path.slice(0, split);

    return {
      id: `file:${path}`,
      label: path.slice(split),
      detail: directory === "" ? undefined : directory,
      pick: folder
        ? { kind: "insert", text: `@${path}`, continues: true }
        : { kind: "insert", text: `@${path}` },
    };
  });

  if (rows.length > 0) {
    return { label: "Files", sections: [{ label: "Files", rows }], entries: rows };
  }

  const notice =
    files.query !== query && files.searching
      ? "Searching files…"
      : files.failed
        ? "Could not search the files."
        : "No matching files or folders.";

  return { label: "Files", sections: [], entries: [], notice };
};

/** What a server's muted row says of why its resources are not listed. */
const resourceStateNote = (state: string): string =>
  Match.value(state).pipe(
    Match.when(MENU_STATE.connecting, () => "connecting…"),
    Match.when(MENU_STATE.signIn, () => "sign-in needed"),
    Match.when(MENU_STATE.stopped, () => "not running: its Container is stopped"),
    Match.orElse(() => "unavailable"),
  );

/** What a resource without an `annotations.priority` ranks as: between the server's low and high. */
const NEUTRAL_PRIORITY = 0.5;

/** A resource's `annotations.priority`, the neutral one when the server gave none. */
const priorityOf = (resource: McpMenuResource): number => resource.priority ?? NEUTRAL_PRIORITY;

/**
 * `rows` that `query` matches by the first of `keys` that does, in passes: the matches of the first key best first, then
 * the matches of the second among the rest, and so on. Within a pass by match, then by the server's `annotations.priority`
 * (higher first), then in the order given.
 */
const rankedInPasses = <A>(
  query: string,
  rows: readonly A[],
  keys: ReadonlyArray<(row: A) => string>,
  priority: (row: A) => number,
): readonly A[] => {
  const ranked: A[] = [];

  for (const key of keys) {
    const rest = rows.filter((row) => !ranked.includes(row));

    ranked.push(...rank(query, rest, key, (row) => -priority(row)));
  }

  return ranked;
};

/** The resources `query` matches in `resources`, best first: by name or title, then by URI (`rankedInPasses`). */
const rankedResources = (
  query: string,
  resources: readonly McpMenuResource[],
): readonly McpMenuResource[] =>
  rankedInPasses(
    query,
    resources,
    [(resource) => resource.title ?? resource.name, (resource) => resource.uri],
    priorityOf,
  );

/** One resource as a row: its title or name, its URI muted after it, and the first line of its description. */
const resourceRow = (server: McpMenuServer, resource: McpMenuResource): MenuEntry => ({
  id: `resource:${server.server}:${resource.uri}`,
  label: resource.title ?? resource.name,
  detail: resource.uri,
  description: firstLine(resource.description ?? "") || resource.mimeType,
  pick: { kind: "resource", server: server.server, resource },
});

/** The row of a server whose resources are not listed: muted, with why. */
const mutedServerRow = (server: McpMenuServer): MenuEntry => ({
  id: `resource-server:${server.server}`,
  label: server.server,
  description: resourceStateNote(server.state),
  muted: true,
  pick: { kind: "none" },
});

/** The `@<server>:` a query starts with, when it names a server the menu lists; and what follows it. */
const narrowedTo = (
  query: string,
  resources: McpResourceMenu | null,
): { readonly server: McpMenuServer; readonly rest: string } | undefined => {
  const found = /^([^\s:]+):(.*)$/u.exec(query);

  if (found === null || resources === null) return undefined;

  const wanted = normalizeMcpName(found[1] ?? "");
  const server = resources.servers.find((each) => normalizeMcpName(each.server) === wanted);

  return server === undefined ? undefined : { server, rest: found[2] ?? "" };
};

/**
 * The MCP resources after the files: one section per server, "MCP · <server>" (plus "· from <repo>" for a Repo's), each
 * resource a row. The rows are ranked by how well they match what is typed, then by the `annotations.priority` the server
 * gave (higher first), then by the servers' order and the order each listed them in, and a server's section stands where its best
 * row does. A server whose resources are not listed (it is
 * connecting, needs a sign-in, or is a stdio server whose Container is stopped, which the menu never starts) is a muted
 * row, shown while its name matches.
 */
const resourceSections = (
  query: string,
  resources: McpResourceMenu | null,
): readonly { readonly label: string; readonly rows: readonly MenuEntry[] }[] => {
  if (resources === null) return [];

  const listed = resources.servers.filter((server) => server.state === MENU_STATE.ok);

  // A row matches by its name or title, else by its URI, else by its server's name.
  const rows = rankedInPasses(
    query,
    listed.flatMap((server) => server.resources.map((resource) => ({ server, resource }))),
    [
      ({ resource }) => resource.title ?? resource.name,
      ({ resource }) => resource.uri,
      ({ server }) => server.server,
    ],
    ({ resource }) => priorityOf(resource),
  );

  const servers = [...new Set(rows.map(({ server }) => server))];

  const sections = servers.map((server) => ({
    label: `MCP · ${server.server}${sourceNote(server.source)}`,
    rows: rows.flatMap((row) => (row.server === server ? [resourceRow(server, row.resource)] : [])),
  }));

  const muted = rank(
    query,
    resources.servers.filter((server) => server.state !== MENU_STATE.ok),
    (server) => server.server,
  ).map((server) => ({
    label: `MCP · ${server.server}`,
    rows: [mutedServerRow(server)],
  }));

  return [...sections, ...muted];
};

/**
 * The `@` menu: the files and folders (`filesMenu`), then the MCP resources by server. `@<server>:` lists that server's
 * resources alone, narrowed by what follows the colon. With no rows it says what `filesMenu` does.
 */
const mentionMenu = (
  query: string,
  files: FileResults,
  resources: McpResourceMenu | null,
): Completion => {
  const narrowed = narrowedTo(query, resources);

  if (narrowed !== undefined) {
    const { server, rest } = narrowed;

    const rows: readonly MenuEntry[] =
      server.state === MENU_STATE.ok
        ? rankedResources(rest, server.resources).map((resource) => resourceRow(server, resource))
        : [mutedServerRow(server)];

    return rows.length > 0
      ? {
          label: "MCP resources",
          sections: [{ label: `MCP · ${server.server}${sourceNote(server.source)}`, rows }],
          entries: rows,
        }
      : {
          label: "MCP resources",
          sections: [],
          entries: [],
          notice: `No matching resources in ${server.server}.`,
        };
  }

  const found = filesMenu(query, files);
  const sections = resourceSections(query, resources);

  if (sections.length === 0) return found;

  const all = [...found.sections, ...sections];

  return {
    label: found.sections.length > 0 ? "Files and MCP resources" : "MCP resources",
    sections: all,
    entries: [...found.entries, ...sections.flatMap((section) => section.rows)],
  };
};

/** What a prompt's arguments look like in a row: `<required> [optional]`, in declared order. */
export const promptHint = (prompt: McpPromptEntry): string | undefined =>
  prompt.arguments.length === 0
    ? undefined
    : prompt.arguments
        .map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`))
        .join(" ");

/** The first line of `text`, trimmed. */
const firstLine = (text: string): string => text.split("\n", 1)[0]?.trim() ?? "";

/** A prompt's title, " — " and the first line of its description; either alone when the other is absent. */
export const promptSummary = (prompt: McpPromptEntry): string | undefined => {
  const description = firstLine(prompt.description);

  const joined = [prompt.title, description === "" ? undefined : description].filter(
    (part): part is string => part !== undefined && part !== "",
  );

  return joined.length === 0 ? undefined : joined.join(" — ");
};

/** What a menu section for a server says of where its definition is: nothing for the owner's, the Repo's for a Repo's. */
const sourceNote = (source: string): string =>
  source.startsWith("repo:") ? ` · from ${source.slice("repo:".length)}` : "";

/** What a server's muted row says of why its prompts are not there. */
const stateNote = (state: string): string =>
  Match.value(state).pipe(
    Match.when("connecting", () => "connecting…"),
    Match.when("sign_in", () => "sign-in needed"),
    Match.orElse(() => "unavailable"),
  );

/**
 * The MCP prompts the menu lists, after the Skills: one section per server, "MCP · <server>" (and "· from <repo>" for a
 * Repo's), each prompt a row with `mcp__<server>__` muted before its name, its argument hint, then its title and the
 * first line of its description. With no query the servers are in the catalog's order; while typing, the rows are ranked
 * and a server's section stands where its best row does. A server whose prompts are not there yet is a muted row.
 */
const mcpSections = (
  query: string,
  catalog: MenuCatalog,
): readonly { readonly label: string; readonly rows: readonly MenuEntry[] }[] => {
  const ranked = rank(query, catalog.prompts ?? [], ({ command }) => command.slice(1));
  const servers = [...new Set(ranked.map(({ server }) => server))];

  const prompts = servers.map((server) => {
    const own = ranked.filter((prompt) => prompt.server === server);
    const source = own[0]?.source ?? "owner";

    return {
      label: `MCP · ${server}${sourceNote(source)}`,
      rows: own.map((prompt): MenuEntry => {
        const lead = `/mcp__${normalizeMcpName(prompt.server)}__`;
        const led = prompt.command.startsWith(lead);

        return {
          id: `prompt:${prompt.server}:${prompt.name}`,
          prefix: led ? lead : undefined,
          label: led ? prompt.command.slice(lead.length) : prompt.command,
          hint: promptHint(prompt),
          description: promptSummary(prompt),
          pick: { kind: "prompt", prompt },
        };
      }),
    };
  });

  const muted = rank(query, catalog.mcpServers ?? [], (server) => server.server).map((server) => ({
    label: `MCP · ${server.server}`,
    rows: [
      {
        id: `mcp-server:${server.server}`,
        label: server.server,
        description: stateNote(server.state),
        muted: true,
        pick: { kind: "none" },
      } satisfies MenuEntry,
    ],
  }));

  return [...prompts, ...muted];
};

/** The menu of `sections`, leaving out those with no rows; null when none has any. */
const menu = (
  label: string,
  sections: readonly { readonly label: string; readonly rows: readonly MenuEntry[] }[],
): Completion | null => {
  const shown = sections.filter((section) => section.rows.length > 0);

  return shown.length === 0
    ? null
    : { label, sections: shown, entries: shown.flatMap((section) => section.rows) };
};

/**
 * The menu for `trigger`. After `/`: the commands whose names match, then the Prompt templates, then the Skills as
 * `/skill:name`. After a command's name: the values its argument takes. After `$`: the Skills alone, and no menu when
 * none matches, so `$HOME` types on undisturbed. After `@`: the files and folders of `files`, or a notice in their place.
 */
export const completionFor = (
  trigger: Trigger,
  commands: readonly ComposerCommand[],
  catalog: MenuCatalog = NO_CATALOG,
  files: FileResults = NOT_SEARCHED,
  resources: McpResourceMenu | null = null,
): Completion | null => {
  if (trigger.kind === "command") {
    return menu("Commands", [
      {
        label: "Commands",
        rows: rank(trigger.query, commands, ({ name }) => name).map((command): MenuEntry => ({
          id: `command:${command.name}`,
          label: `/${command.name}`,
          hint: command.argumentHint,
          description: command.description,
          // A command without an argument runs as it is picked; one with an argument waits for it.
          pick:
            command.argument === "none"
              ? { kind: "run", command, args: "" }
              : { kind: "insert", text: `/${command.name}` },
        })),
      },
      {
        label: "Prompt templates",
        rows: rank(trigger.query, catalog.templates, ({ name }) => name).map(
          (template): MenuEntry => ({
            id: `template:${template.name}`,
            label: `/${template.name}`,
            hint: template.argumentHint,
            description: template.description,
            pick: { kind: "insert", text: `/${template.name}` },
          }),
        ),
      },
      {
        label: "Skills",
        rows: rank(trigger.query, catalog.skills, ({ name }) => `skill:${name}`).map(
          (skill): MenuEntry => ({
            id: `skill:${skill.name}`,
            label: `/skill:${skill.name}`,
            hint: skill.argumentHint,
            description: skill.description,
            pick: { kind: "insert", text: `/skill:${skill.name}` },
          }),
        ),
      },
      ...mcpSections(trigger.query, catalog),
    ]);
  }

  if (trigger.kind === "argument") {
    const command = commands.find(({ name }) => name === trigger.command);

    if (command?.choices === undefined) return null;

    const label = `/${command.name}`;

    return menu(label, [
      {
        label,
        rows: rank(trigger.query, command.choices, ({ value }) => value).map(
          (choice): MenuEntry => ({
            id: `choice:${choice.value}`,
            label: choice.value,
            description: choice.description,
            pick: { kind: "run", command, args: choice.value },
          }),
        ),
      },
    ]);
  }

  if (trigger.kind === "skill") {
    return menu("Skills", [
      {
        label: "Skills",
        rows: rank(trigger.query, catalog.skills, ({ name }) => name).map((skill): MenuEntry => ({
          id: `skill:${skill.name}`,
          label: `$${skill.name}`,
          description: skill.description,
          pick: { kind: "insert", text: `$${skill.name}` },
        })),
      },
    ]);
  }

  return mentionMenu(trigger.query, files, resources);
};

/** What a key does in an open menu with `rows` rows: move the highlight, pick, close it, or nothing (it types on). */
export type MenuKey = "next" | "previous" | "pick" | "close" | null;

/**
 * The menu's part in `key`: ↑ and ↓ move, Enter (without Shift or Alt) and Tab pick, Escape closes. A menu with no rows,
 * only its notice, takes Escape alone, so Enter sends and the arrows move the caret as they would without it.
 */
export const menuKey = (
  key: { readonly key: string; readonly shiftKey: boolean; readonly altKey: boolean },
  rows: number,
): MenuKey => {
  if (key.key === "Escape") return "close";

  if (rows === 0) return null;

  if (key.key === "ArrowDown") return "next";

  if (key.key === "ArrowUp") return "previous";

  return (key.key === "Enter" && !key.shiftKey && !key.altKey) || key.key === "Tab" ? "pick" : null;
};
