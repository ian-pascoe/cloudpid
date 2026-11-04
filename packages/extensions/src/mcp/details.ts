// What an MCP tool's call keeps in `details` (`docs/architecture/mcp-in-a-session.md` → Calls and results): the tool's
// `title`, its four hints, its `_meta` within a bound, and how a call that ended without a result ended.
//
// `details` is written here and never decoded: pi-durable stores it as JSON, the web reads it as open JSON, and a
// reader takes `error` and `cut` as strings it may not know, so a value a later build adds (a `cut` of another kind)
// needs no fallback in a reader of this build; `McpDetails` is the shape of what a call writes, not a contract a stored
// row is checked against.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain walks over JSON.
import { isJsonObject, type McpProgress } from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { storedBytes } from "../stored-bytes.ts";

/** The hints of a tool's annotations that are booleans, which the card shows as badges; they are untrusted and gate nothing. */
export const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

export type McpHints = { readonly [Hint in (typeof HINTS)[number]]?: boolean };

/**
 * One question the server asked during a call that the owner or cloudpid answered (`docs/architecture/
 * mcp-server-requests.md` → Elicitation requests, Answers): never a value, only the names of the fields answered.
 */
export type McpElicitationDetail = {
  readonly server: string;
  readonly mode: "form";
  readonly action: "accept" | "decline" | "cancel";
  readonly by: "owner" | "cloudpid";
  /** Why cloudpid answered, when it did. */
  readonly reason?: string;
  /** The names of the fields the owner answered. */
  readonly fields: Array<string>;
};

/**
 * One Sampling request the server made during a call (`docs/architecture/mcp-server-requests.md` → Sampling requests,
 * Records): never its content, only what the owner reads on the call's card.
 */
export type McpSamplingDetail = {
  readonly server: string;
  readonly status: "answered" | "refused" | "failed";
  readonly by: "definition" | "cloudpid";
  /** Why it was refused or failed. */
  readonly reason?: string;
  readonly role?: string;
  readonly model?: string;
  readonly tokens?: number;
  readonly cost?: number;
};

/** The most resources a call's `details` names. */
export const MAX_RESOURCE_REFS = 20;

/** The longest URI a reference keeps, in characters: a longer one is left out, since half of a URI names nothing. */
export const MAX_REF_URI = 2048;

/**
 * A resource a call's result names or holds, as `details.resources` records it for the web (`docs/architecture/
 * mcp-in-a-session.md` → Resource links and embedded resources): a `link` the server pointed to, an embedded or read
 * `text` or `image` the model was shown, or a `spill` saved to the Workspace (`path`). `part` is the index of the
 * content block (or of the read's contents) it came from. Never the resource's contents.
 */
export type McpResourceRef = {
  readonly uri: string;
  readonly mimeType?: string;
  /** Bytes, when known. */
  readonly size?: number;
  readonly kind: "text" | "image" | "spill" | "link";
  readonly part?: number;
  readonly path?: string;
};

/**
 * What an MCP tool's call keeps in `details`. `error` and `cut` say how a call that has no result ended: `cut` that the
 * Session's end (`host_lost`) or the host's end (`engine_lost`) of the call was lost, so it may have run.
 */
export type McpDetails = {
  readonly server: string;
  readonly tool: string;
  readonly title?: string;
  readonly hints?: McpHints;
  readonly meta?: { readonly [key: string]: JsonValue };
  readonly full_output_path?: string;
  readonly progress?: McpProgress;
  readonly error?: "too_large" | "invalid_structured_output";
  readonly cut?: "host_lost" | "engine_lost";
  /** The questions the server asked during the call, answered; absent when it asked none. */
  readonly elicitation?: Array<McpElicitationDetail>;
  /** The Sampling requests the server made during the call; absent when it made none. */
  readonly sampling?: Array<McpSamplingDetail>;
  /**
   * A call that failed fast because the server needs the owner signed in (`docs/architecture/mcp-sign-in.md` → Sign-in
   * requests): `status` is `required`, `step_up`, `rejected` or `unavailable`, and `scope` is what a step-up wants.
   */
  readonly sign_in?: { readonly status: string; readonly scope?: string };
  /** How an `mcp_sign_in_ask` call ended: `signed_in`, `declined`, `withdrawn`, `not_applicable`, `step_up_failed`, `unavailable`. */
  readonly sign_in_request?: string;
  /** The resources the result names or holds, at most `MAX_RESOURCE_REFS`; absent when it has none. */
  readonly resources?: Array<McpResourceRef>;
};

/** How much `meta` the card keeps of a tool's `_meta` (stored); keys past it are left out. */
export const MAX_META_BYTES = 16 * 1024;

/** The keys of `_meta` that are kept whatever their size: an MCP App's `ui` (`docs/architecture/mcp-apps.md` → Declaration). */
const KEPT_META_KEYS: ReadonlySet<string> = new Set(["ui"]);

/**
 * What a card keeps of a tool's `_meta`: all of it within `MAX_META_BYTES`; past it the `ui` key (the App's
 * `resourceUri`, `visibility`, `csp`) and as many of the other keys as fit, the smallest first, so one large key never
 * costs the rest.
 */
export const boundedMeta = (
  meta: Schema.Json | undefined,
): { readonly [key: string]: JsonValue } | undefined => {
  if (!isJsonObject(meta)) return undefined;

  // SAFETY: a JSON object, whose values `JsonValue` describes.
  const whole = meta as { readonly [key: string]: JsonValue };

  if (storedBytes(whole) <= MAX_META_BYTES) return whole;

  const entries = Record.toEntries(whole);
  const kept = Arr.filter(entries, ([key]) => KEPT_META_KEYS.has(key));
  const others = Arr.filter(entries, ([key]) => !KEPT_META_KEYS.has(key));

  const bySize = Arr.sort(
    Order.mapInput(Order.Number, ([, value]: readonly [string, JsonValue]) => storedBytes(value)),
  );

  const chosen: Array<readonly [string, JsonValue]> = [...kept];

  for (const entry of bySize(others)) {
    if (storedBytes(Record.fromEntries([...chosen, entry])) <= MAX_META_BYTES) chosen.push(entry);
  }

  return chosen.length === 0 ? undefined : Record.fromEntries(chosen);
};

/** What a tool declares that a call's `details` starts from. */
export type DetailedTool = {
  readonly name: string;
  readonly title?: string | undefined;
  readonly annotations?: Schema.Json | undefined;
  readonly _meta?: Schema.Json | undefined;
};

/**
 * What every call of `tool` of `server` starts its `details` from: the tool's `title` (its own, else its annotations'),
 * the hints of its annotations, and its `_meta` within its bound.
 */
export const baseDetails = (server: string, tool: DetailedTool): McpDetails => {
  const { annotations } = tool;
  const hints = isJsonObject(annotations) ? annotations : {};

  const title = tool.title ?? (Predicate.isString(hints["title"]) ? hints["title"] : undefined);

  const given = Arr.flatMap(HINTS, (hint) => {
    const value = hints[hint];

    return Predicate.isBoolean(value) ? [[hint, value] as const] : [];
  });

  const base: Mutable<McpDetails> = { server, tool: tool.name };

  if (title !== undefined) base.title = title;

  if (given.length > 0) base.hints = Record.fromEntries(given);

  const meta = boundedMeta(tool._meta);

  if (meta !== undefined) base.meta = meta;

  return base;
};
