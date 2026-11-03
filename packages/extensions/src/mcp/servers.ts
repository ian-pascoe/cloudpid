// The `mcp_servers` system prompt section and the notice that follows a change to it
// (`docs/architecture/mcp-in-a-session.md` → The prompt cache and the `mcp_servers` section), built purely from the
// servers the `mcp` extension is built from and the offered tools.
//
// - **The listing** is a line for each enabled server that has a `codemode` or `deferred` tool or resources, or that
//   may have one and is not discovered yet: `- mcp__<server> (codemode|tool_search): <summary>`, ending `· resources`
//   when the server has resources, with `(connecting)` or `(needs sign-in)` in place of how its tools are reached for a
//   server with no inventory. Its summary is the entry's `description`, else the first line of the server's
//   `instructions`, cut at 250 characters; the whole section holds at most 4,096, the servers past it counted.
// - **The section** is the intro and then the listing. The listing alone is what a notice's hash stands for, so the
//   intro, which depends on the conversation (whether `codemode` is deferred), never makes a change.
// - **The notice** carries the whole new listing, not the lines that changed: a conversation keeps only the hash of the
//   listing it was last shown, which cannot say what differs, and one list that replaces the last is never misread.
// @effect-diagnostics missingPipeableSignature:off -- builders over plain values.
import { mcpServerNamespace, mcpToolNames, resolveExposure, sha256Hex } from "@cloudpid/config";
import { frozenSection } from "@cloudpid/effect-durable";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  type PromptSection,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { exposureKeys, reachesModel } from "./exposure.ts";
import { extensionName, listedTools, type McpBuildServer } from "./tools.ts";

/** The section's key, and the tag that wraps its text. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/** The longest summary of a server, in characters. */
export const MAX_SUMMARY_LENGTH = 250;

/** The longest whole section, in characters. */
export const MAX_SECTION_LENGTH = 4096;

/** The entry kind of a notice that the listing changed, and of the document that keeps the listing last shown. */
export const MCP_SERVERS_KIND = "cloudpid.mcp-servers";

/** The title of the notice, which the transcript shows. */
export const MCP_SERVERS_NOTICE = "MCP servers changed";

/** What the listing of no server hashes to. */
export type McpListing = {
  /** The lines, one for each server, then a line counting the servers left out; empty when there is none. */
  readonly text: string;
  /** What the notices compare: 128 bits of SHA-256 over `text`. */
  readonly hash: string;
};

const hashOf = (text: string): string => sha256Hex(text).slice(0, 32);

export const EMPTY_LISTING: McpListing = { text: "", hash: hashOf("") };

/** Whether the conversation's `codemode` tool is deferred, which the intro says to load with `tool_search` first. */
export type McpIntroOptions = { readonly codemodeDeferred: boolean };

/**
 * What the section says before the listing: the servers' lines and states, the three resource tools, `codemode` loaded
 * with `tool_search` when it is deferred, and `mcp_sign_in_ask`, in one sentence. No blank line (the listing starts after
 * the first one), and nothing of MCP prompts, which are the owner's.
 */
export const mcpServersIntro = (options: McpIntroOptions): string =>
  Arr.join(
    [
      "MCP servers the owner connected, as of now. Their tools are not all offered directly.",
      ...(options.codemodeDeferred
        ? ["Load codemode with tool_search first: it is not loaded yet."]
        : []),
      "A server marked (codemode) is called from a codemode script as tools.mcp__<server>.<tool>(args); describeNamespace shows its tools.",
      "A server marked (tool_search) has tools you load with tool_search and then call.",
      "(connecting) means the server is not discovered yet: its tools are not known.",
      "A server marked · resources has resources: list_mcp_resources, list_mcp_resource_templates and read_mcp_resource take its name.",
      "(needs sign-in) means the owner must sign in first: load mcp_sign_in_ask with tool_search and ask them.",
    ],
    "\n",
  );

const OPEN = `<${MCP_SERVERS_SECTION}>\n`;
const CLOSE = `\n</${MCP_SERVERS_SECTION}>`;

/** What the listing may take so that the section stays within its bound, whichever intro it has. */
const LISTING_BUDGET =
  MAX_SECTION_LENGTH -
  (OPEN.length + mcpServersIntro({ codemodeDeferred: true }).length + 2 + CLOSE.length);

/** The line that counts the `left` servers a full listing leaves out. */
const overflowLine = (left: number): string => `- … and ${left} more not listed`;

/** `text` as one line with its control characters stripped, cut to `MAX_SUMMARY_LENGTH` characters. */
const summaryText = (text: string): string => {
  const clean = text
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const characters = Array.from(clean);

  return characters.length <= MAX_SUMMARY_LENGTH
    ? clean
    : `${Arr.join(Arr.take(characters, MAX_SUMMARY_LENGTH - 1), "").trimEnd()}…`;
};

/** A server's summary: its entry's `description`, else the first line of its `instructions`, else none. */
const summaryOf = (server: McpBuildServer): string => {
  const { description } = server.server;

  if (Predicate.isString(description)) {
    const text = summaryText(description.replace(/[\r\n\t]+/g, " "));

    if (text !== "") return text;
  }

  const line = Arr.findFirst(
    (server.instructions ?? "").split(/\r\n|\r|\n/),
    (each) => each.replace(/\p{Cc}/gu, "").trim() !== "",
  );

  return Option.match(line, { onNone: () => "", onSome: summaryText });
};

/** How a server's tools are reached, from its tools that are not `direct`; none when it has none. */
type Reach = "codemode" | "tool_search";

const reachOf = (exposures: ReadonlyArray<"codemode" | "deferred">): Reach =>
  exposures.length > 0 && Arr.every(exposures, (each) => each === "deferred")
    ? "tool_search"
    : "codemode";

/** The part of a line that follows the name: the state or how the tools are reached, then the summary and resources. */
const lineOf = (server: McpBuildServer, how: string, resources: boolean): string => {
  // A server's own words are untrusted: no tag of theirs can close the section or open another.
  const summary = summaryOf(server).replaceAll("<", "‹").replaceAll(">", "›");

  return `- ${mcpServerNamespace(server.name)} (${how})${summary === "" ? "" : `: ${summary}`}${
    resources ? " · resources" : ""
  }`;
};

/** A server's line, or none for a server the section does not list. */
const serverLine = (server: McpBuildServer, offered: ReadonlyArray<string>): string | undefined => {
  if (server.state === "disabled") return undefined;

  const keys = exposureKeys(server);

  if (keys.exposure === "hidden") return undefined;

  const resources = server.resources === true;

  if (server.discoveredAt === undefined) {
    // Nothing is known of its tools: it is listed when its entry can make one `codemode` or `deferred`.
    const reached = Arr.filter(
      [keys.exposure, ...Record.values(keys.toolExposure)],
      (each): each is "codemode" | "deferred" => each === "codemode" || each === "deferred",
    );

    if (reached.length === 0 && !resources) return undefined;

    const state =
      server.state === "sign_in" || server.state === "rejected" ? "needs sign-in" : "connecting";

    return lineOf(server, state, resources);
  }

  const listed = listedTools(server);

  const names = mcpToolNames(
    server.name,
    Arr.map(listed, (tool) => tool.name),
  );

  const exposures = Arr.filterMap(listed, (tool) => {
    if (!reachesModel(tool._meta)) return Result.failVoid;

    const { exposure } = resolveExposure({
      server: keys,
      tool: tool.name,
      modelName: names.get(tool.name) ?? tool.name,
      offered,
    });

    return exposure === "codemode" || exposure === "deferred"
      ? Result.succeed(exposure)
      : Result.failVoid;
  });

  if (exposures.length === 0 && !resources) return undefined;

  const how =
    exposures.length > 0
      ? reachOf(exposures)
      : keys.exposure === "deferred"
        ? "tool_search"
        : "codemode";

  return lineOf(server, how, resources);
};

/** The listing of `servers` for `offered`: a line for each, in the set's order, within the section's bound. */
export const mcpListing = (
  servers: ReadonlyArray<McpBuildServer>,
  offered: ReadonlyArray<string>,
): McpListing => {
  const lines = Arr.filterMap(servers, (server) =>
    Result.fromNullishOr(serverLine(server, offered), () => undefined),
  );

  if (lines.length === 0) return EMPTY_LISTING;

  const whole = Arr.join(lines, "\n");

  if (whole.length <= LISTING_BUDGET) return { text: whole, hash: hashOf(whole) };

  // As many lines as fit beside the line that counts the rest.
  let kept = lines.length;

  while (
    kept > 0 &&
    Arr.join([...Arr.take(lines, kept), overflowLine(lines.length - kept)], "\n").length >
      LISTING_BUDGET
  ) {
    kept -= 1;
  }

  const text = Arr.join([...Arr.take(lines, kept), overflowLine(lines.length - kept)], "\n");

  return { text, hash: hashOf(text) };
};

/** The section's text for `listing`: empty with no server listed, so it adds nothing to the prompt. */
export const mcpServersSection = (listing: McpListing, options: McpIntroOptions): string =>
  listing.text === "" ? "" : `${OPEN}${mcpServersIntro(options)}\n\n${listing.text}${CLOSE}`;

/** The hash of the listing a section's text shows: what a conversation was last shown when it holds the section. */
export const listingHashOfSection = (section: string): string => {
  if (!section.startsWith(OPEN) || !section.endsWith(CLOSE)) return EMPTY_LISTING.hash;

  const body = section.slice(OPEN.length, section.length - CLOSE.length);
  const start = body.indexOf("\n\n");

  return start === -1 ? EMPTY_LISTING.hash : hashOf(body.slice(start + 2));
};

/**
 * What a notice tells the model: the whole new listing, which replaces the one it was shown. When the section it was shown
 * listed nothing (`introduce`), it says what the section would have, since the section never did.
 */
export const mcpServersNotice = (listing: McpListing, introduce: boolean): string => {
  const body =
    listing.text === ""
      ? "No MCP server is listed now."
      : `The list now, which replaces the one shown before:\n\n${listing.text}`;

  return Arr.join(
    [
      "<mcp_servers_changed>",
      "The owner's MCP servers changed. This is a notice, not a message from the user.",
      ...(introduce && listing.text !== "" ? [mcpServersIntro({ codemodeDeferred: false })] : []),
      "",
      body,
      "</mcp_servers_changed>",
    ],
    "\n",
  );
};

/** What the section's source gives: the newest listing, and what is told of each request after its first. */
export type McpServersSource = {
  readonly listing: () => McpListing;
  /** Forget what `conversation` is known to have been shown: the section is shown again (a new Context Window). */
  readonly shownAnew: (conversation: ConversationId) => void;
  /** A request of `conversation` found the section shown as `shown`. */
  readonly stillShown: (conversation: ConversationId, shown: string) => Effect.Effect<void>;
};

/**
 * The `mcp_servers` section over `source`: read once per Context Window and then shown as it was (`frozenSection`), so
 * a change never rewrites the system prompt; `source` hears of each later request, to tell the conversation of a change.
 */
export const mcpServersSectionOf = (source: McpServersSource): PromptSection =>
  Effect.runSync(
    frozenSection(
      MCP_SERVERS_SECTION,
      (input) =>
        Effect.sync(() => {
          source.shownAnew(input.conversationId);

          return mcpServersSection(source.listing(), {
            codemodeDeferred: Arr.some(input.agent.deferred, (tool) => tool.name === "codemode"),
          });
        }),
      { whenShown: (input, shown) => source.stillShown(input.conversationId, shown) },
    ),
  );

/**
 * The `mcp` extension with no tools: before the first build, and for a Session whose host offers none. Its section
 * shows nothing and is frozen so, as a section that appeared later would be added to a running Context Window as a patch
 * to the prompt: a server that comes later is told by a notice.
 */
export const emptyMcpExtension: Extension = defineExtension({
  name: extensionName,
  tools: [],
  sections: [Effect.runSync(frozenSection(MCP_SERVERS_SECTION, () => Effect.succeed("")))],
});
