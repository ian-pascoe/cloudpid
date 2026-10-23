import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const hex = (bytes: Uint8Array): string =>
  Arr.join(
    Arr.map(Array.from(bytes), (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/**
 * A new Session ID: a UUIDv7 (RFC 9562), so IDs sort by creation time. The first 48 bits are the Unix time in
 * milliseconds, then the version, then random bits. Effect's own `Crypto.randomUUIDv7` is unstable API.
 */
export const newSessionId: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
  Effect.map((now) => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    // Big-endian timestamp in bytes 0..5.
    for (let index = 0; index < 6; index++) {
      bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) % 256;
    }

    bytes[6] = 0x70 | (bytes[6]! & 0x0f);
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);

    const id = hex(bytes);

    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }),
);

/** Eight random lowercase hex digits (`WorkspaceId`), for the store's own draws (`RegistryStore.upkeepSpares`). */
export const shortId = (): string => hex(crypto.getRandomValues(new Uint8Array(4)));

/** A new Workspace or Environment ID: eight random lowercase hex digits (`WorkspaceId`). */
export const newShortId: Effect.Effect<string> = Effect.sync(shortId);

/** A new Workspace ID (`WorkspaceId`). */
export const newWorkspaceId: Effect.Effect<string> = newShortId;

/** A new Environment ID: eight hex digits, which is never `DEFAULT_ENVIRONMENT`. */
export const newEnvironmentId: Effect.Effect<string> = newShortId;
