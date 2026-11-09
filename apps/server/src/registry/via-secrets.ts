// The Registry's check that a write made over the MCP endpoint keeps no kept Secret's value
// (`docs/architecture/mcp-endpoint.md` → Secret checks, #685 D6 and L7). A Local agent holds no Secret of its own, so
// nothing a Session would scrub from its own text covers it: the Registry opens the Secrets the write reaches (an
// Environment's own and Global's, or every Scope's for a write at `*`), and refuses the write when any text it keeps
// (the reason included) holds one, written as is or in an encoding `Redactions` knows. Only a write whose author carries
// `via` is checked; a Session's never is.
//
// The vault opens asynchronously and a write is synchronous (`transactionSync`), so the Secrets are opened first, in the
// same call, with a stamp of them (how many, and when the newest was kept). The check then runs inside the write's own
// transaction, on the texts the write keeps, and reads the stamp again: it refuses the write when it differs ("try
// again"), since a Secret kept, replaced or deleted meanwhile means the check no longer says what the write would keep.
// An install or an update of Skills keeps what it fetched, so it opens the Secrets after the fetch and runs the check at
// each save, on the files that save keeps.
// Not covered: a value a Session holds from `secret_ask` and has not kept, and one resolved from 1Password.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- the texts are walked in a plain object, whatever its shape.
import {
  type KeptVault,
  Redactions,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type AgentChangeAuthor, isEndpointAuthor } from "./agent-changes.ts";
import { binding } from "./environment-secrets.ts";
import {
  GLOBAL_SCOPE,
  type RegistryStorage,
  type RegistryStore,
  type SecretReach,
} from "./store.ts";

/** What a write that holds a kept Secret's value is refused with. It never holds the value. */
export const HOLDS_SECRET =
  "Nothing was saved: a text of the call holds the value of a Secret the user keeps. A credential belongs in a Secret the user keeps on the Secrets page, which every command then gets as $PI_SECRET_<NAME>; never write its value into a setting, a script, a Skill, a name or a reason.";

/** What a write is refused with when the kept Secrets changed while they were checked against it. */
export const SECRETS_CHANGED =
  "Nothing was saved: the kept Secrets changed while the call was checked, so try again";

/** What a write is refused with when the kept Secrets cannot be opened to check it against. */
export const SECRETS_UNCHECKABLE =
  "Nothing was saved: the kept Secrets cannot be opened to check the call against, so no change can be made over MCP until they can";

/**
 * Whether the check's refusal `message` heals by itself (the kept Secrets changed meanwhile, or could not be opened), so
 * the caller may try the same call again: the endpoint answers it `unavailable`, and any other refusal
 * `invalid_argument`. It compares with the constants above, the one source of the words the check refuses with, so a
 * reworded refusal still heals.
 */
export const healingRefusal = (message: string): boolean =>
  message === SECRETS_CHANGED || message === SECRETS_UNCHECKABLE;

/** The Scopes an Environment's write reaches: its own Secrets and Global's. */
export const environmentReach = (environment: string): SecretReach => [environment, GLOBAL_SCOPE];

/** The Scopes a write at `scope` reaches: an Environment's own and Global's, or every Scope's for a write at `*`. */
export const reachOf = (scope: string): SecretReach =>
  scope === GLOBAL_SCOPE ? "every" : environmentReach(scope);

/** What a write keeps, as the check reads it: JSON-like, with the parts a call leaves out as `undefined`. */
export type KeptTexts =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<KeptTexts>
  | { readonly [key: string]: KeptTexts };

/** Every string `value` holds, its keys included, as the texts a write keeps. */
const textsOf = (value: KeptTexts, found: string[] = []): string[] => {
  if (Predicate.isString(value)) {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textsOf(item, found);
  } else if (Predicate.isObject(value)) {
    // SAFETY: what is no string, array or scalar is an object of `KeptTexts` (the type's last member).
    for (const [key, item] of Object.entries(value) as ReadonlyArray<[string, KeptTexts]>) {
      found.push(key);
      textsOf(item, found);
    }
  }

  return found;
};

/**
 * What a write keeps, out of its arguments `args`: all of them but the `notKept` keys a call names for itself. Everything
 * else is scanned, so an argument a method gains later is checked until its call says otherwise. The keys a call leaves
 * out are values the write compares with or replaces, not what it keeps: `expected` is the value the caller saw (an
 * `expected` Secret's value in a variable the write replaces must not refuse the write that replaces it), and `guard` is
 * the MCP hosts' revision the change is checked against.
 */
export const keptOf = <Args extends { readonly [key: string]: KeptTexts }>(
  args: Args,
  notKept: ReadonlyArray<keyof Args> = [],
): KeptTexts => Object.fromEntries(Object.entries(args).filter(([key]) => !notKept.includes(key)));

/** How many Secrets are opened at once. */
const OPEN_CONCURRENCY = 32;

/** What the check reads: the store's Secrets and the vault that opens them, and the storage the write's transaction is in. */
export type ViaSecretsDeps = {
  readonly storage: Pick<RegistryStorage, "transactionSync">;
  readonly store: Pick<RegistryStore, "sealedSecretsIn" | "keptSecretsStamp">;
  readonly vault: Effect.Effect<KeptVault, SecretVaultError>;
};

/** One write to guard: its author, what it keeps (`keptOf` its arguments), and the Scopes' Secrets it reaches. */
export type ViaGuarded = {
  readonly author: AgentChangeAuthor;
  readonly input: KeptTexts;
  readonly reach: SecretReach;
};

/**
 * What a check of the Secrets that are open says of what a write keeps: the refusal to answer, or undefined when it holds
 * none and the Secrets are as they were when they were opened. Synchronous, so a write calls it inside its own
 * transaction, where no Secret can be kept between the check and the write.
 */
export type ViaCheck = (kept: KeptTexts) => string | undefined;

/** What an install or an update of Skills calls once it has fetched: the check its saves run (`openViaCheck`), if any. */
export type OpenViaCheck = () => Promise<ViaCheck | undefined>;

/**
 * Open the Secrets `reach` names for a write by `author`, and answer the check to run on what it keeps, inside the
 * write's transaction: it refuses a text that holds one, and refuses when the Secrets changed (kept, replaced or deleted)
 * since they were opened ("try again"). Undefined for a write with no `via`, which is never checked.
 */
export const openViaCheck =
  (deps: ViaSecretsDeps) =>
  ({ author, reach }: Pick<ViaGuarded, "author" | "reach">): Effect.Effect<ViaCheck | undefined> =>
    Effect.gen(function* () {
      if (!isEndpointAuthor(author)) return undefined;

      const { store } = deps;
      const stamp = store.keptSecretsStamp(reach);
      const sealed = store.sealedSecretsIn(reach);
      const unchanged = () => store.keptSecretsStamp(reach) === stamp;

      // A scope no Secret reaches never opens the vault, so it works whatever the master key.
      if (!Arr.isReadonlyArrayNonEmpty(sealed)) {
        return () => (unchanged() ? undefined : SECRETS_CHANGED);
      }

      const keys = yield* Effect.option(deps.vault);

      if (Option.isNone(keys)) return () => SECRETS_UNCHECKABLE;

      const redactions = new Redactions();

      // A Secret that does not open (sealed under another key) is held by no one, and is left out.
      const opened = yield* Effect.forEach(
        sealed,
        (row) =>
          Effect.option(
            Effect.map(
              keys.value.open(binding(row.environment, row.name), row.sealed),
              (value) => ({ name: row.name, value }),
            ),
          ),
        { concurrency: OPEN_CONCURRENCY },
      );

      for (const found of opened) {
        if (Option.isSome(found)) redactions.hold(found.value.name, found.value.value);
      }

      return (kept: KeptTexts) => {
        if (!unchanged()) return SECRETS_CHANGED;

        const texts = textsOf(kept);

        return redactions.redact(texts) === texts ? undefined : HOLDS_SECRET;
      };
    });

/**
 * Check `guarded` and run `write`, a synchronous write (it opens its own transaction) that answers as `refuse` does when
 * it is not made: `refuse(message)` is the refusal of its answer's union. A write whose author has no `via` runs as it
 * was, unchecked.
 */
export const guardedViaWrite =
  (deps: ViaSecretsDeps) =>
  <A>(guarded: ViaGuarded, refuse: (message: string) => A, write: () => A): Effect.Effect<A> =>
    Effect.map(openViaCheck(deps)(guarded), (check) => {
      if (check === undefined) return write();

      // Inside a transaction, so no Secret is kept between the check and the write.
      return deps.storage.transactionSync(() => {
        const problem = check(guarded.input);

        return problem === undefined ? write() : refuse(problem);
      });
    });
