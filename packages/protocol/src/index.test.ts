import { expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { packageName } from "@cloudpid/protocol";

it("exposes its placeholder export through the package name", () => {
  expect(packageName).toBe(pkg.name);
});
