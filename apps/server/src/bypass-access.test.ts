// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { bypassAccessProps, bypassApplicationProps } from "./bypass-access.ts";
import { appOrigin } from "./deployment.ts";
import { appHost } from "./mcp-access.ts";
import { CALLBACK_PATH, CLIENT_DOCUMENT_PATH } from "./mcp/sign-in-origin.ts";

const run = (options: {
  readonly stage: string;
  readonly dev: boolean;
  readonly runtime?: boolean;
}) => {
  const declare = vi.fn(() => Effect.succeed({ aud: "the-bypass-aud" }));

  return Effect.runPromise(
    bypassAccessProps({
      stage: options.stage,
      runtime: options.runtime ?? false,
      dev: options.dev,
      declare,
    }),
  ).then(() => declare);
};

describe("the Bypass application's props", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev/oauth/mcp/client.json", "pi.ianpascoe.dev/oauth/mcp/callback"],
    [
      "pr-444",
      "cloudpid-server-pr-444.ian-g-pascoe.workers.dev/oauth/mcp/client.json",
      "cloudpid-server-pr-444.ian-g-pascoe.workers.dev/oauth/mcp/callback",
    ],
    [
      "dev_Ian",
      "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/oauth/mcp/client.json",
      "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/oauth/mcp/callback",
    ],
  ])("on %s have exactly two public destinations, %s and %s", (stage, document, callback) => {
    expect(bypassApplicationProps(stage).destinations).toEqual([
      { type: "public", uri: document },
      { type: "public", uri: callback },
    ]);
  });

  it.each(["prod", "pr-444", "dev_ian"])(
    "name the paths the Worker's router serves, on the host of %s's app origin",
    (stage) => {
      const host = new URL(appOrigin(stage)).host;

      expect(bypassApplicationProps(stage).destinations).toEqual([
        { type: "public", uri: `${host}${CLIENT_DOCUMENT_PATH}` },
        { type: "public", uri: `${host}${CALLBACK_PATH}` },
      ]);
    },
  );

  it("are a self-hosted application with one Bypass/Everyone policy, and no Worker destination", () => {
    const props = bypassApplicationProps("prod");

    expect(props.type).toBe("self_hosted");
    expect(props.policies).toEqual([{ decision: "bypass", include: [{ everyone: {} }] }]);
    expect(props).toStrictEqual({
      type: "self_hosted",
      domain: props.domain,
      adopt: true,
      destinations: props.destinations,
      policies: props.policies,
    });
    expect(JSON.stringify(props)).not.toContain("worker");
  });

  it.each(["prod", "pr-540", "dev_ian"])(
    "set domain to the first destination, as Cloudflare echoes it, and adopt a leftover of %s",
    (stage) => {
      const props = bypassApplicationProps(stage);

      expect(props.domain).toBe(props.destinations[0].uri);
      expect(props.domain).toBe(`${appHost(stage)}${CLIENT_DOCUMENT_PATH}`);
      expect(props.adopt).toBe(true);
    },
  );

  it("have no destination outside the two paths, and none that covers `/mcp` or `/oauth/mcp/start`", () => {
    for (const { uri } of bypassApplicationProps("prod").destinations) {
      expect(uri).not.toMatch(/\/mcp$/);
      expect(uri).not.toContain("start");
    }
  });
});

describe("the stack's bypass", () => {
  it.each(["prod", "pr-444", "dev_ian"])(
    "declares %s's application while the Worker is live",
    async (stage) => {
      const declare = await run({ stage, dev: false });

      expect(declare).toHaveBeenCalledTimes(1);
      expect(declare).toHaveBeenCalledWith(bypassApplicationProps(stage));
    },
  );

  it("declares nothing under alchemy dev, which has no Access", async () => {
    expect(await run({ stage: "dev_ian", dev: true })).not.toHaveBeenCalled();
  });

  it("declares nothing where the bundle itself runs", async () => {
    expect(await run({ stage: "runtime", dev: false, runtime: true })).not.toHaveBeenCalled();
  });
});
