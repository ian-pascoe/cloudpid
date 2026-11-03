// The `${NAME}` values of an MCP server (`docs/architecture/mcp-configuration.md` → `${NAME}` values): resolved at use,
// per Environment, never in the set the Registry keeps or hashes. An owner's entry resolves a name against the
// Environment's Secrets (its own, then Global's: `usedSecrets` hands them merged), then its Variables; a Repo's entry
// against Variables only. The host keeps the answer in memory only. Nothing here logs a value.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import type { McpResolvedServer } from "@cloudpid/config";
import type { McpServerValuesAnswer, McpSignInSecretRef } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

/** What `${NAME}` is read from. */
export type McpValueSources = {
  /** The Secrets the Environment uses, by name (its own over Global's). */
  readonly secrets: Readonly<Record<string, string>>;
  /** The Variables in force, by name (the Environment's own over Global's). */
  readonly variables: Readonly<Record<string, string>>;
};

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Values = Extract<McpServerValuesAnswer, { readonly status: "values" }>;

/** What resolving notes besides the text: the names with no value, and the values that came from Secrets. */
type Tally = { readonly missing: Set<string>; readonly secrets: Set<string> };

/**
 * `text` with each `${NAME}` replaced by its value; a name with none stays as written and is added to `missing`, and a
 * value read from a Secret is added to `secrets`.
 */
const resolveText = (
  text: string,
  sources: McpValueSources,
  allowSecrets: boolean,
  tally: Tally,
): string =>
  text.replaceAll(REFERENCE, (reference, name: string) => {
    const secret = allowSecrets ? Record.get(sources.secrets, name) : Option.none();
    const found = Option.orElse(secret, () => Record.get(sources.variables, name));

    if (Option.isNone(found)) {
      tally.missing.add(name);

      return reference;
    }

    if (Option.isSome(secret)) tally.secrets.add(found.value);

    return found.value;
  });

/**
 * The `env` (a stdio server's) and `headers` (an HTTP server's) of `resolved` with every `${NAME}` resolved, and the
 * names that resolved to nothing, which stay as written for the host to skip the server or connect without them. The
 * values that came from Secrets go back as `redact`, for the engine to scrub from what it hands back.
 */
export const resolveMcpServerValues = (
  resolved: McpResolvedServer,
  sources: McpValueSources,
): Values => {
  const tally: Tally = { missing: new Set<string>(), secrets: new Set<string>() };
  const { server } = resolved;
  const given = server.type === "stdio" ? server.env : server.headers;

  const values = Record.map(given, (text) =>
    resolveText(text, sources, resolved.resolvesSecrets, tally),
  );

  return {
    status: "values",
    env: server.type === "stdio" ? values : {},
    headers: server.type === "http" ? values : {},
    missing: Arr.sort(Arr.fromIterable(tally.missing), Order.String),
    redact: Arr.sort(Arr.fromIterable(tally.secrets), Order.String),
  };
};

/** The client secret of an entry, resolved at use (→ The `oauth` fields). */
export type OauthSecret =
  | { readonly status: "none" }
  | { readonly status: "ok"; readonly value: string; readonly ref: McpSignInSecretRef | null }
  | { readonly status: "missing"; readonly name: string };

const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * `resolved`'s `oauth.clientSecret`: exactly one `${NAME}`, read from the Secrets (an owner's entry only) and then the
 * Variables, with the reference it resolved to; or a literal, which only a Repo's file may hold (it has no reference). A name
 * with no value is `missing`. Nothing here logs a value.
 */
export const resolveOauthSecret = (
  resolved: McpResolvedServer,
  sources: McpValueSources,
): OauthSecret => {
  const text = resolved.server.type === "http" ? resolved.server.oauth?.clientSecret : undefined;

  if (text === undefined) return { status: "none" };

  const name = WHOLE_REFERENCE.exec(text)?.[1];

  if (name === undefined) return { status: "ok", value: text, ref: null };

  const secret = resolved.resolvesSecrets ? Record.get(sources.secrets, name) : Option.none();

  if (Option.isSome(secret)) {
    return { status: "ok", value: secret.value, ref: { scope: "secret", name } };
  }

  const variable = Record.get(sources.variables, name);

  return Option.isSome(variable)
    ? { status: "ok", value: variable.value, ref: { scope: "variable", name } }
    : { status: "missing", name };
};
