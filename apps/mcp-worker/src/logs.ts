/**
 * The server logs of one engine call (`docs/architecture/mcp-connections.md` → Telemetry; #382 D12.2): each
 * `notifications/message` the core hears is kept as an entry, the last 50, and goes back to the host in the call's
 * result, since a discovery passes no hooks and a function stub would not outlive its invocation anyway. Entries are
 * scrubbed of the call's access tokens and of the secrets of its target (`secretsOf`; a server may echo what it
 * was sent, and all are in the call's `tokens`), and their data is cut to 2 KiB, after the scrub so no token is left cut in half. Nothing here reaches a model.
 */
// @effect-diagnostics globalJsonInEffect:off -- a server's log data, already decoded by the SDK, serialized once.
import { type McpLog } from "@cloudpid/mcp";
import {
  MCP_LOG_DATA_MAX,
  MCP_LOG_RING,
  type McpEngineTargetEncoded,
  type McpLogEntry,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { scrubRaw } from "./scrub.ts";

/** What is kept of a log's text before the scrub: far past what survives it, and bounding what a server can make us hold. */
const RAW_LIMIT = 64 * 1024;

/** The shortest value scrubbed: a shorter one would redact ordinary words. */
const MIN_SECRET_LENGTH = 4;

/** A log's data as text: a string as it is, anything else as its JSON, or nothing at all for what has none. */
const textOf = (log: McpLog): string => {
  if (Predicate.isString(log.data)) return log.data;

  try {
    return JSON.stringify(log.data) ?? "";
  } catch {
    return "";
  }
};

/** The password of a `Basic` credential, which is its base64 text decoded as `user:password`. */
const basicPassword = (credential: string): Array<string> => {
  try {
    const decoded = atob(credential);
    const colon = decoded.indexOf(":");

    return colon < 0 ? [] : [decoded.slice(colon + 1)];
  } catch {
    return [];
  }
};

/** The value of each `name=value` part of a `;`-separated header (a cookie, a parameter list), without its quotes. */
const pairValues = (value: string): Array<string> =>
  Arr.filterMap(value.split(";"), (part) => {
    const equals = part.indexOf("=");

    return equals < 0
      ? Result.failVoid
      : Result.succeed(
          part
            .slice(equals + 1)
            .trim()
            .replaceAll('"', ""),
        );
  });

/**
 * The headers that carry credentials by name, besides `authorization`, `proxy-authorization` and `cookie`. A looser
 * match than the names an entry may not hold as a literal (`docs/architecture/mcp-configuration.md` → Approval: `TOKEN`,
 * `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `PRIVATE_KEY`), which every `key` here covers: a
 * header that is wrongly taken for one only has its value scrubbed from the text it is echoed in.
 */
const CREDENTIAL_HEADER = /key|token|secret|auth|session|passw(?:or)?d|credential|signature/i;

/**
 * What the header `name` holds that a server may echo, when it is one that carries a credential; nothing for any other
 * (`X-Org: acme` is no secret, and scrubbing `acme` would rename a tool). A credential written into a header, rather
 * than referenced as `${NAME}`, is not a Secret to the host, so it is found here:
 * - `authorization` and `proxy-authorization`: the credential after the scheme (`Bearer x` gives `x`), and a `Basic` one's
 *   password;
 * - `cookie`: the value of each `name=value` part;
 * - a header whose name looks like a credential's: the whole value, and the value of each `name=value` part.
 */
const headerSecrets = (name: string, value: string): Array<string> => {
  const header = name.toLowerCase();
  const space = value.indexOf(" ");
  const scheme = space < 0 ? "" : value.slice(0, space);
  const credential = space < 0 ? value : value.slice(space + 1).trim();

  if (header === "authorization" || header === "proxy-authorization") {
    return [credential, ...(scheme.toLowerCase() === "basic" ? basicPassword(credential) : [])];
  }

  if (header === "cookie") return pairValues(value);

  return CREDENTIAL_HEADER.test(header) ? [value, ...pairValues(value)] : [];
};

/**
 * What the call scrubs from everything it hands back besides its access tokens: the Secret values the host
 * substituted into `target` (its `redact`, from any header), and what its credential headers hold (`headerSecrets`),
 * each at least `MIN_SECRET_LENGTH` characters.
 */
export const secretsOf = (target: McpEngineTargetEncoded): Array<string> =>
  Arr.dedupe(
    Arr.filter(
      [
        ...(target.redact ?? []),
        // A credential written into a header, or into a stdio server's `env`, rather than referenced as `${NAME}`.
        ...Arr.flatMap(
          Record.toEntries(target.kind === "http" ? (target.headers ?? {}) : (target.env ?? {})),
          ([name, value]) => headerSecrets(name, value),
        ),
      ],
      (secret) => secret.length >= MIN_SECRET_LENGTH,
    ),
  );

type Raw = {
  readonly at: number;
  readonly level: string;
  readonly logger: string | undefined;
  readonly text: string;
};

/** A call's log collector: `hear` each log as it arrives, `entries` what the call gives back. */
export const callLogs = (input: {
  readonly now: () => number;
  /** What to scrub: the tokens the call has sent so far and the Secrets it was given, asked when the entries are made. */
  readonly tokens: () => ReadonlySet<string>;
}) => {
  const raw: Array<Raw> = [];

  return {
    hear: (log: McpLog) => {
      raw.push({
        at: input.now(),
        level: log.level,
        logger: log.logger,
        text: textOf(log).slice(0, RAW_LIMIT),
      });

      if (raw.length > MCP_LOG_RING) raw.shift();
    },
    entries: (): ReadonlyArray<McpLogEntry> => {
      const hidden = input.tokens();

      return Arr.map(raw, (entry): McpLogEntry => {
        const data = scrubRaw(entry.text, hidden).slice(0, MCP_LOG_DATA_MAX);
        const logger = entry.logger === undefined ? undefined : scrubRaw(entry.logger, hidden);

        return logger === undefined
          ? { at: entry.at, level: entry.level, data }
          : { at: entry.at, level: entry.level, logger, data };
      });
    },
  };
};
