// @vitest-environment happy-dom
// @effect-diagnostics preferEffectArray:off globalTimers:off newPromise:off asyncFunction:off -- a form driven in a DOM, its asks kept in native arrays.
// The argument form's wiring to its completions (`docs/architecture/mcp-in-a-session.md` → As built (#485): completion): the
// focus asks at once, typing asks once it stops, the answer is listed under the focused field and taken with the keys, and
// closing the form cancels what is in flight.
import type { McpCompletion } from "@cloudpid/protocol";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionAsk } from "./argument-completion.ts";
import { ArgumentForm } from "./argument-form.tsx";

const FIELDS = [
  { name: "owner", required: true },
  { name: "repo", required: false },
];

/** What the fake Session was asked, with the answer of each and whether it was aborted. */
type Asked = {
  readonly ask: CompletionAsk;
  readonly signal: AbortSignal;
  readonly answer: (completion: McpCompletion) => void;
};

const asked: Asked[] = [];

const complete = (ask: CompletionAsk, signal: AbortSignal) =>
  new Promise<McpCompletion>((resolve) => {
    asked.push({ ask, signal, answer: resolve });
  });

const Form = ({ onDone = () => {} }: { onDone?: () => void }) => {
  const [values, setValues] = useState<Record<string, string>>({ owner: "", repo: "" });

  return (
    <ArgumentForm
      title="Review"
      server="repos"
      fields={FIELDS}
      values={values}
      completion={{ scope: "repos:review", complete }}
      onChange={setValues}
      onDone={onDone}
      onCancel={() => {}}
    />
  );
};

let container: HTMLDivElement;
let root: Root;

const press = (element: HTMLElement, key: string) => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

const field = (name: string) =>
  container.querySelector<HTMLTextAreaElement>(`textarea[id$="-${name}"]`);

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  // @ts-expect-error -- React's act environment flag, which happy-dom does not set.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  asked.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("the argument form with completions", () => {
  it("asks for the first field's suggestions as the form opens, and lists them under it", async () => {
    act(() => {
      root.render(<Form />);
    });
    await flush();

    expect(asked.map((each) => each.ask)).toEqual([
      { field: "owner", argument: { name: "owner", value: "" }, context: {} },
    ]);

    asked[0]?.answer({ status: "ok", values: ["acme", "apex"], hasMore: false });
    await flush();

    expect(
      [...container.querySelectorAll('[role="option"]')].map((each) => each.textContent),
    ).toEqual(["acme", "apex"]);
  });

  it("takes the highlighted suggestion with the arrows and Enter, and closes the list after", async () => {
    act(() => {
      root.render(<Form />);
    });
    await flush();
    asked[0]?.answer({ status: "ok", values: ["acme", "apex"], hasMore: false });
    await flush();

    const owner = field("owner");

    if (owner === null) throw new Error("the field is not there");

    press(owner, "ArrowDown");
    press(owner, "ArrowDown");
    press(owner, "Enter");

    expect(owner.value).toBe("apex");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("says why there are no suggestions, as a link when the owner can sign in", async () => {
    act(() => {
      root.render(<Form />);
    });
    await flush();
    asked[0]?.answer({ status: "sign_in", values: [], hasMore: false });
    await flush();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Sign in to repos for suggestions",
    );
  });
});
