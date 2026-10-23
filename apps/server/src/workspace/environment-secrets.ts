// A Workspace's copy of its Environment's kept Secrets (docs/spec.md → Secrets, Snapshots): the values its Container
// must not keep in a snapshot, and must not print. The Workspaces Worker cannot reach the Registry, so they are handed
// over with the Container settings (a Session's readying, a spare's request, a Build's request), and the Workspace DO
// keeps them sealed in its storage (AES-GCM under a key HKDF derives from `SECRETS_ENCRYPTION_KEY`, bound to this
// object and each Secret's name), because the work that needs them runs on alarms after an eviction or a deploy, when
// nothing hands them again: the idle stop's snapshot, a spare's preparation, a Build. A copy that does not open (the
// key changed, or the Worker has none) is a copy of Secrets it cannot show to be absent from the disk: the snapshots
// and Builds that need it are refused until the next handover replaces it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type {
  KeptScope,
  KeptSecret,
  KeptVault,
  SealedValue,
} from "@cloudpid/extensions/secrets/core";
import * as Effect from "effect/Effect";
import type { SettingsStorage } from "./settings.ts";

/** Where the sealed copy is kept. */
const SECRETS_KEY = "cloudpid:environment-secrets";

/** A Secret of the copy at rest: its name, scope and flag, and its value sealed (null where the Worker had no key). */
type StoredSecret = {
  readonly name: string;
  readonly scope: KeptScope;
  readonly build: boolean;
  readonly sealed: SealedValue | null;
};

type StoredSecrets = { readonly version: 1; readonly secrets: ReadonlyArray<StoredSecret> };

/** What the Workspace holds: its Environment's Secrets, or why it cannot show them (never with a value). */
export type HeldSecrets =
  | { readonly ok: true; readonly secrets: ReadonlyArray<KeptSecret> }
  | { readonly ok: false; readonly reason: string };

export type WorkspaceSecretsOptions = {
  readonly storage: SettingsStorage;
  /** The Workspaces' kept vault; rejects where the Worker has no `SECRETS_ENCRYPTION_KEY`. */
  readonly vault: () => Promise<KeptVault>;
  /** This object's id, which each value is bound to. */
  readonly owner: string;
};

const same = (left: ReadonlyArray<KeptSecret>, right: ReadonlyArray<KeptSecret>): boolean =>
  left.length === right.length &&
  left.every((secret, index) => {
    const other = right[index];

    return (
      other !== undefined &&
      other.name === secret.name &&
      other.value === secret.value &&
      other.scope === secret.scope &&
      other.build === secret.build
    );
  });

export const workspaceSecretsStore = ({ storage, vault, owner }: WorkspaceSecretsOptions) => {
  /** What was handed or opened in this instance; undefined until then. */
  let held: ReadonlyArray<KeptSecret> | undefined;

  const keys = async (): Promise<KeptVault | undefined> => {
    try {
      return await vault();
    } catch {
      return undefined;
    }
  };

  /** Open the stored copy; why not, by name, when a Secret does not open. */
  const open = async (): Promise<HeldSecrets> => {
    const stored = await storage.get<StoredSecrets>(SECRETS_KEY);

    if (stored === undefined || stored.secrets.length === 0) return { ok: true, secrets: [] };

    const vaultOf = await keys();
    const opened: KeptSecret[] = [];
    const unopened: string[] = [];

    for (const secret of stored.secrets) {
      const value =
        vaultOf === undefined || secret.sealed === null
          ? undefined
          : await Effect.runPromise(
              vaultOf
                .open({ owner, name: secret.name }, secret.sealed)
                .pipe(Effect.orElseSucceed(() => undefined)),
            );

      if (value === undefined) unopened.push(secret.name);
      else opened.push({ name: secret.name, value, scope: secret.scope, build: secret.build });
    }

    if (unopened.length > 0) {
      return {
        ok: false,
        reason: `the Environment's Secrets ${unopened.join(", ")} are not held here (the encryption key changed, or the Workspace was evicted before it could seal them); a Session's readying hands them again`,
      };
    }

    return { ok: true, secrets: opened };
  };

  return {
    /** What the Workspace holds now, opening its stored copy the first time. */
    read: async (): Promise<HeldSecrets> => {
      if (held !== undefined) return { ok: true, secrets: held };

      const opened = await open();

      if (opened.ok) held = opened.secrets;

      return opened;
    },
    /** What this instance was handed or opened, without waiting: for redaction, which must not wait on storage. */
    known: (): ReadonlyArray<KeptSecret> => held ?? [],
    /**
     * Replace the copy with `secrets`, as last handed: sealed in storage, held in memory. Nothing is written when they
     * are what this instance holds. Without a key, the values are held in memory only, and the copy records names.
     */
    replace: async (secrets: ReadonlyArray<KeptSecret>): Promise<void> => {
      if (held !== undefined && same(held, secrets)) return;

      const vaultOf = await keys();
      const sealed: StoredSecret[] = [];

      for (const secret of secrets) {
        sealed.push({
          name: secret.name,
          scope: secret.scope,
          build: secret.build,
          sealed:
            vaultOf === undefined
              ? null
              : await Effect.runPromise(vaultOf.seal({ owner, name: secret.name }, secret.value)),
        });
      }

      await storage.put(SECRETS_KEY, { version: 1, secrets: sealed });
      held = [...secrets];
    },
  };
};

export type WorkspaceSecrets = ReturnType<typeof workspaceSecretsStore>;
