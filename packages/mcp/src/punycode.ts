// Punycode (RFC 3492) decoding, for the one place that needs a host's Unicode form: the mixed-script warning of a page
// the owner is asked to open (`elicitation-url.ts`). Only decoding: the URL parser already makes the ASCII form.
import * as Arr from "effect/Array";

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
export const decodePunycode = (label: string): string | undefined => {
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
