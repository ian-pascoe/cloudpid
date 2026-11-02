// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { accessProps } from "./access-props.ts";
import { ACCESS_AUDIENCE_VAR, LOCAL_MODE_VAR } from "./deployment.ts";

const application = { aud: "the-application-aud" };

const run = (options: { readonly dev: boolean; readonly runtime?: boolean }) => {
  const declare = vi.fn(() => Effect.succeed(application));

  return Effect.runPromise(
    accessProps({
      declare: Effect.suspend(declare),
      runtime: options.runtime ?? false,
      dev: options.dev,
    }),
  ).then((result) => ({ result, declare }));
};

describe("the stack's guard props", () => {
  it("put the Worker in local mode under alchemy dev, and declare no application", async () => {
    const { result, declare } = await run({ dev: true });

    expect(result.vars).toEqual({ [LOCAL_MODE_VAR]: "true" });
    expect(result.props).toEqual({});
    expect(declare).not.toHaveBeenCalled();
  });

  it("give a deployed stage its application's audience and never the local-mode var", async () => {
    const { result, declare } = await run({ dev: false });

    expect(result.vars).toEqual({ [ACCESS_AUDIENCE_VAR]: "the-application-aud" });
    expect(result.vars).not.toHaveProperty(LOCAL_MODE_VAR);
    expect(result.props).toEqual({ access: application });
    expect(declare).toHaveBeenCalledTimes(1);
  });

  it("set nothing where the bundle itself runs", async () => {
    const { result, declare } = await run({ dev: false, runtime: true });

    expect(result).toEqual({ props: {}, vars: {} });
    expect(declare).not.toHaveBeenCalled();
  });
});
