// What the Workspace Session tests share (`session.workerd.test.ts`, `skills.workerd.test.ts`): a Session on a Workspace
// that runs a scripted model's tool calls. It is not a test file, so importing it registers no tests.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off missingPipeableSignature:off
import type { JsonValue } from "@earendil-works/chord";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
      readonly WORKSPACE_SESSIONS: DurableObjectNamespace<TestWorkspaceSession>;
    }
  }
}

let workspaces = 0;

/** A Workspace slug no other test uses. */
export const uniqueWorkspace = () => `session-${++workspaces}`;

/** A new Session on Workspace `slug`, working in its repo directory `repo` if it has one. */
export const sessionOn = (slug: string, repo: string | null = null) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  return {
    /** Run one Run whose scripted model calls each tool in turn, then answers; the text of that Run's tool results. */
    run: (calls: readonly string[]) =>
      runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
        instance.bindWorkspace(slug, repo);
        instance.script([...calls, "done"]);

        const earlier = (await instance.toolResults()).length;

        const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

        expect(answer).toMatchObject({ status: "answered", text: "done" });

        return (await instance.toolResults()).slice(earlier);
      }),

    /** The same, with the system prompt sections in effect for that Run too. */
    runFull: (calls: readonly string[]) =>
      runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
        instance.bindWorkspace(slug, repo);
        instance.script([...calls, "done"]);

        const earlier = (await instance.toolResults()).length;

        const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

        expect(answer).toMatchObject({ status: "answered", text: "done" });

        return {
          results: (await instance.toolResults()).slice(earlier),
          sections: instance.sections(),
        };
      }),
  };
};

export const call = (tool: string, args: JsonValue) => `call:${tool}:${JSON.stringify(args)}`;
