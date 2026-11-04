// RFC 6570 URI templates for an MCP resource template (`docs/architecture/mcp-in-a-session.md` → Arguments and completions):
// the variables the argument form asks for, and the URI its values make. Strings only, as a form's values are: level 4's
// prefix (`:n`) and explode (`*`) modifiers are read, and a string has nothing for explode to do. A variable of `{?…}`
// or `{&…}` is optional; any other is required.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over short strings.

/** One variable of a template, in the order it first appears. */
export interface UriTemplateVariable {
  readonly name: string;
  /** Whether a value is needed: false for a variable that only `{?…}` or `{&…}` expressions use. */
  readonly required: boolean;
}

interface Spec {
  readonly first: string;
  readonly sep: string;
  readonly named: boolean;
  readonly ifEmpty: string;
  readonly reserved: boolean;
}

// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by the operator character of a template
const OPERATORS: Readonly<Record<string, Spec>> = {
  "": { first: "", sep: ",", named: false, ifEmpty: "", reserved: false },
  "+": { first: "", sep: ",", named: false, ifEmpty: "", reserved: true },
  "#": { first: "#", sep: ",", named: false, ifEmpty: "", reserved: true },
  ".": { first: ".", sep: ".", named: false, ifEmpty: "", reserved: false },
  "/": { first: "/", sep: "/", named: false, ifEmpty: "", reserved: false },
  ";": { first: ";", sep: ";", named: true, ifEmpty: "", reserved: false },
  "?": { first: "?", sep: "&", named: true, ifEmpty: "=", reserved: false },
  "&": { first: "&", sep: "&", named: true, ifEmpty: "=", reserved: false },
};

/** One `{…}` of a template: its operator, and its variables with the prefix length each asks for. */
interface Expression {
  readonly operator: string;
  readonly spec: Spec;
  readonly variables: ReadonlyArray<{ readonly name: string; readonly prefix: number | undefined }>;
}

type Piece = string | { readonly expression: Expression; readonly source: string };

const VARIABLE =
  /^((?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})(?:\.?(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2}))*)(?::([1-9][0-9]{0,3})|\*)?$/u;

/** `source`'s expression, or undefined when it is not one a template may hold. */
const expressionOf = (source: string): Expression | undefined => {
  const first = source.charAt(0);
  const operator = first in OPERATORS && first !== "" ? first : "";
  const spec = OPERATORS[operator];
  const list = source.slice(operator.length);

  if (spec === undefined || list === "") return undefined;

  const variables: Array<{ name: string; prefix: number | undefined }> = [];

  for (const each of list.split(",")) {
    const found = VARIABLE.exec(each);

    if (found === null || found[1] === undefined) return undefined;

    variables.push({
      name: found[1],
      prefix: found[2] === undefined ? undefined : Number(found[2]),
    });
  }

  return { operator, spec, variables };
};

/** `template` as literal text and its expressions; a `{` that opens no valid expression stays literal. */
const piecesOf = (template: string): ReadonlyArray<Piece> => {
  const pieces: Array<Piece> = [];
  let literal = "";
  let at = 0;

  while (at < template.length) {
    const open = template.indexOf("{", at);

    if (open === -1) break;

    const close = template.indexOf("}", open + 1);
    const expression = close === -1 ? undefined : expressionOf(template.slice(open + 1, close));

    if (close === -1 || expression === undefined) {
      literal += template.slice(at, open + 1);
      at = open + 1;
      continue;
    }

    literal += template.slice(at, open);

    if (literal !== "") pieces.push(literal);

    literal = "";
    pieces.push({ expression, source: template.slice(open, close + 1) });
    at = close + 1;
  }

  literal += template.slice(at);

  if (literal !== "") pieces.push(literal);

  return pieces;
};

/** Whether the operator is one of the form-style query expressions (`{?…}`, `{&…}`), whose variables a URI can do without. */
const isOptionalOperator = (operator: string): boolean => operator === "?" || operator === "&";

/** The variables of `template`, each once, in the order they first appear. */
export const uriTemplateVariables = (template: string): ReadonlyArray<UriTemplateVariable> => {
  const found = new Map<string, boolean>();

  for (const piece of piecesOf(template)) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a piece is a literal or an expression
    if (typeof piece === "string") continue;

    const optional = isOptionalOperator(piece.expression.operator);

    for (const { name } of piece.expression.variables) {
      found.set(name, (found.get(name) ?? false) || !optional);
    }
  }

  return [...found].map(([name, required]) => ({ name, required }));
};

const UNRESERVED = /[A-Za-z0-9\-._~]/u;
const RESERVED = /[:/?#[\]@!$&'()*+,;=]/u;

/** `value` percent-encoded: everything but the unreserved characters, and with `reserved` the reserved ones and any `%XX` too. */
const encoded = (value: string, reserved: boolean): string => {
  let out = "";
  const characters = Array.from(value);

  for (let at = 0; at < characters.length; at += 1) {
    const character = characters[at] ?? "";

    if (UNRESERVED.test(character) || (reserved && RESERVED.test(character))) {
      out += character;
    } else if (
      reserved &&
      character === "%" &&
      /^[0-9A-Fa-f]{2}$/u.test(characters.slice(at + 1, at + 3).join(""))
    ) {
      out += character;
    } else {
      out += encodeURIComponent(character).replace(
        /[!'()*]/gu,
        (each) => `%${each.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    }
  }

  return out;
};

/** `expression` with `values`: nothing for the variables with no value, which `{?…}` and the rest leave out alike. */
const expanded = (expression: Expression, values: Readonly<Record<string, string>>): string => {
  const { spec } = expression;
  const parts: Array<string> = [];

  for (const { name, prefix } of expression.variables) {
    const value = values[name];

    if (value === undefined || value === "") continue;

    const shown = encoded(
      prefix === undefined ? value : Array.from(value).slice(0, prefix).join(""),
      spec.reserved,
    );

    parts.push(spec.named ? `${name}=${shown}` : shown);
  }

  return parts.length === 0 ? "" : spec.first + parts.join(spec.sep);
};

/**
 * `template` with `values` by variable name: the URI the form's fields make. A variable with no value (or an empty one)
 * is left out of its expression, as RFC 6570 leaves an undefined variable out. `partial` keeps an expression that has a
 * required variable with no value as it is written (`{owner}`), for the form's header, which shows the URI as filled so far.
 */
export const expandUriTemplate = (
  template: string,
  values: Readonly<Record<string, string>>,
  partial = false,
): string => {
  let out = "";

  for (const piece of piecesOf(template)) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a piece is a literal or an expression
    if (typeof piece === "string") {
      out += piece;
      continue;
    }

    const optional = isOptionalOperator(piece.expression.operator);

    const waiting =
      partial &&
      !optional &&
      piece.expression.variables.some(({ name }) => (values[name] ?? "") === "");

    out += waiting ? piece.source : expanded(piece.expression, values);
  }

  return out;
};
