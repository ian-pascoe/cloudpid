// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-reflect-get, anti-slop/require-safety-comment-for-type-assertion -- the Registry's methods are called by name with the data their RPC carries; the test knows each one's shape. */
// The workerd test Durable Object that runs the real Registry (`registryMethods`) over its own SQLite storage and the test
// master key, and calls its methods by name: the wiring a call goes through (the endpoint author's check, the change
// requests, the features) is the deployed one, not a test's own.
import * as Alchemy from "@alchemy.run/cloudflare";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { GitHubAppConfig } from "../github/config.ts";
import { PushConfig } from "../push/config.ts";
import { SecretsConfig } from "../session/secrets.ts";
import { registryMethods } from "./Registry.ts";
import type { KeptTexts } from "./via-secrets.ts";

/** The master key `SECRETS_ENCRYPTION_KEY` has in the other workerd tests. */
export const REAL_REGISTRY_KEY = "test-master-key-0123456789abcdef0123456789";

export class RealRegistry extends DurableObject {
  readonly #methods: Promise<Readonly<Record<string, unknown>>>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#methods = Effect.runPromise(
      registryMethods.pipe(
        // The first Effect reads the services, the second builds the methods.
        Effect.flatten,
        // SAFETY: the Registry reads only `state.raw.storage` of the Durable Object's state, and nothing of `worker` here.
        Effect.provideService(Alchemy.DurableObjectState, { raw: ctx } as never),
        Effect.provideService(Alchemy.WorkerEnvironment, {} as never),
        Effect.provideService(SecretsConfig, { encryptionKey: Redacted.make(REAL_REGISTRY_KEY) }),
        Effect.provideService(PushConfig, {
          vapid: { subject: "mailto:test@example.test", publicKey: "unused", privateKey: "unused" },
        }),
        Effect.provideService(GitHubAppConfig, {
          appId: Redacted.make("1"),
          privateKey: Redacted.make("unused"),
        }),
      ),
    );
  }

  /** Call the Registry's method `method` with `input`, as its RPC does: plain data in, plain data out. */
  async call(method: string, input?: KeptTexts): Promise<KeptTexts> {
    const run: unknown = Reflect.get(await this.#methods, method);

    if (!Predicate.isFunction(run)) throw new Error(`The Registry has no method ${method}`);

    // SAFETY: a method of the Registry takes its input and answers an Effect of plain data.
    const answer: Effect.Effect<KeptTexts> = run(input);

    return Effect.runPromise(answer);
  }
}
