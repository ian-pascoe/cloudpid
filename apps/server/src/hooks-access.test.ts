// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { appOrigin } from "./deployment.ts";
import { hooksAccessProps, hooksApplicationProps } from "./hooks-access.ts";
import { HOOKS_PREFIX } from "./hooks-path.ts";
import { appHost } from "./mcp-access.ts";

const run = (options: {
  readonly stage: string;
  readonly dev: boolean;
  readonly runtime?: boolean;
}) => {
  const declare = vi.fn(() => Effect.succeed({ aud: "the-hooks-aud" }));

  return Effect.runPromise(
    hooksAccessProps({
      stage: options.stage,
      runtime: options.runtime ?? false,
      dev: options.dev,
      declare,
    }),
  ).then(() => declare);
};

describe("the Hooks application's props", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev/hooks/*"],
    ["pr-444", "cloudpid-server-pr-444.ian-g-pascoe.workers.dev/hooks/*"],
    ["dev_Ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/hooks/*"],
  ])("on %s have the one public destination %s", (stage, destination) => {
    expect(hooksApplicationProps(stage).destinations).toEqual([
      { type: "public", uri: destination },
    ]);
  });

  it.each(["prod", "pr-444", "dev_ian"])(
    "name the prefix the Worker's router serves, on the host of %s's app origin",
    (stage) => {
      expect(hooksApplicationProps(stage).destinations).toEqual([
        { type: "public", uri: `${new URL(appOrigin(stage)).host}${HOOKS_PREFIX}/*` },
      ]);
    },
  );

  it("are a self-hosted application with one Bypass/Everyone policy, and no Worker destination", () => {
    const props = hooksApplicationProps("prod");

    expect(props).toStrictEqual({
      type: "self_hosted",
      domain: props.domain,
      adopt: true,
      destinations: props.destinations,
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });
    expect(JSON.stringify(props)).not.toContain("worker");
  });

  it.each(["prod", "pr-540", "dev_ian"])(
    "set domain to the destination, as Cloudflare echoes it, and adopt a leftover of %s",
    (stage) => {
      const props = hooksApplicationProps(stage);

      expect(props.domain).toBe(props.destinations[0].uri);
      expect(props.domain).toBe(`${appHost(stage)}/hooks/*`);
      expect(props.adopt).toBe(true);
    },
  );

  it("do not cover the bare /hooks, or any other path of the app", () => {
    const { uri } = hooksApplicationProps("prod").destinations[0];

    expect(uri.endsWith("/hooks/*")).toBe(true);
    expect(uri).not.toMatch(/\/hooks$/);
  });
});

describe("the stack's Hooks application", () => {
  it.each(["prod", "pr-444", "dev_ian"])(
    "declares %s's application while the Worker is live",
    async (stage) => {
      const declare = await run({ stage, dev: false });

      expect(declare).toHaveBeenCalledTimes(1);
      expect(declare).toHaveBeenCalledWith(hooksApplicationProps(stage));
    },
  );

  it("declares nothing under alchemy dev, which has no Access", async () => {
    expect(await run({ stage: "dev_ian", dev: true })).not.toHaveBeenCalled();
  });

  it("declares nothing where the bundle itself runs", async () => {
    expect(await run({ stage: "runtime", dev: false, runtime: true })).not.toHaveBeenCalled();
  });
});
