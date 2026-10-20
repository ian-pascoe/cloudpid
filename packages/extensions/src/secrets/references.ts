// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// Secret References (`docs/spec.md` → Secrets), ported from pi-secret's `secret-references.ts` (see ../../NOTICE.md):
// a double-brace placeholder in any string argument, which the Secrets wrapper replaces with the value just before
// the tool runs, and an environment variable under `SECRET_ENV_PREFIX` in commands, which it injects into the
// command's environment. A backslash right before either form writes it as literal text.
import type { JsonValue } from "@earendil-works/pi-ai";
import * as Predicate from "effect/Predicate";

/** Prefix of the environment variable a held Secret is injected as. */
export const SECRET_ENV_PREFIX = "PI_SECRET_";

/** Environment-variable style: an uppercase letter or underscore, then uppercase letters, digits, or underscores. */
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Kept apart so no source file spells a whole placeholder, which the agent's own Secrets would refuse to write.
const OPEN = "{" + "{secret:";
const CLOSE = "}" + "}";

/** The placeholder that stands for a Secret's value in tool arguments, and for a redacted value in output. */
export const secretReference = (name: string): string => `${OPEN}${name}${CLOSE}`;

/** The environment variable that carries a Secret's value into commands. */
export const secretEnvName = (name: string): string => `${SECRET_ENV_PREFIX}${name}`;

/** The environment reference as a shell spells it without `$`: the variable's name. */
export const envReference = secretEnvName;

/** Whether `name` is a valid Secret Name. */
export const isSecretName = (name: string): boolean => SECRET_NAME_PATTERN.test(name);

/**
 * A Secret Reference in either form, optionally escaped by a backslash right before it:
 * - the placeholder, with anything but braces between the colon and the closing braces, so malformed names are caught;
 * - the environment variable as a whole word, however a shell or program spells the expansion around it. The bare
 *   prefix names no Secret, so a command that only mentions it, such as `env | grep` for it, is not a reference.
 */
const REFERENCE = new RegExp(
  String.raw`(\\?)(?:\{\{secret:([^{}]*)\}\}|(?<![A-Za-z0-9_])` +
    SECRET_ENV_PREFIX +
    String.raw`([A-Za-z0-9_]+))`,
  "g",
);

/** `\$` or `\${` right before an expansion: the shell prints it literally. */
const SHELL_ESCAPE = /\\\$\{?$/;

type ReferenceMatch = {
  readonly escaped: boolean;
  readonly name: string;
  readonly form: "placeholder" | "env";
};

/** The reference matched at `index` of `text`, or undefined when a shell escape makes it literal. */
const matchOf = (
  groups: ReadonlyArray<string | undefined>,
  text: string,
  index: number,
): ReferenceMatch | undefined => {
  const [escape, placeholder, env] = groups;

  if (placeholder !== undefined) {
    return { escaped: escape === "\\", name: placeholder, form: "placeholder" };
  }

  if (escape !== "\\" && SHELL_ESCAPE.test(text.slice(Math.max(0, index - 3), index))) {
    return undefined;
  }

  return { escaped: escape === "\\", name: env ?? "", form: "env" };
};

const visitStrings = (value: JsonValue, visit: (text: string) => void): void => {
  if (Predicate.isString(value)) {
    visit(value);

    return;
  }

  if (!Predicate.isObjectOrArray(value)) return;

  for (const item of Object.values(value)) visitStrings(item, visit);
};

/**
 * Every Secret Name `value` references, in either form, including names that are not valid Secret Names, so a call
 * naming one can be refused rather than run as typed. Escaped references name nothing.
 */
export const referencedSecretNames = (value: JsonValue): Set<string> => {
  const names = new Set<string>();

  visitStrings(value, (text) => {
    for (const found of text.matchAll(REFERENCE)) {
      const match = matchOf(found.slice(1), text, found.index);

      if (match !== undefined && !match.escaped) names.add(match.name);
    }
  });

  return names;
};

const rewriteText = (text: string, resolve: (name: string) => string): string => {
  let rewritten = "";
  let last = 0;

  for (const found of text.matchAll(REFERENCE)) {
    const [whole] = found;
    const match = matchOf(found.slice(1), text, found.index);

    rewritten += text.slice(last, found.index);

    if (match === undefined || (!match.escaped && match.form === "env")) rewritten += whole;
    else rewritten += match.escaped ? whole.slice(1) : resolve(match.name);

    last = found.index + whole.length;
  }

  rewritten += text.slice(last);

  return rewritten === text ? text : rewritten;
};

/**
 * `value` with every placeholder replaced by `resolve(NAME)` and every escaped reference turned into literal text
 * without its backslash. Environment references are left as written: the command's environment resolves them. Returns
 * `value` itself when nothing changed.
 */
export const rewriteReferences = <A extends JsonValue>(
  value: A,
  resolve: (name: string) => string,
): A =>
  // SAFETY: rewriting keeps every container's shape and replaces strings with strings.
  rewriteJson(value, resolve) as A;

const rewriteJson = (value: JsonValue, resolve: (name: string) => string): JsonValue => {
  if (Predicate.isString(value)) return rewriteText(value, resolve);

  if (!Predicate.isObjectOrArray(value)) return value;

  let changed = false;

  const rewrite = (item: JsonValue): JsonValue => {
    const next = rewriteJson(item, resolve);

    if (next !== item) changed = true;

    return next;
  };

  if (Array.isArray(value)) {
    const items = value.map(rewrite);

    return changed ? items : value;
  }

  const entries = Object.entries(value).map(([key, item]) => [key, rewrite(item)] as const);

  return changed ? Object.fromEntries(entries) : value;
};
