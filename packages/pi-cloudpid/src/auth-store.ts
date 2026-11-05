// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off asyncFunction:off nodeBuiltinImport:off globalDate:off tryCatchInEffectGen:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain functions over values, called directly; plain Promises, as node's fs gives them; runs on node, on the owner's machine; the time the tokens were obtained.
/**
 * Where the sign-in is kept (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The connection):
 * `<pi agent dir>/cloudpid-auth.json`, mode 0600, one entry per endpoint URL (the client registration, the tokens, and
 * when the tokens were obtained, for refreshing before they expire), so a project pointed at a preview stage keeps its
 * own sign-in. Written atomically (a temp file in the same directory, then a rename), so a crash leaves the old file or
 * the new one. A seam: tests give a temporary directory's.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import * as Predicate from "effect/Predicate";
import { Refusal } from "./errors.ts";
import { isJson, type JsonObject, objectField, stringField, toObject } from "./json.ts";

/** What is kept for one endpoint. */
export interface AuthEntry {
  /** The Dynamic Client Registration this machine made. */
  readonly client?: StoredOAuthClientInformation | undefined;
  readonly tokens?: StoredOAuthTokens | undefined;
  /** When `tokens` were obtained (ms since the epoch), the base of their `expires_in`. */
  readonly obtainedAt?: number | undefined;
  /** What discovery found, so a refresh needs none (Access serves the resource metadata outside the host's root). */
  readonly discovery?: OAuthDiscoveryState | undefined;
}

/** The sign-ins of this machine, by endpoint URL. */
export interface AuthStore {
  readonly read: (endpoint: string) => Promise<AuthEntry | undefined>;
  /** Replaces the endpoint's entry; the other endpoints' stay. */
  readonly write: (endpoint: string, entry: AuthEntry) => Promise<void>;
  /** Whether there was an entry to delete. */
  readonly remove: (endpoint: string) => Promise<boolean>;
}

/** The file name, in pi's agent directory. */
export const AUTH_FILE = "cloudpid-auth.json";

const FILE_VERSION = 1;

/** `entry` as the SDK's types, when its parts have the fields the flow reads; a part that does not is dropped. */
const entryOf = (raw: JsonObject): AuthEntry => {
  const client = objectField(raw, "client");
  const tokens = objectField(raw, "tokens");
  const discovery = objectField(raw, "discovery");

  const authorizationServerUrl =
    discovery === undefined ? undefined : stringField(discovery, "authorizationServerUrl");

  const obtainedAt = Predicate.isNumber(raw["obtainedAt"]) ? raw["obtainedAt"] : undefined;

  const entry: { -readonly [Key in keyof AuthEntry]: AuthEntry[Key] } = {};

  if (client !== undefined && stringField(client, "client_id") !== undefined) {
    // SAFETY: the file is the one this module writes from the SDK's own values; the fields the flow reads are checked.
    entry.client = client as StoredOAuthClientInformation;
  }

  if (tokens !== undefined && stringField(tokens, "access_token") !== undefined) {
    // SAFETY: as above; an access token is what every use of the tokens needs.
    entry.tokens = tokens as StoredOAuthTokens;
  }

  if (obtainedAt !== undefined) entry.obtainedAt = obtainedAt;

  if (discovery !== undefined && authorizationServerUrl !== undefined) {
    // SAFETY: as above; discovery needs the authorization server's URL, which is checked.
    entry.discovery = { ...discovery, authorizationServerUrl } as OAuthDiscoveryState;
  }

  return entry;
};

/** The whole file: its endpoints' entries by URL. A file that is not this module's is a {@link Refusal}, never overwritten. */
const parseFile = (path: string, text: string): Map<string, JsonObject> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal(
      `${path} is not valid JSON: fix or delete it (it holds your cloudpid sign-ins).`,
    );
  }

  const root = isJson(parsed) ? toObject(parsed) : undefined;
  const endpoints = root === undefined ? undefined : objectField(root, "endpoints");

  if (endpoints === undefined) {
    throw new Refusal(`${path} is not a cloudpid sign-in file: fix or delete it.`);
  }

  const entries = new Map<string, JsonObject>();

  for (const [endpoint, value] of Object.entries(endpoints)) {
    const entry = toObject(value);

    if (entry !== undefined) entries.set(endpoint, entry);
  }

  return entries;
};

/** `<agentDir>/cloudpid-auth.json`. */
export const fileAuthStore = (agentDir: string): AuthStore => {
  const path = join(agentDir, AUTH_FILE);
  /** Writes and removals run one after the other in this process. */
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Map<string, JsonObject>> => {
    let text: string;

    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();

      throw error;
    }

    return parseFile(path, text);
  };

  const save = async (entries: ReadonlyMap<string, JsonObject>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });

    const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, endpoints: Object.fromEntries(entries) }, null, 2)}\n`;

    try {
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });

      throw error;
    }
  };

  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const next = queue.then(work, work);

    queue = next.catch(() => undefined);

    return next;
  };

  return {
    read: async (endpoint) => {
      const entry = (await load()).get(endpoint);

      return entry === undefined ? undefined : entryOf(entry);
    },
    write: (endpoint, entry) =>
      serial(async () => {
        const entries = await load();
        // JSON round trip: what is written is what a read gives back (`undefined` members are dropped).
        const copy: unknown = JSON.parse(JSON.stringify(entry));
        const written = isJson(copy) ? toObject(copy) : undefined;

        if (written === undefined) throw new Refusal("the sign-in could not be stored.");

        entries.set(endpoint, written);

        await save(entries);
      }),
    remove: (endpoint) =>
      serial(async () => {
        const entries = await load();

        if (!entries.delete(endpoint)) return false;

        await save(entries);

        return true;
      }),
  };
};
