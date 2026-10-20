// The SSRF guard's address and host rules. Pure: no I/O, so every encoding of a target is tested without a network.
// `web_fetch` runs them on the URL it was given and again on every redirect hop (see `guarded-fetch.ts`), and `dns.ts`
// runs the address rule on what a host resolves to.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** An IPv4 range: its first address as a number, and its prefix length. */
type Range4 = { readonly base: number; readonly bits: number; readonly reason: string };

const range4 = (
  a: number,
  b: number,
  c: number,
  d: number,
  bits: number,
  reason: string,
): Range4 => ({
  base: a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d,
  bits,
  reason,
});

/** Every IPv4 range `web_fetch` refuses: nothing here is reachable on the public internet. */
const BLOCKED_V4: readonly Range4[] = [
  range4(0, 0, 0, 0, 8, "unspecified address"),
  range4(10, 0, 0, 0, 8, "private address"),
  range4(100, 64, 0, 0, 10, "shared address space (carrier-grade NAT)"),
  range4(100, 100, 100, 200, 32, "cloud metadata address"),
  range4(127, 0, 0, 0, 8, "loopback address"),
  range4(169, 254, 169, 254, 32, "cloud metadata address"),
  range4(169, 254, 0, 0, 16, "link-local address"),
  range4(172, 16, 0, 0, 12, "private address"),
  range4(192, 0, 0, 0, 24, "reserved address"),
  range4(192, 0, 2, 0, 24, "documentation address"),
  range4(192, 168, 0, 0, 16, "private address"),
  range4(198, 18, 0, 0, 15, "benchmarking address"),
  range4(198, 51, 100, 0, 24, "documentation address"),
  range4(203, 0, 113, 0, 24, "documentation address"),
  range4(224, 0, 0, 0, 4, "multicast address"),
  range4(240, 0, 0, 0, 4, "reserved address"),
];

const v4Reason = (address: number): string | undefined =>
  Arr.findFirst(BLOCKED_V4, ({ base, bits }) => {
    const size = 2 ** (32 - bits);

    return Math.floor(address / size) === Math.floor(base / size);
  }).pipe(
    Option.map(({ reason }) => reason),
    Option.getOrUndefined,
  );

/** A numeric label as inet_aton reads it: hexadecimal (`0x`), octal (leading `0`), or decimal. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i;

const labelValue = (label: string): number | undefined => {
  if (/^0x[0-9a-f]+$/i.test(label)) return Number.parseInt(label.slice(2), 16);

  if (/^0[0-7]*$/.test(label)) return label === "0" ? 0 : Number.parseInt(label, 8);

  if (/^[1-9][0-9]*$/.test(label)) return Number.parseInt(label, 10);

  return undefined;
};

/** Read `labels` as inet_aton does: one to four numbers, the last filling the remaining bytes. */
const inetAton = (labels: readonly string[]): number | undefined => {
  if (labels.length < 1 || labels.length > 4) return undefined;

  const values = Arr.map(labels, labelValue);
  const last = values.at(-1);

  if (last === undefined || Arr.some(values, (value) => value === undefined)) return undefined;

  const leading = values.slice(0, -1);

  if (Arr.some(leading, (value) => value === undefined || value > 255)) return undefined;

  if (last >= 2 ** (8 * (5 - labels.length))) return undefined;

  return Arr.reduce(
    leading,
    last,
    (sum, value, index) => sum + (value ?? 0) * 2 ** (8 * (3 - index)),
  );
};

/** The 16-bit groups of an IPv6 address, without brackets, or undefined when it is not one. */
const parseV6 = (text: string): readonly number[] | undefined => {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.includes(":::")) return undefined;

  const halves = text.split("::");

  if (halves.length > 2) return undefined;

  const groups = (half: string): number[] | undefined => {
    if (half === "") return [];

    const parts = half.split(":");
    const out: number[] = [];

    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        // An embedded dotted quad is only valid last.
        const quad = part.split(".");
        const bytes = Arr.map(quad, (label) => (/^[0-9]{1,3}$/.test(label) ? Number(label) : 256));

        if (index !== parts.length - 1 || bytes.length !== 4 || Arr.some(bytes, (b) => b > 255)) {
          return undefined;
        }

        out.push((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0), (bytes[2] ?? 0) * 256 + (bytes[3] ?? 0));
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }

    return out;
  };

  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];

  if (head === undefined || tail === undefined) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;

  const missing = 8 - head.length - tail.length;

  // `::` stands for at least one group of zeros.
  if (missing < 1) return undefined;

  return [...head, ...Arr.replicate(0, missing), ...tail];
};

const v4Of = (high: number, low: number): number => high * 65_536 + low;

const v6Reason = (g: readonly number[]): string | undefined => {
  const at = (index: number): number => g[index] ?? 0;

  const zeros = (from: number, to: number): boolean =>
    Arr.every(g.slice(from, to), (group) => group === 0);

  if (zeros(0, 8)) return "unspecified address";

  if (zeros(0, 7) && at(7) === 1) return "loopback address";

  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96), and 6to4 (2002::/16) carry an
  // IPv4 address the host would reach: it must pass the IPv4 rules.
  if (zeros(0, 5) && at(5) === 0xffff) return v4Reason(v4Of(at(6), at(7)));

  // SIIT (::ffff:0:a.b.c.d, ::ffff:0:0/96) translates to the IPv4 address the same way.
  if (zeros(0, 4) && at(4) === 0xffff && at(5) === 0) return v4Reason(v4Of(at(6), at(7)));

  if (zeros(0, 6)) return v4Reason(v4Of(at(6), at(7))) ?? "IPv4-compatible address";

  if (at(0) === 0x64 && at(1) === 0xff9b && zeros(2, 6)) {
    return v4Reason(v4Of(at(6), at(7)));
  }

  if (at(0) === 0x64 && at(1) === 0xff9b) return "local-use NAT64 address";

  if (at(0) === 0x2002) return v4Reason(v4Of(at(1), at(2)));

  if ((at(0) & 0xfe00) === 0xfc00) return "unique-local address";

  if ((at(0) & 0xffc0) === 0xfe80) return "link-local address";

  if ((at(0) & 0xffc0) === 0xfec0) return "site-local address";

  if ((at(0) & 0xff00) === 0xff00) return "multicast address";

  if (at(0) === 0x2001 && at(1) === 0) return "Teredo tunnel address";

  if (at(0) === 0x2001 && at(1) === 0xdb8) return "documentation address";

  if (at(0) === 0x100 && zeros(1, 4)) return "discard-only address";

  return undefined;
};

/**
 * Why `address`, a literal IPv4 or IPv6 address (without brackets), is not one `web_fetch` may reach; undefined when
 * it is public. Used on what a hostname resolves to.
 */
export const blockedAddressReason = (address: string): string | undefined => {
  const v6 = address.includes(":") ? parseV6(address) : undefined;

  if (v6 !== undefined) return v6Reason(v6);

  const v4 = address.includes(".") ? inetAton(address.split(".")) : undefined;

  if (v4 !== undefined) return v4Reason(v4);

  return "not an IP address";
};

/** Names no public DNS answers for, and the suffixes that mean a private network or the platform's metadata. */
const BLOCKED_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "intranet",
  "home.arpa",
] as const;

/**
 * Why `hostname`, as the WHATWG URL parser leaves it in `URL.hostname` (IPv6 in brackets), is not a host
 * `web_fetch` may reach; undefined when it is a public name or address. Numeric hosts are decoded the way a
 * resolver would (decimal, hexadecimal, octal, and short forms), so every encoding of a private address is caught.
 * A name that is not an address still may resolve to one; `dns.ts` checks that.
 */
export const blockedHostReason = (hostname: string): string | undefined => {
  if (hostname === "") return "empty host";

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const groups = parseV6(hostname.slice(1, -1));

    return groups === undefined ? "not a valid IPv6 address" : v6Reason(groups);
  }

  const name = hostname.toLowerCase().replace(/\.+$/, "");
  const labels = name.split(".");
  const last = labels.at(-1) ?? "";

  // Like the URL parser, a host whose last label is a number is an IPv4 address, or invalid.
  if (NUMERIC_LABEL.test(last)) {
    const address = inetAton(labels);

    return address === undefined ? "not a valid IPv4 address" : v4Reason(address);
  }

  if (Arr.some(BLOCKED_SUFFIXES, (suffix) => name === suffix || name.endsWith(`.${suffix}`))) {
    return "private or local hostname";
  }

  // A single label never resolves on the public internet; an internal resolver's search domain would complete it.
  if (labels.length < 2) return "not a public hostname";

  return undefined;
};
