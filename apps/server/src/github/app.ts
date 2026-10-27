// cloudpid's GitHub App (ADR-0025, GLOSSARY.md → GitHub App): GitHub tokens minted on demand from the app's private
// key, one per installation (an account the app is installed on). A Worker or a Workspace DO holds one `GitHubApp`,
// which keeps the installations it found and the tokens it minted.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off -- WebCrypto and `fetch` are Promise APIs, over native arrays.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const API = "https://api.github.com";

/** How far the JWT's `iat` is backdated, for the clock drift GitHub's docs allow for. */
const JWT_BACKDATE_SECONDS = 60;

/** How long the JWT lives after its `iat`; GitHub refuses one that lives past ten minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60 + JWT_BACKDATE_SECONDS;

/**
 * A token is minted again once less than this is left of it, so whatever gets one (a command on the Container keeps
 * it for as long as it runs) has at least this long. GitHub's tokens live an hour.
 */
export const TOKEN_MIN_LIFETIME_MS = 45 * 60_000;

/** After a failed mint, how long before GitHub is asked again; each further failure doubles it. */
const RETRY_AFTER_MS = 60_000;

/** The longest wait between attempts. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;

/** How long the list of the app's installations is kept: an account the app is installed on later is found after it. */
const INSTALLATIONS_TTL_MS = 5 * 60_000;

/** A minted token, the account (lower case) of the installation it is for, and when it expires (ms). */
export type MintedToken = {
  readonly account: string;
  readonly token: string;
  readonly expiresAt: number;
};

/** A token for each of the app's installations, for a command that may reach any of them. */
export type InstallationTokens = {
  /** Each installation's token, by its account's login in lower case. */
  readonly byAccount: Readonly<Record<string, string>>;
  /** The account that owns the app, in lower case: whose token a command outside any repo gets. */
  readonly appAccount: string | undefined;
  /** Why an installation, or the app's own account, has no token: a sentence each. */
  readonly problems: ReadonlyArray<string>;
};

/** `cause` as a sentence. */
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Where GitHub tokens come from, for what hands them out and takes them out of output. */
export type GitHubTokens = {
  /**
   * A token for the installation on `account` (by default the account that owns the app) with at least
   * `TOKEN_MIN_LIFETIME_MS` left. Throws, saying why, when none can be had.
   */
  readonly token: (account?: string) => Promise<string>;
  /** A token for every installation, and why any could not be had. Never throws. */
  readonly tokens: () => Promise<InstallationTokens>;
  /** Every token handed out that has not expired. */
  readonly live: () => ReadonlyArray<string>;
  /** Tell it GitHub refused `token` (a 401), so the next `token()` does not hand it out again. */
  readonly invalidate: (token: string) => void;
};

/** What a `GitHubApp` is made with. */
export type GitHubAppOptions = {
  /** The app's ID (or its Client ID), the JWT's issuer. */
  readonly appId: string;
  /** The app's private key, as GitHub hands it out (PKCS#1 PEM) or as PKCS#8 PEM. */
  readonly privateKey: string;
  /** GitHub's API; a test replaces it. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The time in ms. */
  readonly now: () => number;
  /** The permissions its tokens ask for (a subset of the app's); absent, all of the installation's. */
  readonly permissions?: Readonly<Record<string, "read" | "write">> | undefined;
  /**
   * Where the tokens minted are kept until they expire, so an object made again (a Workspace DO after its eviction,
   * while its Container runs on) still hands out the latest one and still takes them all out of output. Absent, in
   * memory only.
   */
  readonly kept?:
    | {
        readonly load: () => ReadonlyArray<MintedToken> | undefined;
        readonly save: (minted: ReadonlyArray<MintedToken>) => void;
      }
    | undefined;
};

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A DER length: short form under 128, else the count of big-endian length bytes, then them. */
const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];

  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);

  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, content: ReadonlyArray<number> | Uint8Array): number[] => [
  tag,
  ...derLength(content.length),
  ...content,
];

/** `AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }`. */
const RSA_ENCRYPTION = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** A PKCS#1 `RSAPrivateKey` as the PKCS#8 `PrivateKeyInfo` WebCrypto imports: version 0, the algorithm, the key. */
const pkcs8OfPkcs1 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(der(0x30, [0x02, 0x01, 0x00, ...RSA_ENCRYPTION, ...der(0x04, pkcs1)]));

/** A PEM as written, with the line breaks of one pasted into a one-line variable (`\n`) put back. */
const pemText = (pem: string): string => pem.replaceAll("\\n", "\n").trim();

/** The DER of a PEM private key as PKCS#8, whichever of the two forms it is in. */
const pkcs8Of = (pem: string): Uint8Array<ArrayBuffer> => {
  const text = pemText(pem);

  const match = /^-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----$/.exec(
    text,
  );

  if (match === null) {
    throw new Error(
      "CLOUDPID_GITHUB_APP_PRIVATE_KEY is not a PEM private key (-----BEGIN RSA PRIVATE KEY-----)",
    );
  }

  const body = Uint8Array.from(atob((match[2] ?? "").replaceAll(/\s/g, "")), (char) =>
    char.charCodeAt(0),
  );

  return match[1] === undefined ? body : pkcs8OfPkcs1(body);
};

const importKey = async (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    pkcs8Of(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

/**
 * What is wrong with `pem` as the GitHub App's private key, if anything: checked when a Worker starts or is deployed, so
 * a bad paste fails then rather than at the first mint. GitHub is not asked.
 */
export const githubAppKeyProblem = async (pem: string): Promise<string | undefined> => {
  try {
    pkcs8Of(pem);
  } catch (cause) {
    return messageOf(cause);
  }

  try {
    await importKey(pem);

    return undefined;
  } catch (cause) {
    return `CLOUDPID_GITHUB_APP_PRIVATE_KEY is not the GitHub App's RSA private key: ${messageOf(cause)}`;
  }
};

/**
 * The forms of the GitHub App's private key no plain value may hold: the PEM as written, and its body on one line (a
 * key pasted without its header and line breaks).
 */
export const githubAppKeyForms = (pem: string): ReadonlyArray<string> => {
  const text = pemText(pem);
  const body = text.replaceAll(/-----[A-Z ]+-----|\s/g, "");

  return body === "" ? [text] : [text, body];
};

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

const Account = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const Installations = Schema.Array(Schema.Struct({ id: Schema.Int, account: Account }));

const AppAnswer = Schema.Struct({ owner: Account });

const MintAnswer = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

const ErrorAnswer = Schema.Struct({ message: Schema.String });

const decodeInstallations = Schema.decodeUnknownOption(Installations);
const decodeAppAnswer = Schema.decodeUnknownOption(AppAnswer);
const decodeMintAnswer = Schema.decodeUnknownOption(MintAnswer);
const decodeErrorAnswer = Schema.decodeUnknownOption(ErrorAnswer);

/** GitHub's answer to the app: its JSON, or the status it refused with and why. */
type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** What a refusal is told as. */
const refusal = (status: number, said: string): Error => {
  const why = said === "" ? `${status}` : `${status}: ${said}`;

  return new Error(
    status === 401
      ? `GitHub refused the GitHub App (${why}): check CLOUDPID_GITHUB_APP_ID and CLOUDPID_GITHUB_APP_PRIVATE_KEY`
      : `GitHub refused the GitHub App's request (${why})`,
  );
};

/** A failure told again without asking GitHub until `until`, and how many there were in a row. */
type Failure = { readonly error: Error; readonly until: number; readonly count: number };

/**
 * The app's GitHub tokens for one Worker or Workspace DO: it finds the app's installations, mints a token for one when
 * its last has less than `TOKEN_MIN_LIFETIME_MS` left, and lists the ones that have not expired.
 */
export class GitHubApp implements GitHubTokens {
  readonly #options: GitHubAppOptions;
  #key: Promise<CryptoKey> | undefined;
  /** The app's installations by account (lower case), and when they were listed. */
  #installations: { readonly at: number; readonly ids: ReadonlyMap<string, number> } | undefined;
  /** The account that owns the app, in lower case. */
  #appAccount: string | undefined;
  /** Every token minted, oldest first, until it expires. */
  #minted: MintedToken[];
  /** The tokens GitHub refused (`invalidate`), which are not handed out again. */
  readonly #refused = new Set<string>();
  /** The asks under way (a mint, the list, the app), by what they are for: every caller meanwhile waits for one. */
  readonly #asking = new Map<string, Promise<unknown>>();
  /** The last failure of each ask, told again without asking GitHub until it is due. */
  readonly #failed = new Map<string, Failure>();

  constructor(options: GitHubAppOptions) {
    this.#options = options;
    this.#minted = [...(options.kept?.load() ?? [])];
  }

  /**
   * A token for the installation on `account` (by default the account that owns the app) with at least
   * `TOKEN_MIN_LIFETIME_MS` left: the last one minted, or a new one. When no new one can be minted, the last one while
   * it has not expired; else throws, saying why.
   */
  async token(account?: string): Promise<string> {
    const name = account === undefined ? await this.#ownAccount() : account.toLowerCase();
    const latest = this.#minted.findLast((minted) => minted.account === name);
    const usable = latest !== undefined && !this.#refused.has(latest.token) ? latest : undefined;

    if (usable !== undefined && usable.expiresAt - this.#options.now() >= TOKEN_MIN_LIFETIME_MS) {
      return usable.token;
    }

    try {
      return (await this.#once(`token:${name}`, () => this.#mint(name))).token;
    } catch (cause) {
      if (usable !== undefined && usable.expiresAt > this.#options.now()) return usable.token;

      throw cause;
    }
  }

  /** A token for every installation (each as `token` gives it), and why any could not be had. Never throws. */
  async tokens(): Promise<InstallationTokens> {
    const problems: string[] = [];

    const appAccount = await this.#ownAccount().catch((cause: unknown) => {
      problems.push(messageOf(cause));

      return undefined;
    });

    const listed = await this.#installationIds().catch((cause: unknown) => {
      problems.push(messageOf(cause));

      return undefined;
    });

    // Without the list, the accounts it had tokens for still get theirs.
    const accounts =
      listed === undefined ? new Set(this.#minted.map(({ account }) => account)) : listed.keys();

    const byAccount: Record<string, string> = {};

    await Promise.all(
      Array.from(accounts, async (account) => {
        try {
          byAccount[account] = await this.token(account);
        } catch (cause) {
          problems.push(`${account}: ${messageOf(cause)}`);
        }
      }),
    );

    return { byAccount, appAccount, problems };
  }

  /**
   * Tell it GitHub refused `token` (a 401): the next `token()` for its account mints another, unless one was minted
   * since. It is still listed by `live()` until it expires.
   */
  invalidate(token: string): void {
    const refused = this.#minted.find((minted) => minted.token === token);

    if (refused === undefined) return;

    if (this.#minted.findLast(({ account }) => account === refused.account)?.token === token) {
      this.#refused.add(token);
    }
  }

  /** The tokens minted that have not expired, oldest first: what output and snapshots must not hold. */
  live(): ReadonlyArray<string> {
    const now = this.#options.now();
    const live = this.#minted.filter(({ expiresAt }) => expiresAt > now);

    if (live.length !== this.#minted.length) {
      this.#minted = live;
      this.#options.kept?.save(live);
    }

    return live.map(({ token }) => token);
  }

  /**
   * `attempt`, once for all callers at a time under `key`; after it fails, its failure is told again without trying
   * until a wait that doubles with each failure in a row is over.
   */
  async #once<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    const failed = this.#failed.get(key);

    if (failed !== undefined && this.#options.now() < failed.until) throw failed.error;

    const running =
      this.#asking.get(key) ??
      attempt()
        .then(
          (value) => {
            this.#failed.delete(key);

            return value;
          },
          (cause: unknown) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            const count = (this.#failed.get(key)?.count ?? 0) + 1;
            const wait = Math.min(RETRY_AFTER_MS * 2 ** (count - 1), MAX_RETRY_AFTER_MS);

            this.#failed.set(key, { error, until: this.#options.now() + wait, count });

            throw error;
          },
        )
        .finally(() => {
          this.#asking.delete(key);
        });

    this.#asking.set(key, running);

    // SAFETY: what runs under `key` is only ever `attempt` of the same type: each key names one kind of ask.
    return (await running) as T;
  }

  async #mint(account: string): Promise<MintedToken> {
    const installation = (await this.#installationIds()).get(account);

    if (installation === undefined) {
      throw new Error(
        `The GitHub App is not installed on ${account}: install it there, on all repositories`,
      );
    }

    const answer = await this.#ask(`${API}/app/installations/${installation}/access_tokens`, {
      method: "POST",
      body:
        this.#options.permissions === undefined
          ? undefined
          : JSON.stringify({ permissions: this.#options.permissions }),
    });

    if (!answer.ok) {
      // Uninstalled, or installed again under another id: the list is asked for again at the next attempt.
      if (answer.status === 404) this.#installations = undefined;

      throw refusal(answer.status, answer.message);
    }

    const decoded = decodeMintAnswer(answer.value);
    const expiresAt = Option.isSome(decoded) ? Date.parse(decoded.value.expires_at) : Number.NaN;

    if (Option.isNone(decoded) || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub's answer to the GitHub App was not a token");
    }

    const minted = { account, token: decoded.value.token, expiresAt };
    const now = this.#options.now();

    this.#minted = [...this.#minted.filter((kept) => kept.expiresAt > now), minted];
    this.#options.kept?.save(this.#minted);

    return minted;
  }

  /**
   * The app's installations by account, listed again once `INSTALLATIONS_TTL_MS` old; the last list while a new one
   * cannot be had. Its first page only: a hundred accounts.
   */
  async #installationIds(): Promise<ReadonlyMap<string, number>> {
    const held = this.#installations;

    if (held !== undefined && this.#options.now() - held.at < INSTALLATIONS_TTL_MS) return held.ids;

    try {
      return await this.#once("installations", async () => {
        const answer = await this.#ask(`${API}/app/installations?per_page=100`, { method: "GET" });

        if (!answer.ok) throw refusal(answer.status, answer.message);

        const decoded = decodeInstallations(answer.value);

        if (Option.isNone(decoded)) {
          throw new Error("GitHub's answer to the GitHub App was not a list of installations");
        }

        const ids = new Map<string, number>();

        for (const { id, account } of decoded.value) {
          if (account !== null) ids.set(account.login.toLowerCase(), id);
        }

        this.#installations = { at: this.#options.now(), ids };

        return ids;
      });
    } catch (cause) {
      if (held !== undefined) return held.ids;

      throw cause;
    }
  }

  /** The account that owns the app, in lower case, asked once. */
  async #ownAccount(): Promise<string> {
    if (this.#appAccount !== undefined) return this.#appAccount;

    return this.#once("app", async () => {
      const answer = await this.#ask(`${API}/app`, { method: "GET" });

      if (!answer.ok) throw refusal(answer.status, answer.message);

      const login = Option.getOrUndefined(decodeAppAnswer(answer.value))?.owner?.login;

      if (login === undefined)
        throw new Error("GitHub's answer to the GitHub App did not name its owner");

      this.#appAccount = login.toLowerCase();

      return this.#appAccount;
    });
  }

  /** `url` asked as the app, with a JWT. Throws when GitHub cannot be reached or its answer is not JSON. */
  async #ask(
    url: string,
    init: { readonly method: "GET" | "POST"; readonly body?: string | undefined },
  ): Promise<Answer> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await this.#jwt()}`,
      "user-agent": "cloudpid",
      "x-github-api-version": "2022-11-28",
    });

    const request: RequestInit = {
      method: init.method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      request.body = init.body;
    }

    let response: Response;

    try {
      response = await this.#options.fetch(url, request);
    } catch (cause) {
      throw new Error(`GitHub could not be reached: ${messageOf(cause)}`);
    }

    if (response.ok) {
      try {
        return { ok: true, value: await response.json() };
      } catch {
        throw new Error("GitHub's answer to the GitHub App was not JSON");
      }
    }

    const said = decodeErrorAnswer(await response.json().catch(() => null));

    return {
      ok: false,
      status: response.status,
      message: Option.isSome(said) ? said.value.message : "",
    };
  }

  async #jwt(): Promise<string> {
    this.#key ??= importKey(this.#options.privateKey);

    const iat = Math.floor(this.#options.now() / 1000) - JWT_BACKDATE_SECONDS;

    const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));

    const payload = base64Url(
      encoder.encode(
        JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: this.#options.appId }),
      ),
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await this.#key,
      encoder.encode(`${header}.${payload}`),
    );

    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }
}
