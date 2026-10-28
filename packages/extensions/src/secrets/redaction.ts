// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// Redaction of Secret values (`docs/architecture/agent-capabilities.md` → Secrets), ported from pi-utils' `secret-registry.ts` (see
// ../../NOTICE.md). Every value held in this Session instance is replaced by its Secret Reference wherever it occurs,
// written as is or in a common encoding: JSON string escaping, percent-encoding, hex, and base64 and base64url at any
// alignment. Values are only ever added, so a Redaction Generation (how many were held) always names the same values,
// and text redacted at one generation is redacted the same way later. `stream()` redacts output that arrives in
// chunks, holding back only the tail that could still be the start of a value.
import * as Predicate from "effect/Predicate";
import { secretReference } from "./references.ts";

/**
 * Values shorter than this are redacted only as written: their encoded forms are short enough to occur by chance in
 * unrelated output, such as a hash or another base64 blob.
 */
export const MIN_ENCODED_REDACTION_LENGTH = 8;

const encoder = new TextEncoder();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The base64 characters that encode `bytes` whatever bytes surround them, for each of the three alignments `bytes` can
 * start at inside a longer encoded payload, such as `user:password` in an HTTP Basic `Authorization` header. The
 * characters that mix in neighbouring bytes are left out.
 */
const base64Cores = (bytes: Uint8Array): string[] =>
  [0, 1, 2].map((offset) => {
    const padded = new Uint8Array(offset + bytes.length);

    padded.set(bytes, offset);

    const encoded = toBase64(padded);

    return encoded.slice(
      Math.ceil((offset * 8) / 6),
      Math.floor(((offset + bytes.length) * 8) / 6),
    );
  });

/** The common encodings a program prints `value` in; none for a value shorter than the minimum. */
const encodedForms = (value: string): string[] => {
  if (value.length < MIN_ENCODED_REDACTION_LENGTH) return [];

  const bytes = encoder.encode(value);
  const hex = toHex(bytes);
  const base64 = base64Cores(bytes);

  const forms = [
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    hex,
    hex.toUpperCase(),
    ...base64,
    ...base64.map((core) => core.replaceAll("+", "-").replaceAll("/", "_")),
  ];

  return forms.filter((form) => form !== value && form.length >= MIN_ENCODED_REDACTION_LENGTH);
};

type Pattern = {
  readonly regex: RegExp;
  /** The held value each matchable text stands for, whether written as is or encoded. */
  readonly sources: ReadonlyMap<string, string>;
  /** The longest matchable text: how much of a stream's tail could still be the start of one. */
  readonly longest: number;
};

/** A stream of text redacted as it arrives. */
export type RedactionStream = {
  /** Take the next chunk; returns the redacted text that is now settled, which may be less than was pushed. */
  readonly push: (chunk: string) => string;
  /** The end of the stream: the redacted text still held back. */
  readonly flush: () => string;
};

/** Every value held in this Session instance, in the order held, with the Secret Name it was last held under. */
export class Redactions {
  /** Value → Secret Name; insertion order is the order of generations. */
  readonly #names = new Map<string, string>();
  readonly #patterns = new Map<number, Pattern>();

  /** How many values have been held: it only grows. */
  get generation(): number {
    return this.#names.size;
  }

  /** Redact `value` from now on, as `name`'s Secret Reference. */
  hold(name: string, value: string): void {
    if (value === "") return;

    this.#names.set(value, name);
  }

  /**
   * `value` with every held value, as written or encoded, replaced by its Secret Reference in strings nested in plain
   * objects and arrays. With `generation`, only the values held by then. Returns `value` itself when nothing was
   * redacted, and never modifies it.
   */
  redact<A>(value: A, generation?: number): A {
    const pattern = this.#pattern(Math.min(generation ?? this.generation, this.generation));

    return pattern === undefined ? value : this.#redactValue(value, pattern);
  }

  /** A stream redacted with the values held at each push. */
  stream(): RedactionStream {
    let pending = "";

    return {
      push: (chunk) => {
        pending += chunk;

        const pattern = this.#pattern(this.generation);

        if (pattern === undefined) {
          const settled = pending;

          pending = "";

          return settled;
        }

        // Text before `cut` cannot be the start of a match that later text completes.
        let cut = pending.length - (pattern.longest - 1);
        let settled = "";
        let last = 0;

        for (const match of pending.matchAll(pattern.regex)) {
          if (match.index >= cut) break;

          const end = match.index + match[0].length;

          // A match that reaches the held-back tail could still grow into a longer one.
          if (end > cut) {
            cut = match.index;
            break;
          }

          settled += pending.slice(last, match.index) + this.#reference(pattern, match[0]);
          last = end;
        }

        if (cut <= last) {
          pending = pending.slice(last);

          return settled;
        }

        // Never split a surrogate pair.
        if (isHighSurrogate(pending.charCodeAt(cut - 1))) cut -= 1;

        settled += pending.slice(last, cut);
        pending = pending.slice(cut);

        return settled;
      },
      flush: () => {
        const rest = this.redact(pending);

        pending = "";

        return rest;
      },
    };
  }

  #pattern(generation: number): Pattern | undefined {
    if (generation === 0) return undefined;

    const cached = this.#patterns.get(generation);

    if (cached !== undefined) return cached;

    const included = [...this.#names.keys()].slice(0, generation);
    const sources = new Map<string, string>();

    for (const value of included) {
      for (const form of encodedForms(value)) if (!sources.has(form)) sources.set(form, value);
    }

    // A value as written wins over another value's encoded form that happens to equal it.
    for (const value of included) sources.set(value, value);

    const alternatives = [...sources.keys()].toSorted((a, b) => b.length - a.length);

    const pattern: Pattern = {
      regex: new RegExp(alternatives.map(escapeRegExp).join("|"), "g"),
      sources,
      longest: alternatives[0]?.length ?? 1,
    };

    this.#patterns.set(generation, pattern);

    return pattern;
  }

  /** The Secret Reference for matched text, named by the value's latest name, looked up now. */
  #reference(pattern: Pattern, match: string): string {
    return secretReference(this.#names.get(pattern.sources.get(match) ?? "") ?? "");
  }

  #redactValue<A>(value: A, pattern: Pattern): A {
    if (Predicate.isString(value)) {
      // One pass, so a Secret Reference inserted for one value is never matched by another.
      const text = value.replace(pattern.regex, (match) => this.#reference(pattern, match));

      // SAFETY: `A` is `string` in this branch, and a string is returned.
      return (text === value ? value : text) as A;
    }

    if (Array.isArray(value)) {
      let changed = false;

      const items = value.map((item) => {
        const next = this.#redactValue(item, pattern);

        if (next !== item) changed = true;

        return next;
      });

      // SAFETY: an array of the same items, each redacted to its own type.
      return (changed ? items : value) as A;
    }

    if (!Predicate.isObject(value)) return value;

    // Class instances (buffers, dates, errors) are left alone: tool data is JSON-like.
    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) return value;

    let changed = false;

    const entries = Object.entries(value).map(([key, item]) => {
      const next = this.#redactValue(item, pattern);

      if (next !== item) changed = true;

      return [key, next] as const;
    });

    // SAFETY: an object with the same keys, each value redacted to its own type.
    return (changed ? Object.fromEntries(entries) : value) as A;
  }
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
