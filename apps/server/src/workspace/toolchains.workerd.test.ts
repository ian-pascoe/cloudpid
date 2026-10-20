// The ignore list as computer's Container backend takes it: the backend refuses a pattern computerd would, as it is
// built, so a bad list would fail every Container start (docs/spec.md → Container and Toolchains).
import { ContainerBackend } from "@cloudflare/computer/backends/container";
import { TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import { expect, it } from "vitest";

it("gives computer's Container backend an ignore list it accepts", () => {
  expect(
    () =>
      new ContainerBackend({
        container: () => {
          throw new Error("not started");
        },
        workspace: { binding: "WORKSPACES", id: "toolchains" },
        ignore: TOOLCHAIN_IGNORE,
      }),
  ).not.toThrow();
});
