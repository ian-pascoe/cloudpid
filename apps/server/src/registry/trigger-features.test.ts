// @effect-diagnostics asyncFunction:off
// The check before a GitHub-managed hook is made: what the Registry's `triggerFeatures` answers, or how it fails, read
// as whether the hook can be made now. Its callers (`rpc.ts`, `session/triggers.ts`) each pass it through once.
import type { TriggerSourceInput } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { triggerGitHubHooksUnavailable, triggerGitHubHooksUnknown } from "./messages.ts";
import type { RegistryMethods } from "./Registry.ts";
import { githubHookRefusal } from "./trigger-features.ts";

const HOOKED: TriggerSourceInput = {
  type: "webhook",
  format: "github",
  repo: "octo-org/octo-repo",
  events: ["workflow_run"],
};

/** A Registry whose `triggerFeatures` answers `answer`, counting its calls. */
const registryAnswering = (answer: Effect.Effect<{ readonly githubHooks: boolean }>) => {
  let calls = 0;

  const registry: Pick<RegistryMethods, "triggerFeatures"> = {
    triggerFeatures: () =>
      Effect.suspend(() => {
        calls++;

        return answer;
      }),
  };

  return { registry, calls: () => calls };
};

const refusal = (answer: Effect.Effect<{ readonly githubHooks: boolean }>, source = HOOKED) =>
  Effect.runPromise(githubHookRefusal(registryAnswering(answer).registry, source));

describe("githubHookRefusal", () => {
  it("lets a hook be made once the Registry lists githubHooks, and asks nothing of a source that names none", async () => {
    const plain = registryAnswering(Effect.die("never asked"));

    expect(await refusal(Effect.succeed({ githubHooks: true }))).toBeUndefined();
    expect(
      await Effect.runPromise(
        githubHookRefusal(plain.registry, { type: "webhook", format: "github" }),
      ),
    ).toBeUndefined();
    expect(plain.calls()).toBe(0);
  });

  it("refuses while the Registry says false or has no triggerFeatures: an older one, for the minutes after a deploy", async () => {
    expect(await refusal(Effect.succeed({ githubHooks: false }))).toBe(
      triggerGitHubHooksUnavailable,
    );
    expect(
      await refusal(
        Effect.die(
          new TypeError('The RPC receiver does not implement the method "triggerFeatures".'),
        ),
      ),
    ).toBe(triggerGitHubHooksUnavailable);
  });

  it("refuses as unknown, not as an update, when the call fails otherwise", async () => {
    expect(await refusal(Effect.die(new Error("Network connection lost.")))).toBe(
      triggerGitHubHooksUnknown,
    );
  });
});
