/**
 * What the engine takes out of what a server tells it (`docs/architecture/mcp-connections.md` → Telemetry): the values
 * the call keeps secret (its access tokens, the Secrets the host put into its target, the credentials in its headers),
 * which a server may echo into a log, an error, a result or its own listing. It catches accidents, not a server bent on
 * leaking: a prefix or a suffix of a value, or one cut by the server, is not found.
 *
 * Only the **string values** of a JSON value are touched. Keys, numbers, booleans and the engine's own fields (`state`,
 * `kind`, `era`, `protocolVersion`, times and ids) are never rewritten, so a secret that happens to be `1759` or `2025`
 * cannot break the structure or the rows the host stores. A name is never rewritten either, since a call is made by it:
 * a tool or prompt whose name, or any key of its schema, holds a secret is left out, with a problem that says only its
 * place in the list.
 */
// @effect-diagnostics missingPipeableSignature:off -- plain functions over plain values, not combinators.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- a walk over any JSON-shaped value, the SDK's decoded lists and results included, which changes only its strings and returns what it was given */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type { McpPromptProblem, McpToolProblem } from "@cloudpid/mcp/types";

const REDACTED = "[REDACTED]";

/** `token` as it appears inside a JSON string: a `"` or a `\` escaped. */
const escapedForm = (token: string) => JSON.stringify(token).slice(1, -1);

/** Every form of `token` a server may echo: as it is, JSON-escaped, and encoded for a URL path and a query. */
const formsOf = (token: string): ReadonlyArray<string> => [
  token,
  escapedForm(token),
  encodeURIComponent(token),
  new URLSearchParams({ k: token }).toString().slice(2),
];

/** `text` with each form of each of `tokens` replaced, longest first, so a form that contains another leaves no remainder. */
export const scrubRaw = (text: string, tokens: ReadonlySet<string>) => {
  let scrubbed = text;

  const forms = Arr.filter(Arr.flatMap([...tokens], formsOf), (form) => form.length > 0);

  for (const form of Arr.sort(
    forms,
    Order.mapInput(Order.Number, (each: string) => -each.length),
  )) {
    scrubbed = scrubbed.replaceAll(form, REDACTED);
  }

  return scrubbed;
};

const walk = (value: unknown, change: (text: string) => string): unknown => {
  if (Predicate.isString(value)) return change(value);

  if (Arr.isArray(value)) return Arr.map(value, (each) => walk(each, change));

  if (Predicate.isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Record.map(value, (each) => walk(each, change));
  }

  return value;
};

/** `value` with every token of `tokens` replaced inside its string values, and nowhere else. */
export const scrubValues = <A>(value: A, tokens: ReadonlySet<string>): A => {
  if (tokens.size === 0) return value;

  // SAFETY: only strings are replaced, by strings; every key, number and shape stays as it was.
  return walk(value, (text) => scrubRaw(text, tokens)) as A;
};

const holds = (text: string, tokens: ReadonlySet<string>) =>
  Arr.some([...tokens], (token) => token.length > 0 && text.includes(token));

const keysHold = (value: unknown, tokens: ReadonlySet<string>): boolean => {
  if (Arr.isArray(value)) return Arr.some(value, (each) => keysHold(each, tokens));

  return Predicate.isObject(value)
    ? Arr.some(
        Record.toEntries(value),
        ([key, each]) => holds(key, tokens) || keysHold(each, tokens),
      )
    : false;
};

/** An item's name, empty for one that has none. */
const nameOf = (item: unknown) => {
  const name = Predicate.isObject(item) ? Record.get(item, "name") : Option.none();

  return Option.filter(name, Predicate.isString).pipe(Option.getOrElse(() => ""));
};

/** Whether `item`, a tool or a prompt, holds a secret in its name or in a key of its declaration. */
const heldBy = (item: unknown, tokens: ReadonlySet<string>) =>
  holds(nameOf(item), tokens) || keysHold(item, tokens);

/** What stands for an item left out: its place in the list. */
const placeOf = (kind: "tool" | "prompt", index: number) => `${kind} #${index + 1}`;

const LEFT_OUT =
  "left out: its name or a key of its declaration held a value this call keeps secret";

/**
 * The tools or prompts (`kind`) of `items` that may be kept, their string values scrubbed, and the places of those left
 * out. A name or a key is never rewritten, so an item that holds a secret in one is left out.
 */
export const vetListed = <A>(
  kind: "tool" | "prompt",
  items: ReadonlyArray<A>,
  tokens: ReadonlySet<string>,
) => {
  const placed = Arr.map(items, (item, index) => ({ item, place: placeOf(kind, index) }));

  return {
    kept: Arr.map(
      Arr.filter(placed, ({ item }) => !heldBy(item, tokens)),
      ({ item }) => scrubValues(item, tokens),
    ),
    left: Arr.map(
      Arr.filter(placed, ({ item }) => heldBy(item, tokens)),
      ({ place }) => place,
    ),
  };
};

/** The problem of each tool in `places`. */
export const toolsLeftOut = (places: ReadonlyArray<string>): ReadonlyArray<McpToolProblem> =>
  Arr.map(places, (tool) => ({ tool, problem: LEFT_OUT }));

/** The problem of each prompt in `places`. */
export const promptsLeftOut = (places: ReadonlyArray<string>): ReadonlyArray<McpPromptProblem> =>
  Arr.map(places, (prompt) => ({ prompt, problem: LEFT_OUT }));
