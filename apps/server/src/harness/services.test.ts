// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions and the core/wrapper split (No
// Session), → After a change, and Notifications: the services the management tools run over with no Session. A change is
// recorded as the endpoint's caller with its `request_id` claim, is no caller's own, and leaves the Builds' and spares'
// upkeep to `background`; the endpoint's text check is given the deploy-time credentials; and the upkeep of recorded
// changes runs under `background`.
// @effect-diagnostics missedPipeableOpportunity:off
import { SPARE_WORKSPACE_FIELD } from "@cloudpid/config";
import { GLOBAL_ID } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { changingRegistry, harnessHosts, harnessUpkeep } from "./registry.fixture.ts";
import { harnessServices } from "./services.ts";

const via = { auth: "local" } as const;

const claim = { id: "r-1", tool: "environment_variable_set", digest: "d", attempt: "a-1" };

const KEY = "-----BEGIN PRIVATE KEY-----abc";

/** The services over the writing stand-in, with the upkeep noted and `background` held until the test runs it. */
const servicesOver = () => {
  const { registry, ledger } = changingRegistry();
  const upkeep = harnessUpkeep();

  const services = harnessServices({
    registry,
    mcpHosts: harnessHosts(),
    appOrigin: undefined,
    ...upkeep.deps,
    credentials: [KEY],
  });

  return { services, ledger, upkeep };
};

describe("the services of a change", () => {
  it.each([
    [
      "an Environment's variable",
      "default",
      "variables.API_URL",
      "https://a.test",
      ["builds.of:default"],
    ],
    [
      "Global's Spare Workspace setting",
      GLOBAL_ID,
      SPARE_WORKSPACE_FIELD,
      false,
      ["spares.of:default", "builds.of:default"],
    ],
  ] as const)(
    "record a change to %s as the caller's with its claim, and run its upkeep in the background only",
    (_, environment, field, value, after) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { services, ledger, upkeep } = servicesOver();
          const { environments } = services.changes({ kind: "endpoint", via, request: claim });

          const applied = yield* environments.change({
            environment,
            change: { field, value },
            author: { tool: "environment_variable_set", reason: "r" },
          });

          expect(applied).toMatchObject({ status: "changed" });
          expect(ledger.changes[0]?.author).toEqual({
            via,
            tool: "environment_variable_set",
            reason: "r",
            request: claim,
          });
          expect(ledger.claims.get("r-1")).toMatchObject({ attempt: "a-1", changes: [1] });
          expect(upkeep.calls).toEqual([]);

          yield* upkeep.runBackground;

          expect(upkeep.calls).toEqual(after);
        }),
      ),
  );

  it("mark no Environment as the caller's own: there is no Workspace", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { services } = servicesOver();
        const { environments } = services.changes({ kind: "endpoint", via });

        expect(yield* environments.current).toBeNull();
      }),
    ));

  // The check itself is `endpointTextCheck`'s (`@cloudpid/extensions`'s `environment-changes.test.ts`): here, only that it
  // is given the deploy-time credentials.
  it("check a kept text against the deploy-time credentials they are given", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { services } = servicesOver();
        const { holdsSecret } = services.changes({ kind: "endpoint", via });

        expect(yield* holdsSecret(`key ${KEY}`)).toBe(true);
      }),
    ));
});

describe("the upkeep of recorded changes", () => {
  it("runs each change's steps in the background, as after the owner's revert", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { services, upkeep } = servicesOver();

        yield* services.upkeep([
          { scope: "default", field: "variables.API_URL" },
          { scope: "default", field: "variables.API_URL" },
          { scope: GLOBAL_ID, field: SPARE_WORKSPACE_FIELD },
        ]);

        yield* upkeep.runBackground;

        expect(upkeep.calls).toEqual(["builds.of:default", "spares.all", "builds.of:default"]);
      }),
    ));
});
