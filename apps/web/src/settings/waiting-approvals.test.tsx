// @effect-diagnostics preferEffectArray:off -- the test tables are native arrays.

// The "Waiting for you" area: a card for each request waiting, with who asked; the progress of one approved, with Try
// again once a cut left it unapplied; what came of one done with; and the owner's answer and Try again as the Registry
// gets them.

import type { ApprovalStatus, RegistryApproval } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { renderToStaticMarkup } from "react-dom/server";
import { requestCardId } from "../chat/request-anchor.ts";
import { registryWith, settled } from "../registry.testing.ts";
import {
  type ApprovalAction,
  approvalActionAtom,
  approvalsAtom,
  approvalsIn,
} from "./approvals.ts";
import { WaitingApprovalsList, WaitingForYou } from "./waiting-approvals.tsx";

/** The client that asked, a name only the request carries: a card that shows it says who asked. */
const CLIENT = "client-7f3";

/** What a target is now, as only the request's `reason` carries it. */
const NOW = "value-now-9c2";

const approval = (
  id: string,
  status: ApprovalStatus,
  more: Partial<RegistryApproval> = {},
): RegistryApproval => ({
  id,
  scope: "work",
  section: "limits",
  card: {
    tool: "settings_spend_limit_set",
    target: "Work",
    change: "Spend limit per Session",
    before: "$10",
    after: "$20",
    reason: "The runs need more",
  },
  via: { client: { name: CLIENT }, auth: "oauth" },
  status,
  applying: false,
  createdAt: 1,
  expiresAt: 2,
  ...more,
});

const render = (approvals: ReadonlyArray<RegistryApproval>, busy = false) =>
  renderToStaticMarkup(
    <WaitingApprovalsList approvals={approvals} busy={busy} problem={null} onAction={() => {}} />,
  );

/** The markup of the card or row with request `id`'s anchor. */
const cardOf = (markup: string, id: string): string => {
  const start = markup.indexOf(`id="${requestCardId(id)}"`);

  expect(start, id).toBeGreaterThanOrEqual(0);

  return markup.slice(start, markup.indexOf("</section>", start));
};

/** The buttons' texts in `markup`, each with whether it is off. */
const buttons = (markup: string): ReadonlyArray<string> =>
  Array.from(markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g), ([, attributes = "", text]) =>
    attributes.includes('disabled=""') ? `${text} (off)` : (text ?? ""),
  );

describe("the Waiting for you area", () => {
  it("shows nothing when no request is for the section", () => {
    expect(render([])).toBe("");
  });

  it("shows a waiting request's card with who asked, and Approve and Decline", () => {
    const markup = render([approval("a1", "pending")]);
    const card = cardOf(markup, "a1");

    expect(markup).toContain('aria-label="Waiting for you"');
    expect(card).toContain('aria-label="Approval requested"');
    expect(card).toContain(CLIENT);
    expect(buttons(card)).toEqual(["Decline", "Approve"]);
  });

  it.each<[string, RegistryApproval, ReadonlyArray<string>]>([
    ["applying", approval("a", "approved", { applying: true }), []],
    ["cut before it was applied", approval("a", "approved"), ["Try again"]],
    ["applied", approval("a", "finished", { text: "The spend limit is $20 now." }), []],
    ["declined", approval("a", "declined"), []],
    ["changed since", approval("a", "changed_since", { reason: NOW }), []],
    ["refused", approval("a", "refused", { reason: "a Secret" }), []],
    ["expired", approval("a", "expired"), []],
    ["withdrawn", approval("a", "withdrawn", { withdrawal: "withdrawn" }), []],
  ])("shows a request %s as its progress, with no card to answer", (_, request, offered) => {
    const row = cardOf(render([request]), "a");

    expect(row).toContain('aria-label="Approval answered"');
    expect(row).toContain(CLIENT);
    expect(buttons(row)).toEqual(offered);
  });

  it("says a change not applied with what the target is now", () => {
    const row = cardOf(render([approval("a", "changed_since", { reason: NOW })]), "a");

    expect(row).toContain(NOW);
  });

  it("holds Try again while an answer is on its way", () => {
    expect(buttons(render([approval("a", "approved")], true))).toEqual(["Try again (off)"]);
  });

  it("keeps a section's requests and leaves the other sections' out", () => {
    const listed = [
      approval("a", "pending"),
      approval("b", "pending", { section: "instructions" }),
      approval("c", "finished"),
    ];

    expect(approvalsIn(listed, "limits").map((each) => each.id)).toEqual(["a", "c"]);
  });
});

describe("WaitingForYou", () => {
  it.effect("lists the Scope's requests and shows the section's", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];

      const registry = registryWith({
        listApprovals: (payload) => {
          asked.push(payload);

          return Effect.succeed([
            approval("a", "pending"),
            approval("b", "pending", { section: "instructions" }),
          ]);
        },
      });

      registry.mount(approvalsAtom("work"));
      yield* settled(registry, approvalsAtom("work"));

      const markup = renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <WaitingForYou scope="work" section="limits" />
        </RegistryContext.Provider>,
      );

      expect(asked).toEqual([{ scope: "work" }]);
      expect(markup).toContain(`id="${requestCardId("a")}"`);
      expect(markup).not.toContain(`id="${requestCardId("b")}"`);
      registry.dispose();
    }),
  );

  it.effect(
    "sends an Approve, a Decline with its reason and Try again, and asks for the requests again after",
    () =>
      Effect.gen(function* () {
        const answered: Array<unknown> = [];
        const retried: Array<unknown> = [];
        let lists = 0;

        const registry = registryWith({
          listApprovals: () => {
            lists += 1;

            return Effect.succeed([]);
          },
          answerApproval: (payload) => {
            answered.push(payload);

            return Effect.succeed(approval(payload.id, payload.approved ? "finished" : "declined"));
          },
          retryApproval: (payload) => {
            retried.push(payload);

            return Effect.succeed(approval(payload.id, "finished"));
          },
        });

        registry.mount(approvalsAtom("work"));
        registry.mount(approvalActionAtom);
        yield* settled(registry, approvalsAtom("work"));

        const act = (action: ApprovalAction) =>
          Effect.gen(function* () {
            registry.set(approvalActionAtom, action);
            yield* settled(registry, approvalActionAtom);
          });

        yield* act({ kind: "answer", scope: "work", id: "a", approved: true, reason: "" });
        yield* act({ kind: "answer", scope: "work", id: "b", approved: false, reason: "No" });
        yield* act({ kind: "retry", scope: "work", id: "c" });

        expect(answered).toEqual([
          { id: "a", approved: true },
          { id: "b", approved: false, reason: "No" },
        ]);
        expect(retried).toEqual([{ id: "c" }]);
        expect(Option.isSome(AsyncResult.value(registry.get(approvalActionAtom)))).toBe(true);
        yield* settled(registry, approvalsAtom("work"));
        expect(lists).toBeGreaterThan(1);
        registry.dispose();
      }),
  );
});
