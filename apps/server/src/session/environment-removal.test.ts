// The deletes the owner approved (`sessionEnvironmentRemoval`), over a fake Registry: what `environment_delete`'s card
// says deleting an Environment takes (its Workspaces, their Sessions, its kept Secrets and its Triggers), and the two
// author sources (#685 L1): a Session's, which deletes nothing when the Registry does not list it, and the endpoint's,
// whose Secret delete is recorded as its caller's with its claim, its upkeep after the answer, and whose Environment
// delete hands its progress through to `removals` (whose steps `../registry/removal.test.ts` owns) and pushes the hosts'
// sets after it, and again for one found gone (`docs/architecture/mcp-endpoint.md` → Approvals with no Session).
// @effect-diagnostics asyncFunction:off newPromise:off
import type { EnvironmentSecretRecord, TriggerDefinition } from "@cloudpid/protocol";
import type { SessionRecord, WorkspaceRecord } from "../registry/store.ts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import type { AgentChangeAuthor } from "../registry/agent-changes.ts";
import { type AuthorSource, sessionSource } from "./change-author.ts";
import {
  type EnvironmentRemovalRegistry,
  sessionEnvironmentRemoval,
} from "./environment-removal.ts";

const trigger = (id: string, environment: string): TriggerDefinition => ({
  id,
  revision: 1,
  kind: "environment",
  environment,
  name: id,
  message: "m",
  source: { type: "schedule", cron: "@daily", zone: "UTC" },
  whenBusy: "skip",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});

const unused = () => Effect.die("not used here");

// SAFETY: the footprint reads only the fields given of each record.
const workspace = (id: string, environment: string) => ({ id, environment }) as WorkspaceRecord;

// SAFETY: as above.
const session = (id: string, workspace: string) => ({ id, workspace }) as SessionRecord;

// SAFETY: as above.
const secret = (environment: string, name: string) =>
  ({ environment, name }) as EnvironmentSecretRecord;

const ENDPOINT: AuthorSource = {
  kind: "endpoint",
  via: { auth: "oauth", client: { name: "pi" } },
  request: { id: "approval:a-1", tool: "environment_secret_delete", digest: "d", attempt: "a-1" },
};

/** The removal over a fake Registry, as `author`, and what it did, in order. */
const setUp = (author: AuthorSource) => {
  const done: Array<string> = [];
  const authors: Array<AgentChangeAuthor> = [];
  const later: Array<Effect.Effect<void>> = [];
  const held = { workspaces: [workspace("w1", "0000abcd"), workspace("w2", "default")] };

  const registry: EnvironmentRemovalRegistry = {
    getEnvironment: ({ id }) =>
      Effect.succeed(id === "0000abcd" ? { id, name: "Web", repos: [], createdAt: 0 } : null),
    listWorkspaces: () => Effect.sync(() => held.workspaces),
    listSessions: () => Effect.succeed([session("s1", "w1"), session("s2", "w2")]),
    listEnvironmentSecrets: () => Effect.succeed([secret("0000abcd", "A")]),
    listTriggers: ({ environment }) =>
      Effect.succeed(
        Arr.filter(
          [trigger("t1", "0000abcd"), trigger("t2", "0000abcd"), trigger("t3", "default")],
          (each) => each.environment === environment,
        ),
      ),
    agentDeleteSecret: ({ environment, author: by }) =>
      Effect.sync(() => {
        done.push(`delete secret ${environment ?? "*"}`);
        authors.push(by);

        return {
          status: "deleted" as const,
          environment: { id: "0000abcd", name: "Web" },
          change: {
            id: 1,
            scope: "0000abcd",
            at: 0,
            actor: "agent" as const,
            session: null,
            conversation: null,
            tool: "environment_secret_delete",
            reason: "r",
            field: "secrets.A",
            before: "kept",
            after: null,
            reverts: null,
            revertedBy: null,
          },
        };
      }),
    getSpare: () => Effect.succeed(null),
    deleteEnvironmentWithTriggers: () =>
      Effect.sync(() => {
        done.push("forget environment");

        return { deletion: "deleted" as const, triggers: [] };
      }),
    getSession: unused,
    deleteSessionWithTriggers: unused,
    deleteSessionTriggers: unused,
    deleteWorkspace: unused,
    deleteWorkspaceWithTriggers: unused,
    deleteWorkspaceTriggers: unused,
    workspaceKept: unused,
    listSubagentWorkspaces: unused,
    forgetSpare: unused,
    listEnvironments: unused,
  };

  const endpoint = author.kind === "endpoint";

  const removal = sessionEnvironmentRemoval({
    registry,
    author,
    objects: {
      workspaces: { destroy: () => Promise.resolve() },
      sessions: { destroy: unused },
      triggers: { remove: unused },
    },
    builds: { of: (environment) => Effect.sync(() => done.push(`build ${environment}`)) },
    // The endpoint's upkeep runs after the answer, and its delete pushes the hosts' sets; a Session's has neither.
    background: endpoint
      ? (effect: Effect.Effect<void>) => Effect.sync(() => void later.push(effect))
      : undefined,
    mcp: endpoint
      ? {
          sync: (environment?: string) =>
            Effect.sync(() => void done.push(`sync ${environment ?? "all"}`)),
        }
      : undefined,
  });

  /** Run what was handed to `background`. */
  const runLater = async () => {
    for (const effect of later.splice(0)) await Effect.runPromise(effect);
  };

  return { removal, done, authors, held, runLater };
};

describe("what deleting an Environment takes", () => {
  it("counts its Triggers beside its Workspaces, Sessions and kept Secrets", async () => {
    const { removal } = setUp(sessionSource("s-9"));

    expect(await Effect.runPromise(removal.footprint("0000abcd"))).toEqual({
      workspaces: 1,
      sessions: 1,
      secrets: 1,
      triggers: 2,
    });
    expect(await Effect.runPromise(removal.footprint("0000ffff"))).toBeNull();
  });
});

describe("the deletes, by author source", () => {
  const deleteSecret = {
    environment: "0000abcd",
    name: "A",
    expected: { updatedAt: 1 },
    author: { tool: "environment_secret_delete", reason: "r", approved: true as const },
  };

  it("deletes nothing for a Session the Registry does not list", async () => {
    const { removal, done } = setUp(sessionSource(undefined));

    await Effect.runPromise(removal.deleteSecret(deleteSecret).pipe(Effect.flip));
    await Effect.runPromise(removal.deleteEnvironment("0000abcd").pipe(Effect.flip));

    expect(done).toEqual([]);
  });

  it("records a Session's Secret delete as its own, and awaits the Builds' upkeep", async () => {
    const { removal, done, authors } = setUp(sessionSource("s-9"));

    await Effect.runPromise(removal.deleteSecret(deleteSecret));

    expect(authors).toEqual([expect.objectContaining({ session: "s-9", approved: true })]);
    expect(done).toEqual(["delete secret 0000abcd", "build 0000abcd"]);
  });

  it("records the endpoint's Secret delete as its caller's with the claim, the Builds' upkeep after the answer", async () => {
    const { removal, done, authors, runLater } = setUp(ENDPOINT);

    await Effect.runPromise(removal.deleteSecret(deleteSecret));

    expect(authors).toEqual([
      expect.objectContaining({
        via: { auth: "oauth", client: { name: "pi" } },
        request: expect.objectContaining({ id: "approval:a-1", attempt: "a-1" }),
        approved: true,
      }),
    ]);
    expect(done).toEqual(["delete secret 0000abcd"]);

    await runLater();

    expect(done).toEqual(["delete secret 0000abcd", "build 0000abcd"]);
  });

  it("hands the endpoint's Environment delete its progress, then pushes the hosts' sets after the answer", async () => {
    const { removal, done, held, runLater } = setUp(ENDPOINT);

    // Where each step falls is `removal.test.ts`'s: here, with no Workspace, only that the progress reaches it.
    held.workspaces = [];

    await Effect.runPromise(
      removal.deleteEnvironment("0000abcd", {
        onStep: Effect.sync(() => {
          done.push("step");
        }),
      }),
    );

    expect(done).toContain("step");
    expect(done).not.toContain("sync all");

    await runLater();

    expect(done.at(-1)).toBe("sync all");
  });

  it("pushes the hosts' sets again for an Environment found gone on the endpoint, and nothing in a Session", async () => {
    const endpoint = setUp(ENDPOINT);
    const inSession = setUp(sessionSource("s-9"));

    await Effect.runPromise(endpoint.removal.afterGone("0000abcd"));
    await Effect.runPromise(inSession.removal.afterGone("0000abcd"));
    await endpoint.runLater();
    await inSession.runLater();

    expect(endpoint.done).toEqual(["sync all"]);
    expect(inSession.done).toEqual([]);
  });
});
