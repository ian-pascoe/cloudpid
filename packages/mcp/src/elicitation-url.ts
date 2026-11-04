// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over values, with checks that end early.
// The page a URL-mode elicitation asks the owner to open, and which pages cloudpid declines without showing
// (`docs/architecture/mcp-server-requests.md` → Elicitation requests → URL mode; #388 D9.1, D9.2). Pure and SDK-free, so
// the Session and its tests import it from `./types`.
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

/** The longest address a URL-mode question may carry: past it the question is malformed. */
export const ELICITATION_URL_MAX = 8192;

/** A page the owner may be shown: the address, its host and the part of it to emphasize. */
export type ElicitationPage = {
  /** The address as the browser will open it (the URL parser's own form). */
  readonly url: string;
  /** The host in ASCII: an internationalized one in punycode. */
  readonly host: string;
  /** The registrable domain, a suffix of `host` (an approximation: no public suffix list). */
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

// ---------------------------------------------------------------------------------------------------------------------
// The host's Unicode form, for the mixed-script warning
// ---------------------------------------------------------------------------------------------------------------------

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

const adapt = (delta: number, points: number, first: boolean) => {
  let scaled = first ? Math.floor(delta / DAMP) : delta >> 1;
  let k = 0;

  scaled += Math.floor(scaled / points);

  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }

  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
};

const digitOf = (char: string) => {
  const code = char.charCodeAt(0);

  if (code >= 48 && code <= 57) return code - 22;

  if (code >= 97 && code <= 122) return code - 97;

  return BASE;
};

/** A punycode label (RFC 3492, without its `xn--`) as the characters it spells, or undefined when it is not valid. */
const decodePunycode = (label: string): string | undefined => {
  const split = label.lastIndexOf("-");

  const output: Array<number> = Arr.map(
    Array.from(split > 0 ? label.slice(0, split) : ""),
    (char) => char.codePointAt(0) ?? 0,
  );

  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  let index = split > 0 ? split + 1 : 0;

  while (index < label.length) {
    const before = i;
    let weight = 1;

    for (let k = BASE; ; k += BASE) {
      if (index >= label.length) return undefined;

      const digit = digitOf(label.charAt(index));

      index += 1;

      if (digit >= BASE) return undefined;

      i += digit * weight;

      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;

      if (digit < threshold) break;

      weight *= BASE - threshold;
    }

    bias = adapt(i - before, output.length + 1, before === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;

    if (n > 0x10ffff) return undefined;

    output.splice(i, 0, n);
    i += 1;
  }

  return String.fromCodePoint(...output);
};

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

/** The second-level labels under a two-letter country code that are registries, as in `example.co.uk`. */
const REGISTRIES = new Set(["ac", "co", "com", "edu", "go", "gov", "ne", "net", "or", "org"]);

/**
 * The registrable domain of `host`: its last two labels, or three under a country code's registry (`co.uk`). An
 * approximation (there is no public suffix list here): it only decides what the card emphasizes, and the full host is
 * always shown beside it. An IP literal is its own.
 */
export const registrableDomain = (host: string): string => {
  if (ipv4Of(host) !== undefined || host.startsWith("[")) return host;

  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const keep = last.length === 2 && REGISTRIES.has(second) && labels.length > 2 ? 3 : 2;

  return labels.slice(-keep).join(".");
};

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
