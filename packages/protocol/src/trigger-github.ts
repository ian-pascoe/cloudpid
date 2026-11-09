// GitHub's webhook bodies as a Fire's message shows them inline (`docs/architecture/triggers.md` → Payload and untrusted
// content): GitHub's payloads are mostly links, so the `github` format's inline body drops the `*_url` API links but
// `html_url`, and shrinks `repository`, `sender`, `organization` and `installation` to their names (null for one with
// none). The file in the Workspace keeps the whole body as received; only the inline text is trimmed. Pure.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- a plain walk over parsed JSON.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The objects shrunk to their name, and the field that names each. */
const NAMED = {
  repository: ["full_name", "name"],
  organization: ["login"],
  sender: ["login"],
  installation: ["id"],
} as const satisfies Record<string, ReadonlyArray<string>>;

const isNamed = (key: string): key is keyof typeof NAMED => Object.hasOwn(NAMED, key);

const isObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Whether `key` is an API link GitHub's payloads are full of: `*_url`, but the page a person opens, `html_url`. */
const isApiLink = (key: string): boolean => key.endsWith("_url") && key !== "html_url";

/**
 * `value`'s name, when it is one of the objects shrunk to theirs: null when it has none, since the object is still all
 * links. Undefined for any other value, which is trimmed as it is.
 */
const nameOf = (key: string, value: Schema.Json): Schema.Json | undefined => {
  if (!isNamed(key) || !isObject(value)) return undefined;

  for (const field of NAMED[key]) {
    const name = value[field];

    if (Predicate.isString(name) || Predicate.isNumber(name)) return name;
  }

  return null;
};

/** `value` trimmed as the inline body shows a GitHub payload, at every depth. */
export const trimGitHubJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(trimGitHubJson);

  if (!isObject(value)) return value;

  // `Object.fromEntries` defines each key as its own, so a `__proto__` key in the payload stays a field.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isApiLink(key))
      .map(([key, field]) => {
        const name = nameOf(key, field);

        return [key, name === undefined ? trimGitHubJson(field) : name];
      }),
  );
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** `text` as JSON, or undefined when it isn't. */
const parsed = (text: string): Schema.Json | undefined => Option.getOrUndefined(decodeJson(text));

/**
 * A GitHub delivery's body as the inline text shows it: its JSON trimmed (`trimGitHubJson`), written without spacing.
 * A body sent as `application/x-www-form-urlencoded` is `payload=<JSON>`: its JSON is shown, trimmed. Undefined for a
 * body that holds no JSON, which is shown as it is.
 */
export const trimGitHubBody = (body: string): string | undefined => {
  const json = parsed(body) ?? formPayload(body);

  return json === undefined ? undefined : JSON.stringify(trimGitHubJson(json));
};

/** The JSON in the `payload` field of a form-encoded body, or undefined for none. */
const formPayload = (body: string): Schema.Json | undefined => {
  const payload = new URLSearchParams(body).get("payload");

  return payload === null ? undefined : parsed(payload);
};
