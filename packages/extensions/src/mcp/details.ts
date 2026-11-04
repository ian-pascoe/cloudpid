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
import type { McpSamplingGrant } from "./sampling-records.ts";
import type { McpTaskState } from "./task-state.ts";

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
  readonly mode: "form" | "url";
  readonly action: "accept" | "decline" | "cancel";
  readonly by: "owner" | "cloudpid";
  /** Why cloudpid answered, when it did. */
  readonly reason?: string;
  /** The names of the fields the owner answered. */
  readonly fields: Array<string>;
  /** The host of the page a URL-mode question asked the owner to open; never the address. */
  readonly host?: string;
  /** The server said the owner finished at the page (`notifications/elicitation/complete`). */
  readonly finished?: true;
};

/**
 * Why cloudpid turned a Sampling request down or failed it, as a tag the card and the model's line read instead of the
 * words: the Spend limit (`budget`), the call's cap (`cap`), a request that is invalid (`invalid`) or cannot be served
 * (`unservable`), the model (`model`), the owner not answering in time (`unanswered`), or cloudpid's own seam (`internal`: the models not ready, a record not kept).
 */
export type McpSamplingWhy =
  | "budget"
  | "cap"
  | "invalid"
  | "unservable"
  | "model"
  | "unanswered"
  | "internal";

/** Who decided a Sampling request: the server's definition (`allow`), the owner on the card, a grant of theirs, or cloudpid's own rules. */
export type McpSamplingBy = "definition" | "owner" | "grant" | "cloudpid";

/**
 * One Sampling request the server made during a call (`docs/architecture/mcp-server-requests.md` → Sampling requests,
 * Records): never its content, only what the owner reads on the call's card.
 */
export type McpSamplingDetail = {
  readonly server: string;
  readonly status: "answered" | "refused" | "failed";
  readonly by: McpSamplingBy;
  /** What let it run without the card's own yes, for one that ran on the owner's say: the call, the Session or Always. */
  readonly grant?: McpSamplingGrant;
  /** Why it was refused or failed, in words. */
  readonly reason?: string;
  readonly why?: McpSamplingWhy;
  readonly role?: string;
  readonly model?: string;
  readonly tokens?: number;
  readonly cost?: number;
  /** The record's id, which `mcp_sampling_get` reads: what the call's card expands. */
  readonly id?: string;
};

/** The most resources a call's `details` names. */
export const MAX_RESOURCE_REFS = 20;

/**
 * A resource a call's result names or holds, as `details.resources` records it for the web (`docs/architecture/
 * mcp-in-a-session.md` → Resource links and embedded resources): a `link` the server pointed to, an embedded or read
 * `text` or `image` the model was shown, or a `spill` saved to the Workspace (`path`). `part` is the index of the
 * content block (or of the read's contents) it came from. Never the resource's contents. `at` is the index in the result's
 * `output` where the transcript holds the resource's own data (an image, or a text the limits did not cut), which the
 * card previews without a read; absent when the transcript holds none of it.
 */
export type McpResourceRef = {
  readonly uri: string;
  readonly mimeType?: string;
  /** Bytes, when known. */
  readonly size?: number;
  readonly kind: "text" | "image" | "spill" | "link";
  readonly part?: number;
  readonly path?: string;
  readonly at?: number;
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
  /**
   * `sampling_refused`: a Modern server's Sampling request was refused, which ends the call locally (`InputResponse` has no
   * error form): the call's own work may be partly done (`docs/architecture/mcp-server-requests.md` → Sampling requests).
   */
  readonly error?:
    | "too_large"
    | "invalid_structured_output"
    | "sampling_refused"
    | "mcp_task_failed"
    | "mcp_task_cancelled"
    | "mcp_task_unknown"
    | "mcp_task_stopped"
    | "mcp_task_background";
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
  /**
   * The call ran as an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks): its handle, never the server's
   * id, how it stands (`background` once the call returned and it went on), and how long it ran when it ended.
   */
  readonly mcp_task?: {
    readonly task: string;
    readonly status: McpTaskState;
    readonly after_ms?: number;
    readonly background?: boolean;
  };
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
