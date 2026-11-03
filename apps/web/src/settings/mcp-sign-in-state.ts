// @effect-diagnostics missingPipeableSignature:off -- atoms and helpers over values, not combinators.

// What the MCP servers section reads and does of the owner's MCP sign-ins (docs/architecture/mcp-sign-in.md → Settings,
// Starting and completing a sign-in → Learning the outcome, Sign-out): the Registry's `mcpSignIns` list, which asks again when
// the sign-in page posts on `BroadcastChannel("cloudpid:mcp-sign-in")` and when the tab is shown again, and after a
// sign-out, and never on a timer ("Nothing polls"); and the sign-out and its dialog.

import * as Match from "effect/Match";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import type { McpSignInsState } from "./mcp-sign-in-model.ts";

/** The channel the callback page tells the outcome on (`apps/server/src/mcp/sign-in-pages.ts`: its message is `{ outcome }`). */
export const SIGN_IN_CHANNEL = "cloudpid:mcp-sign-in";

/** Counts the messages the sign-in page posts, so the list asks again when a sign-in was made in another tab. */
export const mcpSignInMessageAtom: Atom.Atom<number> = Atom.readable((get) => {
  if (typeof BroadcastChannel === "undefined") return 0;

  let count = 0;
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL);

  channel.onmessage = () => {
    get.setSelf(++count);
  };

  get.addFinalizer(() => {
    channel.close();
  });

  return count;
});

/** The owner's MCP sign-ins as the Registry has them, asked again on the sign-in page's message, on focus, and after a sign-out. */
export const mcpSignInsAtom = RegistryClient.query("mcpSignIns", undefined, {
  reactivityKeys: ["mcp-sign-ins", "settings"],
}).pipe(Atom.makeRefreshOnSignal(mcpSignInMessageAtom), Atom.refreshOnWindowFocus);

/** What the page knows of the sign-ins: still asking, why they could not be read, or the list. */
export const mcpSignInsStateAtom = Atom.readable((get): McpSignInsState => {
  const result = get(mcpSignInsAtom);

  if (AsyncResult.isSuccess(result)) {
    return Match.value(result.value).pipe(
      Match.tag("SignIns", (list): McpSignInsState => ({ status: "ready", list })),
      Match.tag("Unavailable", ({ message }): McpSignInsState => ({
        status: "failed",
        problem: message,
      })),
      Match.orElse((): McpSignInsState => ({
        status: "failed",
        problem: "The server answered with something this build does not know",
      })),
    );
  }

  const problem = failureOf(result);

  return problem === null ? { status: "loading" } : { status: "failed", problem };
});

/** The sign-in whose Sign out dialog is open at Scope `scope`, by its hash. */
export const mcpSignOutOpenAtom = Atom.family((_scope: string) => Atom.make<string | null>(null));

/** Sign out of the sign-in named by its hash; the list asks again once it ends. Its answer is what the dialog tells. */
export const signOutMcpAtom = Atom.family((_scope: string) =>
  appRuntime.fn((hash: string) =>
    RegistryClient.use((registry) => registry("signOutMcpSignIn", { hash })).pipe(
      changing(["mcp-sign-ins"]),
    ),
  ),
);
