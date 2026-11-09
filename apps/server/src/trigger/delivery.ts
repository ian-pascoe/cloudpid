// What a Trigger object reads of a webhook delivery before it decides (`docs/architecture/triggers.md` → Checks and
// answers, → Filters): the content types it takes, the body as JSON for `match`, the event, the action, the delivery id
// as a Fire's key, and the bot-loop guard's test. Pure, so it runs in Node tests as in the object.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off globalJsonInEffect:off -- plain functions over a delivery's headers and body, whose keys are the sender's.
import { sha256Hex } from "@cloudpid/config/sha256";
import type { WebhookFormat } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** How a body is read: as JSON, as a form (`payload=<JSON>`, as GitHub sends it), or as text that may be JSON. */
export type ContentKind = "json" | "form" | "text";

/** The content type's kind, or undefined for one a Trigger URL refuses (415) and for none. */
export const contentKind = (contentType: string | undefined): ContentKind | undefined => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))) {
    return "json";
  }

  if (type === "application/x-www-form-urlencoded") return "form";

  return type.startsWith("text/") ? "text" : undefined;
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * The body as JSON, which `match` reads: a form's is the JSON inside its `payload` field. Undefined where the body is
 * no JSON, which only fails the paths of a `match`, never the delivery.
 */
export const bodyOf = (kind: ContentKind, text: string): Schema.Json | undefined => {
  const json = kind === "form" ? new URLSearchParams(text).get("payload") : text;

  return json === null ? undefined : Option.getOrUndefined(decodeJson(json));
};

const isObject = (body: Schema.Json | undefined): body is Schema.JsonObject =>
  Predicate.isObject(body) && !Array.isArray(body);

/** The text at `key` of `body`, when `body` is an object and the value there is text. */
const textAt = (body: Schema.Json | undefined, key: string): string | undefined => {
  const value = isObject(body) ? body[key] : undefined;

  return Predicate.isString(value) ? value : undefined;
};

/** The event's name: `X-GitHub-Event` for `github`, the body's `type` for `standard`. */
export const eventOf = (
  format: WebhookFormat,
  headers: { readonly event?: string | undefined },
  body: Schema.Json | undefined,
): string | undefined => (format === "github" ? headers.event : textAt(body, "type"));

/** The body's `action`, when it is text. */
export const actionOf = (body: Schema.Json | undefined): string | undefined =>
  textAt(body, "action");

/** The login of the body's `sender`, when it has one. */
export const senderLogin = (body: Schema.Json | undefined): string | undefined => {
  const sender = isObject(body) ? body["sender"] : undefined;

  return textAt(sender, "login");
};

/** What the bot-loop guard makes of a sender: `own` (the App's own bot: dropped), `unverified` (a bot, and the App's own is not known: dropped) or `pass`. */
export type BotGuard = "own" | "unverified" | "pass";

/**
 * The bot-loop guard's reading of a delivery from `login`, when the App's own bot is `botLogin` (in lower case) or
 * `undefined` while GitHub could not say. It fails closed: a bot's delivery is dropped while its identity can't be
 * checked, since a loop costs more than a missed bot event.
 */
export const botGuard = (login: string | undefined, botLogin: string | undefined): BotGuard => {
  const lower = login?.toLowerCase();

  if (lower === undefined || !lower.endsWith("[bot]")) return "pass";

  if (botLogin === undefined) return "unverified";

  return lower === botLogin ? "own" : "pass";
};

/** The longest delivery id a Fire's key holds as it is. */
const MAX_KEYED_DELIVERY = 200;

/** `delivery`, the sender's id, as a Fire's key and file name hold it: itself, or a hash when it is too long. */
export const keyedDelivery = (delivery: string): string =>
  delivery.length > MAX_KEYED_DELIVERY ? `h-${sha256Hex(delivery)}` : delivery;
