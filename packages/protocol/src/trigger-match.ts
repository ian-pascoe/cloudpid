// A webhook Trigger's `match` filter (`docs/architecture/triggers.md` → Filters): a map from dotted paths in the
// delivery's body to the values it may have there. Paths are ANDed and the values of one path ORed; the event's name is
// the path `event`. There is no cap on paths or values. Pure, so the Registry checks a `match` it keeps and the Trigger
// object evaluates a delivery with the same code.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over a parsed body, whose keys are the sender's.
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Dotted paths in a delivery's body, each with the values it may have: `{ "workflow_run.conclusion": ["failure"] }`. */
export const TriggerMatch = Schema.Record(Schema.String, Schema.Array(Schema.String));

export type TriggerMatch = typeof TriggerMatch.Type;

/** The path whose value is the delivery's event name (`X-GitHub-Event`, or a `standard` body's `type`). */
export const EVENT_PATH = "event";

/** Why `match` can't filter deliveries, or undefined when it can: every path names something, and lists a value. */
export const matchProblem = (match: TriggerMatch): string | undefined => {
  for (const [path, values] of Object.entries(match)) {
    if (path.trim() === "" || path.split(".").some((segment) => segment === "")) {
      return `"${path}" is not a path: write names joined by dots, like workflow_run.conclusion`;
    }

    if (values.length === 0) {
      return `The path "${path}" lists no values, so nothing would match: list one, or take the path out`;
    }
  }

  return undefined;
};

/** `value` as the text a `match` value is compared with, or undefined for what is no scalar (an object, an array). */
const scalarText = (value: Schema.Json | undefined): string | undefined => {
  if (Predicate.isString(value)) return value;

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);

  return value === null ? "null" : undefined;
};

/** Whether `value` is an object (not an array, not null): of the body's JSON, a `JsonObject`. */
const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * The value at dotted `path` in `body`, or undefined where there is none. A segment names an own key of an object, or an
 * index of an array (`commits.0.message`); `__proto__` and the like are never followed.
 */
const valueAt = (body: Schema.Json | undefined, path: string): Schema.Json | undefined => {
  let current = body;

  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      current = current[/^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : -1];
    } else if (isJsonObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }

  return current;
};

/**
 * Whether a delivery passes `match`: for every path, its value (the event's name for `event`, else the body's at that
 * dotted path) is one of the path's values. Numbers and booleans are compared as their text (`true`, `42`); a path that
 * holds an object, an array or nothing never matches. No `match` (or an empty one) passes every delivery.
 */
export const matchesDelivery = (
  match: TriggerMatch | undefined,
  delivery: { readonly event: string | undefined; readonly body: Schema.Json | undefined },
): boolean => {
  if (match === undefined) return true;

  return Object.entries(match).every(([path, allowed]) => {
    const found = path === EVENT_PATH ? delivery.event : scalarText(valueAt(delivery.body, path));

    return found !== undefined && allowed.includes(found);
  });
};
