// @effect-diagnostics preferEffectRecord:off -- plain objects of hundreds of keys, built to see that there is no cap.
import { describe, expect, it } from "vitest";
import { EVENT_PATH, matchesDelivery, matchFacts, matchProblem } from "./trigger-match.ts";

const run = {
  action: "completed",
  workflow_run: { conclusion: "failure", head_branch: "main", run_attempt: 2, fork: false },
  commits: [{ message: "fix" }, { message: "feat" }],
};

const delivery = { event: "workflow_run", body: run };

describe("matchesDelivery", () => {
  it("passes every delivery when there is no match", () => {
    expect(matchesDelivery(undefined, delivery)).toBe(true);
    expect(matchesDelivery({}, delivery)).toBe(true);
  });

  it("takes the event's name as the path event, not a body field of that name", () => {
    expect(matchesDelivery({ [EVENT_PATH]: ["workflow_run"] }, delivery)).toBe(true);
    expect(matchesDelivery({ [EVENT_PATH]: ["push"] }, delivery)).toBe(false);
    expect(
      matchesDelivery({ event: ["push"] }, { event: "push", body: { event: "workflow_run" } }),
    ).toBe(true);
    expect(matchesDelivery({ event: ["push"] }, { event: undefined, body: {} })).toBe(false);
  });

  it("ANDs paths and ORs the values of one path", () => {
    const match = { event: ["workflow_run"], "workflow_run.conclusion": ["failure", "timed_out"] };

    expect(matchesDelivery(match, delivery)).toBe(true);
    expect(matchesDelivery(match, { ...delivery, event: "push" })).toBe(false);
    expect(
      matchesDelivery({ ...match, "workflow_run.head_branch": ["release", "develop"] }, delivery),
    ).toBe(false);
    expect(
      matchesDelivery({ ...match, "workflow_run.head_branch": ["release", "main"] }, delivery),
    ).toBe(true);
  });

  it("reads dotted paths into objects and array indexes", () => {
    expect(matchesDelivery({ "commits.1.message": ["feat"] }, delivery)).toBe(true);
    expect(matchesDelivery({ "commits.2.message": ["feat"] }, delivery)).toBe(false);
  });

  it("compares numbers and booleans as text, and never matches an object, an array or nothing", () => {
    expect(matchesDelivery({ "workflow_run.run_attempt": ["2"] }, delivery)).toBe(true);
    expect(matchesDelivery({ "workflow_run.fork": ["false"] }, delivery)).toBe(true);
    expect(matchesDelivery({ workflow_run: ["[object Object]"] }, delivery)).toBe(false);
    expect(matchesDelivery({ commits: ["undefined"] }, delivery)).toBe(false);
    expect(matchesDelivery({ "workflow_run.nope": ["undefined"] }, delivery)).toBe(false);
    expect(
      matchesDelivery({ action: ["null"] }, { event: undefined, body: { action: null } }),
    ).toBe(true);
  });

  it("never follows a prototype", () => {
    expect(matchesDelivery({ "constructor.name": ["Object"] }, delivery)).toBe(false);
    expect(matchesDelivery({ "workflow_run.__proto__": ["x"] }, delivery)).toBe(false);
  });

  it("matches a body that is not an object only on the event", () => {
    expect(matchesDelivery({ a: ["b"] }, { event: undefined, body: "text" })).toBe(false);
    expect(matchesDelivery({ event: ["ping"] }, { event: "ping", body: undefined })).toBe(true);
  });

  it("has no cap on paths or values", () => {
    const paths = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}`, ["1"]]));
    const body = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}`, 1]));
    const values = Array.from({ length: 5000 }, (_, i) => String(i));

    expect(matchesDelivery(paths, { event: undefined, body })).toBe(true);
    expect(matchesDelivery({ n: values }, { event: undefined, body: { n: 4999 } })).toBe(true);
  });
});

describe("matchProblem", () => {
  it("takes dotted paths that each list a value", () => {
    expect(matchProblem({})).toBeUndefined();
    expect(matchProblem({ event: ["push"], "a.b.0.c": ["x"] })).toBeUndefined();
  });

  it("refuses a path with an empty part and a path with no values", () => {
    expect(matchProblem({ "": ["x"] })).toBeDefined();
    expect(matchProblem({ "a..b": ["x"] })).toBeDefined();
    expect(matchProblem({ ".a": ["x"] })).toBeDefined();
    expect(matchProblem({ a: [] })).toBeDefined();
  });
});

describe("matchFacts", () => {
  it("keeps what each path of a match reads, nested, so a match over those paths gives the same answer", () => {
    const body = {
      workflow_run: { conclusion: "failure", id: 7, head: { ok: true } },
      other: "x",
      list: ["a", "b"],
    };

    const match = {
      "workflow_run.conclusion": ["failure"],
      "workflow_run.id": ["7"],
      "list.1": ["b"],
      event: ["x"],
    };

    const facts = matchFacts(match, body);

    expect(facts).toEqual({ workflow_run: { conclusion: "failure", id: "7" }, list: { "1": "b" } });
    expect(matchesDelivery(match, { event: "x", body: facts })).toBe(true);
    expect(
      matchesDelivery(
        { ...match, "workflow_run.conclusion": ["success"] },
        { event: "x", body: facts },
      ),
    ).toBe(false);
  });

  it("leaves out a path that holds no scalar, so a later match over it never passes", () => {
    const facts = matchFacts({ a: ["x"], "b.c": ["y"], d: ["z"] }, { a: { n: 1 }, d: null });

    expect(facts).toEqual({ d: "null" });
    expect(matchFacts({ a: ["x"] }, undefined)).toEqual({});
  });

  it("never builds a key that could reach a prototype", () => {
    const facts = matchFacts({ "__proto__.x": ["1"], a: ["1"] }, { a: 1 });

    expect(Object.getPrototypeOf(facts)).toBe(Object.prototype);
    expect(facts).toEqual({ a: "1" });
  });
});
