// @effect-diagnostics missingPipeableSignature:off -- plain helpers over a Scope's requests, not combinators.

// The Approvals asked over the MCP endpoint (docs/architecture/mcp-endpoint.md → Approvals with no Session), as the
// Settings page shows them: each Scope's requests, asked again every few seconds while the page is visible (a Local
// agent asks them, which the page hears of no other way), and the owner's Approve, Decline and Try again.

import type { RegistryApproval } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, type RegistryKey, RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { visibleTickAtom } from "../sessions.ts";

/** Scope `scope`'s requests, oldest first, asked again every few seconds while the page is visible. */
export const approvalsAtom = Atom.family((scope: string) =>
  RegistryClient.query("listApprovals", { scope }, { reactivityKeys: ["approvals"] }).pipe(
    Atom.makeRefreshOnSignal(visibleTickAtom),
    Atom.refreshOnWindowFocus,
  ),
);

/** Scope `scope`'s requests as of the last answer; empty until the first, and while it cannot load. */
export const approvalListAtom = Atom.family((scope: string) =>
  Atom.map(approvalsAtom(scope), (result) =>
    result.pipe(AsyncResult.value, Option.getOrElse((): ReadonlyArray<RegistryApproval> => [])),
  ),
);

/** The requests of section `section`, in the order listed. */
export const approvalsIn = (
  approvals: ReadonlyArray<RegistryApproval>,
  section: string,
): ReadonlyArray<RegistryApproval> => Arr.filter(approvals, (each) => each.section === section);

/** "Asked via pi (MCP)": who asked a request, as its card's byline says it. */
export const askedVia = (approval: RegistryApproval): string =>
  `Asked via ${approval.via.client?.name ?? "an MCP client"} (MCP)`;

/** What an answered request may have changed at Scope `scope`: the settings, the Container settings, and the Builds. */
const answeredKeys = (scope: string): ReadonlyArray<RegistryKey> => [
  "approvals",
  "settings",
  "settings-changes",
  "global",
  "builds",
  `environment-settings:${scope}`,
  `agent-changes:${scope}`,
];

/** What the owner does to a request: answer it, or apply again an approved one a cut left unapplied. */
export type ApprovalAction =
  | {
      readonly kind: "answer";
      readonly scope: string;
      readonly id: string;
      readonly approved: boolean;
      readonly reason?: string;
    }
  | { readonly kind: "retry"; readonly scope: string; readonly id: string };

/**
 * Answer or retry a request; the Registry applies an Approve before it answers. The requests and what the change may
 * have touched ask again either way, so the card shows where the request stands now.
 */
export const approvalActionAtom = appRuntime.fn(
  (action: ApprovalAction) =>
    RegistryClient.use((registry) =>
      action.kind === "retry"
        ? registry("retryApproval", { id: action.id })
        : registry(
            "answerApproval",
            action.reason === undefined || action.reason === ""
              ? { id: action.id, approved: action.approved }
              : { id: action.id, approved: action.approved, reason: action.reason },
          ),
    ).pipe(Effect.asVoid, changing(answeredKeys(action.scope))),
  { concurrent: true },
);
