// What the host has seen a server use that the MCP spec deprecated (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, Deprecation): per connection key `conn`, the names of the features (`sampling`), noted at the first use and
// shown on the server's status as `deprecated`. These notes are in memory only: they live as long as the host object, are
// never written to its SQLite store, and are told again by the next use after the object restarts; a `warning` log goes out
// only at each first note, so it is once per server per host lifetime.
export type DeprecationNotes = {
  /** Note that the server of `conn` used `feature`; true the first time, for the caller's one-time log. */
  readonly noteDeprecated: (conn: string, feature: string) => boolean;
  /** The features the server of `conn` used, in the order they were first seen. */
  readonly deprecated: (conn: string) => ReadonlyArray<string>;
};

export const deprecationNotes = (): DeprecationNotes => {
  const seen = new Map<string, Array<string>>();

  return {
    noteDeprecated: (conn, feature) => {
      const features = seen.get(conn) ?? [];

      if (features.includes(feature)) return false;

      seen.set(conn, [...features, feature]);

      return true;
    },
    deprecated: (conn) => seen.get(conn) ?? [],
  };
};
