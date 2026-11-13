// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { bypassAccessProps, bypassApplicationProps } from "./bypass-access.ts";
import { appOrigin } from "./deployment.ts";
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
});
