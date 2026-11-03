// The main Worker's side of the sign-ins in Settings (`docs/architecture/mcp-sign-in.md` → Settings, Sign-out): the list with
// the stage, the stage's names from the Worker's vars, and the sign-out carried to the hosts that used the sign-in. A Registry
// that fails, or lacks the method (an older deploy), is `Unavailable` and carries nothing.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off
import { McpNoSignIn, McpSignedOut, McpSignInsListing, McpUnavailable } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN_VAR,
  LOCAL_MODE_VAR,
  MCP_CLIENT_DOCUMENT_VAR,
  STAGE_LABEL_VAR,
} from "../deployment.ts";
import { mcpSignInManage, signInStageView } from "./sign-in-manage.ts";
import type { McpSignInChangeCarried } from "./sign-in-carry.ts";

const STAGE = {
  local: false,
  documentEnabled: true,
  label: "pr-9",
  origin: "https://pr-9.example",
};

const harness = (registry: Parameters<typeof mcpSignInManage>[0]["registry"]) => {
  const carried: Array<McpSignInChangeCarried> = [];

  const manage = mcpSignInManage({
    registry,
    stage: STAGE,
    carry: {
      carry: (change) =>
        Effect.sync(() => {
          carried.push(change);
        }),
    },
  });

  return { manage, carried };
};

const LISTING = McpSignInsListing.make({ revision: 4, signIns: [], lapsedStarts: [] });

describe("signInStageView", () => {
  it("names a live stage's label and origin, and whether the document is in the ladder", () => {
    expect(
      signInStageView({
        [APP_ORIGIN_VAR]: "https://pr-9.example",
        [STAGE_LABEL_VAR]: "pr-9",
        [MCP_CLIENT_DOCUMENT_VAR]: "true",
      }),
    ).toEqual(STAGE);
  });

  it("is prod without a label, and has no origin or document under alchemy dev", () => {
    expect(signInStageView({ [APP_ORIGIN_VAR]: "https://pi.ianpascoe.dev" })).toEqual({
      local: false,
      documentEnabled: false,
      origin: "https://pi.ianpascoe.dev",
    });
    expect(
      signInStageView({
        [LOCAL_MODE_VAR]: true,
        [STAGE_LABEL_VAR]: "dev_ian",
        [MCP_CLIENT_DOCUMENT_VAR]: "true",
        [APP_ORIGIN_VAR]: "https://ignored.example",
      }),
    ).toEqual({ local: true, documentEnabled: false, label: "dev_ian" });
  });
});

describe("mcpSignInManage", () => {
  it("lists the Registry's sign-ins with the stage", async () => {
    const { manage } = harness(() => ({
      listMcpSignIns: () => Effect.succeed(LISTING),
      signOutMcpSignIn: () => Effect.die("not asked"),
    }));

    expect(await Effect.runPromise(manage.list())).toEqual({ ...LISTING, stage: STAGE });
  });

  it("answers Unavailable, never failing, when the Registry cannot list (an older deploy lacks the method)", async () => {
    const { manage } = harness(() => ({
      listMcpSignIns: () => Effect.die(new Error("not a function: secret-cause")),
      signOutMcpSignIn: () => Effect.die("not asked"),
    }));

    const answer = await Effect.runPromise(manage.list());

    expect(answer).toEqual(McpUnavailable.make({ message: "cloudpid could not reach its store" }));
  });

  it("carries a sign-out to the hosts of the Environments that used the sign-in", async () => {
    const out = McpSignedOut.make({
      server: "sentry",
      revision: 7,
      revocation: { status: "revoked" },
      environments: [{ id: "env_1", name: "One" }],
    });

    const { manage, carried } = harness(() => ({
      listMcpSignIns: () => Effect.die("not asked"),
      signOutMcpSignIn: ({ hash }) => (hash === "abc" ? Effect.succeed(out) : Effect.die("wrong")),
    }));

    expect(await Effect.runPromise(manage.signOut("abc"))).toEqual(out);
    expect(carried).toEqual([
      {
        change: "signed_out",
        server: "sentry",
        environments: [{ id: "env_1", name: "One" }],
        revision: 7,
      },
    ]);
  });

  it("carries nothing for an answer that signed out of nothing", async () => {
    const { manage, carried } = harness(() => ({
      listMcpSignIns: () => Effect.die("not asked"),
      signOutMcpSignIn: () => Effect.succeed(McpNoSignIn.make({})),
    }));

    expect(await Effect.runPromise(manage.signOut("abc"))).toEqual(McpNoSignIn.make({}));
    expect(carried).toEqual([]);
  });

  it("says it could not confirm a sign-out when the Registry fails, and carries nothing", async () => {
    const { manage, carried } = harness(() => ({
      listMcpSignIns: () => Effect.die("not asked"),
      signOutMcpSignIn: () => Effect.die(new Error("boom")),
    }));

    const answer = await Effect.runPromise(manage.signOut("abc"));

    expect(Predicate.isTagged(answer, "Unavailable")).toBe(true);
    expect(JSON.stringify(answer)).not.toContain("boom");
    expect(carried).toEqual([]);
  });
});
