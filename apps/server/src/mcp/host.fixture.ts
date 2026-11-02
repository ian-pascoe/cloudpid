// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The workerd test Durable Object that hosts `McpHost`'s methods over its SQLite storage, as the McpHost DO does, with a
// Registry the test scripts: what the pull asks, and what the Registry answers (or that it cannot).
import {
  type McpApply,
  type McpApplyResult,
  type McpRequestStart,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
} from "@cloudpid/mcp/types";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { mcpHostMethods, McpRegistryUnavailable } from "./host.ts";
import { environmentOfMcpHost } from "./name.ts";
import { openMcpHostStore, type StoredSet } from "./store.ts";

/** What the test Registry asked of the pull: the Environment, and the hash the host held. */
export type PullAsked = {
  readonly environment: string;
  readonly heldHash: string | undefined;
};

export class TestMcpHost extends DurableObject {
  readonly #store = openMcpHostStore(this.ctx.storage);

  readonly #asked: Array<PullAsked> = [];

  /** What the Registry answers the pull: the answer, or null for a Registry that cannot be reached. */
  #answer: McpServerSetAnswer | null = { hash: "", signInsRevision: 0 };

  readonly #methods = mcpHostMethods(environmentOfMcpHost(this.ctx.id.name), this.#store, {
    serverSet: (input) =>
      Effect.suspend(() => {
        this.#asked.push(input);

        return this.#answer === null
          ? Effect.fail(McpRegistryUnavailable.make({ message: "The Registry did not answer" }))
          : Effect.succeed(this.#answer);
      }),
  });

  /** Script the Registry's answer to the pull. */
  script(answer: McpServerSetAnswer | null): void {
    this.#answer = answer;
  }

  /** What the pull has asked of the Registry so far. */
  asked(): ReadonlyArray<PullAsked> {
    return this.#asked;
  }

  apply(input: McpApply): Promise<McpApplyResult> {
    return Effect.runPromise(this.#methods.apply(input));
  }

  requestStart(request: McpRequestStart): Promise<McpRequestStartAnswer> {
    return Effect.runPromise(this.#methods.requestStart(request));
  }

  /** The set as the store holds it. */
  readSet(): StoredSet | null {
    return this.#store.readSet();
  }

  /** Every table's rows as text, to look for what must not be there. */
  dump(): string {
    return JSON.stringify(
      ["mcp_meta", "mcp_servers"].map((table) =>
        this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
      ),
    );
  }
}
