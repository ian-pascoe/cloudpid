// The Session object's synchronous key-value storage, as the stores kept in it use it (the MCP Apps' records, the Resource
// watches' list): the part of a Durable Object's `ctx.storage.kv` they read and write, so a test hands them a map.

export type SessionKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};
