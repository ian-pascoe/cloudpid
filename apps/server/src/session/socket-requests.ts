// What a socket's limited requests have in common (`docs/architecture/mcp-apps.md` → An App View's calls;
// `docs/architecture/mcp-in-a-session.md` → Resource links and embedded resources): the requests the page makes of the
// Session that reach an MCP server are counted for each requester (a View, a page) over the last minute, kept in flight in
// a registry, and aborted when the socket goes. An App View's calls (`./mcp-app-calls.ts`) and the owner's previews
// (`./mcp-resource-previews.ts`) are two users of it, each with its own limits and its own key.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- the registry of what is in flight is plain mutable state, which the limits are counted in.
const MINUTE_MS = 60_000;

/** What one requester of a socket has counted, and has in flight. */
export type Requester = {
  /**
   * Count an arrival of `kind` and say whether it is let through: fewer than `limit` arrivals of `kind` in the last minute
   * came before it. It is counted whether or not it is let through, so a requester is not let spend what it was refused;
   * only the newest `limit` stamps are kept, so one that is over the limit stays over it for as long as it keeps asking.
   */
  readonly admits: (kind: string, limit: number) => boolean;
  /** How many requests are in flight. */
  readonly inFlight: () => number;
  /** Whether request `id` is in flight. */
  readonly running: (id: string) => boolean;
  /** Put `id` in flight, with no step between the check and this, so concurrent requests cannot pass a limit together. */
  readonly start: (id: string) => AbortController;
  /** `id` is done. */
  readonly finish: (id: string) => void;
  /** Abort request `id` if it is still running. */
  readonly abort: (id: string) => void;
  /** Abort every request in flight. */
  readonly abortAll: () => void;
};

/** The requesters of every socket, each named by a key of the user's own (an App call's id; none for a page). */
export type SocketRequests = {
  /** The requester `key` of `socket`, made at its first ask. */
  readonly of: (socket: WebSocket, key?: string) => Requester;
  /** The requester `key` of `socket` if it has made any: asking for it makes none. */
  readonly find: (socket: WebSocket, key?: string) => Requester | undefined;
  /** The socket went: everything its requesters have in flight is aborted, and what they counted is forgotten. */
  readonly end: (socket: WebSocket) => void;
};

const requesterOf = (now: () => number): Requester => {
  const stamps = new Map<string, Array<number>>();
  const flying = new Map<string, AbortController>();

  return {
    admits: (kind, limit) => {
      const at = now();
      const live = (stamps.get(kind) ?? []).filter((each) => at - each < MINUTE_MS);
      const under = live.length < limit;

      live.push(at);
      stamps.set(kind, live.slice(-limit));

      return under;
    },
    inFlight: () => flying.size,
    running: (id) => flying.has(id),
    start: (id) => {
      const stop = new AbortController();

      flying.set(id, stop);

      return stop;
    },
    finish: (id) => {
      flying.delete(id);
    },
    abort: (id) => {
      flying.get(id)?.abort();
    },
    abortAll: () => {
      for (const stop of flying.values()) stop.abort();
    },
  };
};

/** The registry of every socket's requesters, counting the minute by `now`. */
export const socketRequests = (now: () => number): SocketRequests => {
  const sockets = new WeakMap<WebSocket, Map<string, Requester>>();

  return {
    of: (socket, key = "") => {
      let keyed = sockets.get(socket);

      if (keyed === undefined) {
        keyed = new Map();
        sockets.set(socket, keyed);
      }

      let requester = keyed.get(key);

      if (requester === undefined) {
        requester = requesterOf(now);
        keyed.set(key, requester);
      }

      return requester;
    },
    find: (socket, key = "") => sockets.get(socket)?.get(key),
    end: (socket) => {
      // Each request is aborted where it is: its own `finish` removes it from what is in flight.
      for (const each of sockets.get(socket)?.values() ?? []) each.abortAll();

      sockets.delete(socket);
    },
  };
};
