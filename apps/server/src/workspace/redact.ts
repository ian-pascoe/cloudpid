// Takes a secret out of a command's output (docs/spec.md → Git): `env`, `printenv`, `set -x` or `gh auth status
// --show-token` would otherwise put the GitHub token into the Session's history and send it to the model provider.
// It catches accidents, not exfiltration: a command that encodes the token gets past it.
// @effect-diagnostics preferEffectArray:off

const encoder = new TextEncoder();

/** What a secret is replaced with. */
const MASK = encoder.encode("***");

/** Where `needle` first occurs in `haystack` at or after `from`, or -1. */
const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  for (let at = from; at <= haystack.length - needle.length; at++) {
    let matched = 0;

    while (matched < needle.length && haystack[at + matched] === needle[matched]) matched++;

    if (matched === needle.length) return at;
  }

  return -1;
};

/**
 * Replaces a secret in a byte stream, one chunk at a time. Bytes that could be the start of the secret are held back
 * until the next chunk shows whether they are, so a secret split across chunks is still caught; `flush` releases
 * what is held when the stream ends. Operating on bytes leaves other output, binary included, as it was.
 */
export class Redactor {
  readonly #secret: Uint8Array;
  #held: Uint8Array = new Uint8Array(0);

  constructor(secret: string) {
    this.#secret = encoder.encode(secret);
  }

  push(chunk: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(this.#held.length + chunk.length);

    bytes.set(this.#held);
    bytes.set(chunk, this.#held.length);

    const out: Uint8Array[] = [];
    let start = 0;

    for (
      let at = indexOf(bytes, this.#secret, 0);
      at >= 0;
      at = indexOf(bytes, this.#secret, start)
    ) {
      out.push(bytes.subarray(start, at), MASK);
      start = at + this.#secret.length;
    }

    const rest = bytes.subarray(start);
    const held = this.#partialSecretAtEnd(rest);

    out.push(rest.subarray(0, rest.length - held));
    this.#held = rest.slice(rest.length - held);

    return concat(out);
  }

  flush(): Uint8Array {
    const held = this.#held;

    this.#held = new Uint8Array(0);

    return held;
  }

  /** How many bytes at the end of `bytes` are the start of the secret, the most there can be. */
  #partialSecretAtEnd(bytes: Uint8Array): number {
    for (let length = Math.min(this.#secret.length - 1, bytes.length); length > 0; length--) {
      let matched = 0;

      while (matched < length && bytes[bytes.length - length + matched] === this.#secret[matched])
        matched++;

      if (matched === length) return length;
    }

    return 0;
  }
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};
