// @effect-diagnostics missingPipeableSignature:off -- atoms and helpers over values, not combinators.

// What the MCP servers section reads and does of the owner's MCP sign-ins (docs/architecture/mcp-sign-in.md → Settings,
// Starting and completing a sign-in → Learning the outcome, Sign-out): the Registry's `mcpSignIns` list, which asks again when
// the sign-in page posts on `SIGN_IN_CHANNEL`, when the window takes focus and when the tab is shown again, and after a
// sign-out, and never on a timer ("Nothing polls"); and the sign-out and its dialog.

import { SIGN_IN_CHANNEL } from "@cloudpid/protocol";
import * as Match from "effect/Match";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import type { McpSignInsState } from "./mcp-sign-in-model.ts";

/**
 * Counts the messages the sign-in page posts and the times the window takes focus, so the list asks again when a sign-in was
 * made in another tab or the owner comes back from the authorization server's page (the tab being shown again is
 * `refreshOnWindowFocus`'s, below).
 */
export const mcpSignInMessageAtom: Atom.Atom<number> = Atom.readable((get) => {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return 0;

  let count = 0;
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL);

  const bump = () => {
    get.setSelf(++count);
  };

  channel.onmessage = bump;
  window.addEventListener("focus", bump);

  get.addFinalizer(() => {
    channel.close();
    window.removeEventListener("focus", bump);
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

/** The sign-in a Sign out dialog is open for: its hash, and the id of the element focus returns to once the dialog closes. */
export type McpSigningOut = { readonly hash: string; readonly returnTo: string };

/** The sign-out whose dialog is open at Scope `scope`. */
export const mcpSignOutOpenAtom = Atom.family((_scope: string) =>
  Atom.make<McpSigningOut | null>(null),
);

/** Sign out of the sign-in named by its hash; the list asks again once it ends. Its answer is what the dialog tells. */
export const signOutMcpAtom = Atom.family((_scope: string) =>
  appRuntime.fn((hash: string) =>
    RegistryClient.use((registry) => registry("signOutMcpSignIn", { hash })).pipe(
      changing(["mcp-sign-ins"]),
    ),
  ),
);
