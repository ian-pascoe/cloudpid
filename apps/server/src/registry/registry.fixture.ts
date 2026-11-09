// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that runs the real Registry (`registryMethods`) over its own SQLite storage and the test
// master key, and calls its methods by name: the wiring a call goes through (the endpoint author's check, the change
// requests, the features) is the deployed one, not a test's own. GitHub is the one thing stood in for: the Registry reads
// Skills from the repo a test serves (`serveRepo`) through `SkillReaderOverride`.
import * as Alchemy from "@alchemy.run/cloudflare";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { GitHubAppConfig } from "../github/config.ts";
import type { RepoReader } from "../github/skill-fetch.ts";
import { PushConfig } from "../push/config.ts";
import { SecretsConfig } from "../session/secrets.ts";
import { type RegistryMethods, registryMethods } from "./Registry.ts";
import { SkillReaderOverride } from "./skill-reader.ts";

/** A repo as a test serves it: its files by path, at its head commit, whatever ref is asked. */
export type ServedRepo = {
  readonly files: Readonly<Record<string, string>>;
  readonly commit: string;
};

/**
 * A reader over the repo `served` gives when read; a blob's SHA names its commit, so a folder changes with its commit.
 * Reading with no repo served throws: a test that reads Skills serves them first.
 */
const servedReader = (current: () => ServedRepo | undefined): RepoReader => {
  const served = () => {
    const repo = current();

    if (repo === undefined) {
      throw new Error("RealRegistry: Skills were read with no repo served; call serveRepo first");
    }

    return repo;
  };

  const listing = async () => {
    const { files, commit } = served();

    return {
      truncated: false,
      // @effect-diagnostics-next-line preferEffectRecord:off preferEffectArray:off -- a fake repo's listing, a native record.
      entries: Object.entries(files).map(([path, text]) => ({
        path,
        type: "blob" as const,
        sha: `${commit}:${path}`,
        size: text.length,
      })),
    };
  };

  return {
    commit: async () => served().commit,
    tree: listing,
    headTree: listing,
    file: async () => null,
    blob: async (_repo, sha) =>
      new TextEncoder().encode(served().files[sha.slice(sha.indexOf(":") + 1)] ?? ""),
  };
};

/** The master key `SECRETS_ENCRYPTION_KEY` has in the other workerd tests. */
export const REAL_REGISTRY_KEY = "test-master-key-0123456789abcdef0123456789";

/** What Registry method `K` answers with. */
type RegistryAnswer<K extends keyof RegistryMethods> = Effect.Success<
  ReturnType<RegistryMethods[K]>
>;

export class RealRegistry extends DurableObject {
  readonly #methods: Promise<RegistryMethods>;
  /** The repo the Registry reads Skills from: none until a test serves one, and a read before then throws. */
  #repo: ServedRepo | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#methods = Effect.runPromise(
      registryMethods.pipe(
        // The first Effect reads the services, the second builds the methods.
        Effect.flatten,
        // SAFETY: the Registry reads only `state.raw.storage` of the Durable Object's state.
        Effect.provideService(Alchemy.DurableObjectState, { raw: ctx } as never),
        // SAFETY: the Registry reads the Worker's bindings only for `MCP_ENGINE`, which no test here reaches.
        Effect.provideService(Alchemy.WorkerEnvironment, {} as never),
        Effect.provideService(SecretsConfig, { encryptionKey: Redacted.make(REAL_REGISTRY_KEY) }),
        Effect.provideService(PushConfig, {
          vapid: { subject: "mailto:test@example.test", publicKey: "unused", privateKey: "unused" },
        }),
        Effect.provideService(
          SkillReaderOverride,
          servedReader(() => this.#repo),
        ),
        Effect.provideService(GitHubAppConfig, {
          appId: Redacted.make("1"),
          privateKey: Redacted.make("unused"),
        }),
      ),
    );
  }

  /** Serve `repo` to the Registry's Skill reads (every repo and ref a source names reads it), from the next read on. */
  serveRepo(repo: ServedRepo): void {
    this.#repo = repo;
  }

  /** Call the Registry's method `method` with `input`, as its RPC does, and answer what its Effect succeeds with. */
  async call<K extends keyof RegistryMethods>(
    method: K,
    ...input: Parameters<RegistryMethods[K]>
  ): Promise<RegistryAnswer<K>> {
    const methods = await this.#methods;

    // SAFETY: `methods[method]` is the method `K` names, which takes its `input` and answers an Effect of `RegistryAnswer<K>`;
    // TypeScript cannot relate a union of methods to one `K`.
    const run = methods[method] as (
      ...given: Parameters<RegistryMethods[K]>
    ) => Effect.Effect<RegistryAnswer<K>>;

    return Effect.runPromise(run(...input));
  }
}
