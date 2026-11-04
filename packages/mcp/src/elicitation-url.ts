// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over values, with checks that end early.
// The page a URL-mode elicitation asks the owner to open, and which pages cloudpid declines without showing
// (`docs/architecture/mcp-server-requests.md` → Elicitation requests → URL mode; #388 D9.1, D9.2). Pure and SDK-free, so
// the Session and its tests import it from `@cloudpid/mcp/elicitation-url`, not `./types`: it carries the Public Suffix List
// (`tldts`), which the web, importing `./types`, never runs.
//
// - **Declined unseen:** a scheme other than `https:`, userinfo, `localhost`, `*.localhost`, `*.local`, `*.internal`, a
//   loopback, private, link-local, CGNAT or ULA IP literal, and cloudpid's own hosts (given as a predicate, since they
//   are a deployment's). The server is told `decline`, and the owner and the agent are told why.
// - **Malformed:** an address that is not one, or over `ELICITATION_URL_MAX` characters.
// - **What the card shows:** the address as the browser opens it, its host in ASCII (punycode), the registrable domain to
//   emphasize and a warning for an internationalized host or one that mixes scripts.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { getDomain } from "tldts";
import { decodePunycode } from "./punycode.ts";

/** The longest address a URL-mode question may carry: past it the question is malformed. */
export const ELICITATION_URL_MAX = 8192;

/** A page the owner may be shown: the address, its host and the part of it to emphasize. */
export type ElicitationPage = {
  /** The address as the browser will open it (the URL parser's own form). */
  readonly url: string;
  /** The host in ASCII: an internationalized one in punycode. */
  readonly host: string;
  /** The registrable domain, a suffix of `host` (from the Public Suffix List, private section included). */
  readonly domain: string;
  /** The host is internationalized (`idn`) or mixes scripts in a label (`mixed_script`). */
  readonly warning?: "idn" | "mixed_script";
};

/** Why a page is not shown: cloudpid declines it (`decline`, with a reason) or it is malformed (`-32602`). */
export type ElicitationPageProblem = {
  readonly kind: "declined" | "malformed";
  readonly reason: string;
};

const declined = (reason: string) =>
  Result.fail({ kind: "declined", reason } satisfies ElicitationPageProblem);

const malformed = (reason: string) =>
  Result.fail({ kind: "malformed", reason } satisfies ElicitationPageProblem);

/** The four bytes of an IPv4 literal in dotted decimal, which the URL parser normalizes every IPv4 host to. */
const ipv4Of = (host: string): ReadonlyArray<number> | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  return match === null ? undefined : Arr.map(match.slice(1, 5), Number);
};

/** Whether an IPv4 address is loopback, private, link-local, CGNAT or "this network". */
const privateV4 = (bytes: ReadonlyArray<number>): boolean => {
  const [a = 0, b = 0] = bytes;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

/**
 * The eight 16-bit groups of an IPv6 host as the URL parser writes it (lowercase, `::` compressed, no dotted tail,
 * brackets on), or undefined when it is not one.
 */
const ipv6Of = (host: string): ReadonlyArray<number> | undefined => {
  if (!host.startsWith("[") || !host.endsWith("]")) return undefined;

  const inner = host.slice(1, -1);
  const parts = inner.split("::");

  if (parts.length > 2) return undefined;

  const groups = (text: string) => (text === "" ? [] : text.split(":"));
  const head = groups(parts[0] ?? "");
  const tail = parts.length === 2 ? groups(parts[1] ?? "") : [];
  const fill = 8 - head.length - tail.length;

  if (fill < 0 || (parts.length === 1 && fill !== 0) || (parts.length === 2 && fill < 1)) {
    return undefined;
  }

  const all = [...head, ...Arr.makeBy(parts.length === 2 ? fill : 0, () => "0"), ...tail];

  const numbers = Arr.map(all, (group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );

  return numbers.length === 8 && numbers.every((group) => !Number.isNaN(group))
    ? numbers
    : undefined;
};

/** Whether an IPv6 address is unspecified, loopback, link-local, ULA, or wraps a private IPv4 address. */
const privateV6 = (groups: ReadonlyArray<number>): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeros = (upTo: number) => groups.slice(0, upTo).every((group) => group === 0);
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  return (
    // `::` and `::1`
    (zeros(7) && g7 <= 1) ||
    // fe80::/10, link-local
    (g0 & 0xffc0) === 0xfe80 ||
    // fc00::/7, unique local
    (g0 & 0xfe00) === 0xfc00 ||
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address they carry
    (((zeros(5) && g5 === 0xffff) || zeros(6)) && privateV4(embedded)) ||
    // 64:ff9b::a.b.c.d (NAT64)
    (g0 === 0x64 &&
      g1 === 0xff9b &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      privateV4(embedded))
  );
};

/** Whether `host`, lowercase with no trailing dot, is a name that is local by its suffix. */
const localName = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".local") ||
  host.endsWith(".internal");

/** The scripts a label's letters are told apart by; any other letter counts for none. */
const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Han}/u,
  /\p{Script=Hiragana}/u,
  /\p{Script=Katakana}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
] as const;

/** Whether one label of a host holds letters of more than one script (look-alikes of another's letters). */
const mixesScripts = (host: string): boolean =>
  Arr.some(host.split("."), (label) => {
    const text = label.startsWith("xn--") ? (decodePunycode(label.slice(4)) ?? label) : label;

    return Arr.filter(SCRIPTS, (script) => script.test(text)).length > 1;
  });

/**
 * The registrable domain of `host`: the name its owner registered, so that what the card emphasizes names the page's
 * owner. It reads the Public Suffix List with its private section, so `attacker.github.io` is `attacker.github.io`, not
 * `github.io`, and `auth.example.co.uk` is `example.co.uk`. A host that is itself a suffix, an IP literal and a name the
 * list does not cover are their own.
 */
export const registrableDomain = (host: string): string =>
  getDomain(host, { allowPrivateDomains: true }) ?? host;

/**
 * The page `text` names, or why it is not shown. `isOwnHost` says whether a host (lowercase, ASCII) is one of cloudpid's
 * own, which a server must not send the owner to (a route like `/oauth/mcp/start`).
 */
export const checkElicitationUrl = (
  text: string,
  isOwnHost: (host: string) => boolean,
): Result.Result<ElicitationPage, ElicitationPageProblem> => {
  if (text.length > ELICITATION_URL_MAX) {
    return malformed(`the address is over ${ELICITATION_URL_MAX} characters`);
  }

  const parsed = Option.liftThrowable(() => new URL(text))();

  if (Option.isNone(parsed)) return malformed("the address is not a valid URL");

  const url = parsed.value;

  if (url.protocol !== "https:") return declined("the page isn't served over HTTPS");

  if (url.username !== "" || url.password !== "") {
    return declined("the address has a username or password in it");
  }

  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const v4 = ipv4Of(host);
  const v6 = ipv6Of(host);

  if (
    localName(host) ||
    (v4 !== undefined && privateV4(v4)) ||
    (v6 !== undefined && privateV6(v6)) ||
    (host.startsWith("[") && v6 === undefined)
  ) {
    return declined("the page is on a local or private address");
  }

  if (isOwnHost(host)) return declined("the page is on one of cloudpid's own hosts");

  const base = { url: url.href, host, domain: registrableDomain(host) } satisfies ElicitationPage;

  if (mixesScripts(host)) return Result.succeed({ ...base, warning: "mixed_script" });

  return Result.succeed(
    Arr.some(host.split("."), (label) => label.startsWith("xn--"))
      ? { ...base, warning: "idn" }
      : base,
  );
};
