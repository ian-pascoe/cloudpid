// The Container previews' routes (ADR-0023) through the real `BrowserHost` and a fake Browser Run (`./host.testing.ts`):
// every browser the host acquires carries Browser Run's `outboundByHost`, which sends the eight Container preview hosts
// to the `ContainerPreviews` entrypoint this Worker exports, made for the Session's Workspace. Each route is followed
// here to the stand-in Workspaces Worker (`vitest.config.ts`), which says which Workspace and port it was asked for.
// workerd's Durable Object state and RPC are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { describe, expect, it } from "vitest";
import { type Acquired, asSession, WHERE, withHost, WORKSPACE } from "./host.testing.ts";

/** Where each host of an acquisition's `outboundByHost` leads: the Workspace and port the request reached, by host. */
const routesOf = async (acquired: Acquired | undefined) => {
  const outbound = acquired?.outboundByHost;

  if (outbound === undefined) return undefined;

  const reached = await Promise.all(
    Object.entries(outbound).map(async ([host, fetcher]) => {
      const answer: { workspace: string; port: number } = await (
        await fetcher.fetch(`http://${host}/`)
      ).json();

      return [host, `${answer.workspace} on ${answer.port}`] as const;
    }),
  );

  return Object.fromEntries(reached);
};

/** The eight routes, each to `workspace`'s Container on the port its host names; never computerd's 8080. */
const routesTo = (workspace: string) => ({
  "3000.cloudpid.internal": `${workspace} on 3000`,
  "3001.cloudpid.internal": `${workspace} on 3001`,
  "4173.cloudpid.internal": `${workspace} on 4173`,
  "4321.cloudpid.internal": `${workspace} on 4321`,
  "5173.cloudpid.internal": `${workspace} on 5173`,
  "5174.cloudpid.internal": `${workspace} on 5174`,
  "8000.cloudpid.internal": `${workspace} on 8000`,
  "8787.cloudpid.internal": `${workspace} on 8787`,
});

describe("the Container previews' routes", () => {
  it("go with every browser the host acquires, wherever from, beside its keep-alive: all eight to the Session's Workspace", () =>
    withHost(async (raw, run) => {
      const host = asSession(raw, WORKSPACE);

      // A run starts the browser.
      await host.run(WHERE, 1);
      // Closed, then started again by the Browser Pane opening an Owner tab.
      await host.close();
      await host.ownerTabView(true);
      // Closed, then started again by a new Owner tab.
      await host.close();
      await host.openOwnerTab();
      // Lost by Browser Run, then replaced by the next run.
      run.lose();
      await host.run(WHERE, 1);

      expect(run.state.acquired).toHaveLength(4);

      for (const acquired of run.state.acquired) {
        expect(acquired.keepAlive).toBe(600_000);
        expect(await routesOf(acquired)).toEqual(routesTo(WORKSPACE));
      }
    }));

  it("go to the latest Workspace a call named; a call that named none leaves it", () =>
    withHost(async (raw, run) => {
      await asSession(raw, "ws:first").openOwnerTab();
      await raw.close();
      await asSession(raw, "ws:second").openOwnerTab();
      await raw.close();
      await asSession(raw, undefined).run(WHERE, 1);

      expect(await routesOf(run.state.acquired[0])).toEqual(routesTo("ws:first"));
      expect(await routesOf(run.state.acquired[1])).toEqual(routesTo("ws:second"));
      expect(await routesOf(run.state.acquired[2])).toEqual(routesTo("ws:second"));
    }));

  it("cannot be set by a call laid out as before Container previews, nor by anything but a Workspace DO's name", () =>
    withHost(async (host, run) => {
      // A Session from before Container previews names no Workspace, and its code is code, whatever it reads.
      await host.run("ws:other", 1);
      await host.ownerTabView(true);
      await host.close();
      // Not a Workspace DO's name: another object's, or one that is no `ws:<id>`.
      await host.openOwnerTab("build:environment");
      await host.close();
      await host.run(WHERE, 1, undefined, "ws:../other");

      expect(run.state.acquired.length).toBeGreaterThanOrEqual(2);

      for (const acquired of run.state.acquired) {
        expect(acquired).not.toHaveProperty("outboundByHost");
      }
    }));

  it("are left out while no call has named a Workspace, and the browser is acquired as before", () =>
    withHost(async (raw, run) => {
      await asSession(raw, undefined).run(WHERE, 1);

      expect(run.state.acquired).toHaveLength(1);
      expect(run.state.acquired[0]).not.toHaveProperty("outboundByHost");
      expect(run.state.acquired[0]?.keepAlive).toBe(600_000);
    }));
});
