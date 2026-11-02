// Test helpers for Durable Object SQLite (`docs/development/workers.md` → workerd tests and → Deploys and Durable Object code updates).
// The Web Crypto digest is Promise-based, so the migration checks are too.
// @effect-diagnostics asyncFunction:off
import * as Arr from "effect/Array";
import type { Migration } from "./sqlite.ts";

const refusal = (operation: string) =>
  new Error(
    `Durable Object storage refused ${operation}: this instance was replaced by a code update (refusingStorage)`,
  );

/** What `refusingStorage` returns: the wrapped storage, and the switch that makes it refuse. */
export type RefusingStorage<S extends object> = {
  /** Behaves as the storage it wraps until `trip()`; then every operation on it throws. */
  readonly storage: S;
  /** The code update reached this instance: from now on `storage` refuses every operation, `sql.exec`, `transactionSync`, `get` and `put` included. */
  readonly trip: () => void;
  readonly tripped: () => boolean;
};

/**
 * A replaced instance's storage. After `max_delay` a busy Durable Object's old instance keeps running its calls, but
 * every storage operation fails; the platform tells it nothing else. Wrap the storage an object under test was given
 * (`runInDurableObject`'s `state.storage`), hand `storage` to the code, `trip()` mid-call, and the code sees the
 * failures a replaced instance sees. The real storage underneath is untouched, so a new instance opens it as before.
 * Rejected: `ctx.abort()`, which rejects the calls in flight, the opposite of a replaced instance.
 */
export const refusingStorage = <S extends object>(storage: S): RefusingStorage<S> => {
  let tripped = false;

  const guard = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get: (object, key) => {
        // A proxy trap is dynamic by nature: any member of a platform object, read as the object itself reads it.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see above
        if (typeof key === "symbol") return Reflect.get(object, key, object); // oxlint-disable-line anti-slop/no-reflect-get -- see above

        // Methods and getters run on the real object, not the proxy.
        // oxlint-disable-next-line anti-slop/no-reflect-get -- see above
        const value: unknown = Reflect.get(object, key, object);
        const name = `${path}${String(key)}`;

        // A wrapped storage is a platform object, whose members are told apart at run time: there is no schema to parse.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see above
        if (typeof value === "function") {
          // Refused when called, not when read, so a method captured before the trip refuses too.
          return (...args: ReadonlyArray<unknown>) => {
            if (tripped) throw refusal(name);

            return value.apply(object, args);
          };
        }

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see above
        if (key === "sql" && typeof value === "object" && value !== null) {
          return guard(value, "sql.");
        }

        if (tripped) throw refusal(name);

        return value;
      },
    });

  return {
    storage: guard(storage, ""),
    trip: () => {
      tripped = true;
    },
    tripped: () => tripped,
  };
};

type Statement = { readonly query: string; readonly bindings: ReadonlyArray<unknown> };

/** A `SqlStorage` that records what a migration runs, reads nothing back, and runs nothing. */
const recordInto = (statements: Statement[]): SqlStorage => {
  const empty = {
    toArray: () => [],
    one: () => {
      throw new Error("A migration read a row, which the migration manifest cannot record");
    },
    next: () => ({ done: true, value: undefined }),
    raw: () => ({ toArray: () => [] }),
    columnNames: [],
    rowsRead: 0,
    rowsWritten: 0,
    [Symbol.iterator]: () => [][Symbol.iterator](),
  };

  // SAFETY: a migration only calls `exec`; the recorder has no other member, and its cursor holds no rows.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial fake of a platform type
  return {
    exec: (query: string, ...bindings: ReadonlyArray<unknown>) => {
      statements.push({ query: query.replace(/\s+/g, " ").trim(), bindings });

      return empty;
    },
  } as unknown as SqlStorage;
};

const hex = (bytes: ArrayBuffer): string =>
  Arr.join(
    Arr.map(Array.from(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/**
 * One digest per migration: a hash of the statements (text, whitespace collapsed, and bindings) it runs. A migration
 * is run against a recorder that returns no rows, so one that branches on what it reads is recorded on the empty path;
 * keep migrations to fixed statements, or accept that only that path is guarded. Formatting and comments do not change
 * a digest, a statement does.
 */
export const migrationDigests = async (
  migrations: ReadonlyArray<Migration>,
): Promise<ReadonlyArray<string>> => {
  const digests: string[] = [];

  for (const migration of migrations) {
    const statements: Statement[] = [];

    migration(recordInto(statements));

    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(statements)),
    );

    digests.push(hex(bytes).slice(0, 16));
  }

  return digests;
};

/**
 * What is wrong with `migrations` against `shipped`, the committed digests of the ones on `main` (prod deploys on
 * every push to it), empty when nothing is. `migrate` numbers migrations by position, so a migration at a shipped
 * position that changed or went missing (a revert that dropped it) lets the next new one reuse its number, and it never
 * runs on objects that ran the old one. A migration not in `shipped` yet is a problem too, so each is recorded before
 * it can be edited unseen; the manifest itself is append-only, which `scripts/check-migration-manifests.sh` enforces in CI, since a revert removes its line too; two branches that add one conflict on the same line of the manifest, the signal that they
 * both took the next number.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const shippedMigrationProblems = async (
  migrations: ReadonlyArray<Migration>,
  shipped: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const digests = await migrationDigests(migrations);
  const problems: string[] = [];

  for (const [index, digest] of shipped.entries()) {
    const number = index + 1;
    const now = digests[index];

    if (now === undefined) {
      problems.push(
        `Migration ${number} shipped but is gone. A revert never drops a migration: keep it and add one that undoes it.`,
      );
    } else if (now !== digest) {
      problems.push(
        `Migration ${number} changed since it shipped (${digest} → ${now}). A shipped migration is never edited: restore it and add the next one.`,
      );
    }
  }

  for (const [index, digest] of digests.slice(shipped.length).entries()) {
    problems.push(
      `Migration ${shipped.length + index + 1} is not in the manifest: append "${digest}" to it.`,
    );
  }

  return problems;
};
