// The Session's Secrets (`docs/spec.md` → Secrets): values the owner enters in a masked form on a client, encrypted in
// this object's storage under a key derived from the deployment's `SECRETS_ENCRYPTION_KEY`, and the requests for them
// sent to every client over the Session socket.
import {
  openVault,
  type Secrets,
  type SecretsError,
  secretsLayer,
  type SecretStorage,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { secretRequests, send, type SocketState } from "./sockets.ts";

/** The master key Secrets are encrypted under: a deploy-time secret, bound to the Worker by `Config.Redacted`. */
export class SecretsConfig extends Context.Service<
  SecretsConfig,
  { readonly encryptionKey: Redacted.Redacted<string> }
>()("@cloudpid/server/session/secrets/SecretsConfig") {}

/** Reads `SECRETS_ENCRYPTION_KEY`: from the deploying environment, then from the Worker's secrets. */
export const SecretsConfigLive = Layer.effect(
  SecretsConfig,
  Config.all({ encryptionKey: Config.Redacted("SECRETS_ENCRYPTION_KEY") }),
);

export type SessionSecretsOptions = {
  /** The master key, `SECRETS_ENCRYPTION_KEY`. */
  readonly encryptionKey: Redacted.Redacted<string>;
  /** Names the Session in the key derivation, so a record opens only in the object that sealed it. */
  readonly session: string;
  /** The object's synchronous key-value storage. */
  readonly storage: SecretStorage;
  /** The object's sockets, which every change to the waiting requests is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
};

/** The Session's `Secrets`; build it once per instance, as it opens every Secret still held. */
export const sessionSecretsLayer = (
  options: SessionSecretsOptions,
): Layer.Layer<Secrets, SecretsError | SecretVaultError> =>
  Layer.unwrap(
    Effect.map(openVault(Redacted.value(options.encryptionKey), options.session), (vault) =>
      secretsLayer({
        storage: options.storage,
        vault,
        announce: (asks) =>
          Effect.forEach(options.sockets.getWebSockets(), (socket) =>
            send(socket, secretRequests(asks)),
          ).pipe(Effect.asVoid),
      }),
    ),
  );
