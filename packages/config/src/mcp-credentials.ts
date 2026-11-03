// Credential-shaped literals in an MCP server entry (`docs/architecture/mcp-configuration.md` → Approval, "Values
// before asking"): text written outright where a Secret belongs. The agent's `settings_mcp_*` tools refuse them; the
// Settings page's form and import warn of them, from this one function, so the two cannot differ.
// @effect-diagnostics missingPipeableSignature:off -- a check of plain values, not a combinator.
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type { McpServerValue } from "./mcp-servers.ts";

/** Where in an entry a credential-shaped literal is: `env` or `headers`, and the key. */
export type McpCredentialLiteral = {
  readonly where: "env" | "headers";
  readonly key: string;
  /** Said as a sentence: where it is, and to keep it as a Secret and write `${NAME}`. */
  readonly message: string;
};

/** A key as the patterns compare it: lower case, without `-` and `_`. */
const comparable = (key: string): string => key.toLowerCase().replaceAll(/[-_]/g, "");

/** The headers whose whole value is a credential (compared with `comparable`). */
const CREDENTIAL_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "xapikey",
  "apikey",
];

/** What an `env` or `headers` key ending in one of these names holds (compared with `comparable`). */
const CREDENTIAL_SUFFIXES: ReadonlyArray<string> = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "accesskey",
  "privatekey",
];

const REFERENCE = /\$\{[^}]*\}/g;

/** `text` without its `${…}`, and, for a header, without one scheme word before the credential (`Bearer `). */
const literalOf = (text: string, scheme: boolean): string =>
  (scheme ? text.replace(/^\s*[A-Za-z][A-Za-z0-9_-]*\s+/, "") : text)
    .replaceAll(REFERENCE, "")
    .trim();

const literalsIn = (
  where: "env" | "headers",
  values: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<McpCredentialLiteral> =>
  Arr.flatMap(Record.toEntries(values ?? {}), ([key, text]) => {
    const name = comparable(key);
    const header = where === "headers" && Arr.contains(CREDENTIAL_HEADERS, name);
    const keyed = Arr.some(CREDENTIAL_SUFFIXES, (suffix) => name.endsWith(suffix));

    if ((!header && !keyed) || literalOf(text, header) === "") return [];

    return [
      {
        where,
        key,
        message: `${where}.${key} holds a literal that looks like a credential: keep it as a Secret and write \${NAME}`,
      },
    ];
  });

/**
 * The credential-shaped literals of an entry: literal text outside `${…}` in the `Authorization`, `Proxy-Authorization`,
 * `Cookie`, `X-API-Key` and `Api-Key` headers (after an optional scheme word), and in `env` and `headers` values whose
 * key ends `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `ACCESS_KEY` or `PRIVATE_KEY` (ignoring case
 * and `-`/`_`).
 */
export const mcpCredentialLiterals = (
  value: Pick<McpServerValue, "env" | "headers">,
): ReadonlyArray<McpCredentialLiteral> => [
  ...literalsIn("env", value.env),
  ...literalsIn("headers", value.headers),
];
