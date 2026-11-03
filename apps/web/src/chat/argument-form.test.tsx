import type { McpPromptArgument } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formKey } from "./argument-form.ts";
import { ArgumentForm, requiredFilled } from "./argument-form.tsx";
import { PromptChipView } from "./prompt-chip.tsx";

const FIELDS: McpPromptArgument[] = [
  { name: "pr", title: "Pull request", description: "The number", required: true },
  { name: "focus", required: false },
];

const press = (
  key: string,
  place: { index: number; count?: number; valid?: boolean },
  more: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
) =>
  formKey(
    {
      key,
      shiftKey: more.shiftKey ?? false,
      altKey: more.altKey ?? false,
      ctrlKey: more.ctrlKey ?? false,
      metaKey: more.metaKey ?? false,
    },
    { index: place.index, count: place.count ?? 3, valid: place.valid ?? true },
  );

describe("the argument form's keys", () => {
  it("moves to the next field with Tab or Enter, and back with Shift+Tab", () => {
    expect(press("Tab", { index: 0 })).toBe("next");
    expect(press("Enter", { index: 1 })).toBe("next");
    expect(press("Tab", { index: 1 }, { shiftKey: true })).toBe("previous");
  });

  it("leaves Tab at the ends to the browser, and Enter in the last field is Done only when the values allow it", () => {
    expect(press("Tab", { index: 0 }, { shiftKey: true })).toBeNull();
    expect(press("Tab", { index: 2 })).toBeNull();
    expect(press("Enter", { index: 2, valid: true })).toBe("done");
    expect(press("Enter", { index: 2, valid: false })).toBeNull();
  });

  it("is Done from any field with Ctrl or Cmd, a new line with Shift or Alt, and cancels on Escape", () => {
    expect(press("Enter", { index: 0 }, { ctrlKey: true })).toBe("done");
    expect(press("Enter", { index: 0, valid: false }, { metaKey: true })).toBeNull();
    expect(press("Enter", { index: 0 }, { shiftKey: true })).toBeNull();
    expect(press("Enter", { index: 0 }, { altKey: true })).toBeNull();
    expect(press("Escape", { index: 1 })).toBe("cancel");
    expect(press("a", { index: 1 })).toBeNull();
  });
});

describe("the argument form", () => {
  const render = (values: Record<string, string>, problem?: string) =>
    renderToStaticMarkup(
      <ArgumentForm
        title="Review PR"
        server="docs"
        fields={FIELDS}
        values={values}
        problem={problem}
        onChange={() => {}}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );

  it("has a field for each argument in declared order, marks the required one, and shows its description", () => {
    const html = render({ pr: "", focus: "" });

    expect(html.indexOf("Pull request")).toBeLessThan(html.indexOf("focus"));
    expect(html).toContain("Pull request");
    expect(html).toContain("(optional)");
    expect(html).toContain("The number");
    expect(html).toContain('aria-label="Arguments of Review PR"');
  });

  it("disables Done while a required field is empty", () => {
    expect(render({ pr: "  " })).toContain('type="submit" disabled=""');
    expect(render({ pr: "7" })).not.toContain('type="submit" disabled=""');
    expect(requiredFilled(FIELDS, { pr: "7" })).toBe(true);
    expect(requiredFilled(FIELDS, { focus: "x" })).toBe(false);
  });

  it("says why the Session refused the last send above the fields", () => {
    expect(render({ pr: "x" }, "The argument pr is required")).toContain(
      'role="alert" class="text-xs text-destructive">The argument pr is required',
    );
  });
});

describe("the chip", () => {
  const prompt = {
    command: "/mcp__docs__review",
    server: "docs",
    source: "owner",
    name: "review",
    title: "Review PR",
    description: "",
    arguments: FIELDS,
    completions: false,
  };

  it("shows the prompt with its arguments, edits on a click and is removed by its ✕", () => {
    const html = renderToStaticMarkup(
      <PromptChipView
        chip={{ prompt, values: { pr: "7" } }}
        onEdit={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain("docs · Review PR · pr: 7");
    expect(html).toContain('aria-label="Remove the MCP prompt"');
    expect(html).toContain("Edit the arguments");
  });

  it("says a prompt the catalog no longer offers cannot be sent", () => {
    const html = renderToStaticMarkup(
      <PromptChipView
        chip={{ prompt, values: {} }}
        gone="docs no longer offers Review PR"
        onEdit={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain("docs no longer offers Review PR");
    expect(html).toContain("border-dashed");
  });
});
