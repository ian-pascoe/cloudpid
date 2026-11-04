// @effect-diagnostics preferEffectArray:off -- a menu's entries in native arrays.
import { type McpMenuTemplate, type McpResourceMenu, MAX_RESOURCE_URI } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { detectTrigger } from "./completion.ts";
import { completionFor, type MenuPick } from "./menu.ts";
import {
  type TemplateForm,
  templateDone,
  templateFields,
  templateProblem,
  templatePick,
  templateResource,
} from "./template-form.ts";

const REPO: McpMenuTemplate = {
  uriTemplate: "repo://{owner}/{name}{?ref}",
  name: "repo",
  title: "A repository",
};

const formOf = (template: McpMenuTemplate, values: Record<string, string>): TemplateForm => ({
  server: "repos",
  template,
  completions: true,
  values,
});

describe("a resource template's form", () => {
  it("has a field for each variable, in order, and the ones in a query are optional", () => {
    expect(templateFields(REPO)).toEqual([
      { name: "owner", required: true },
      { name: "name", required: true },
      { name: "ref", required: false },
    ]);
  });

  it("makes the resource of the URI the values fill in, named by the template's title else its name", () => {
    const form = formOf(REPO, { owner: "acme", name: "web app", ref: "main" });

    expect(templateResource(form)).toEqual({
      server: "repos",
      uri: "repo://acme/web%20app?ref=main",
      name: "A repository",
    });
    expect(
      templateResource(formOf({ uriTemplate: "x://{a}", name: "plain" }, { a: "1" })).name,
    ).toBe("plain");
  });
});

describe("picking a resource template", () => {
  const listed: McpResourceMenu = {
    servers: [
      {
        server: "repos",
        source: "owner",
        state: "ok",
        completions: true,
        resources: [],
        templates: [REPO, { uriTemplate: "repo://all", name: "all" }],
      },
    ],
  };

  const pickOf = (label: string): Extract<MenuPick, { kind: "template" }> => {
    const trigger = detectTrigger("@", 1);

    if (trigger === null) throw new Error("no trigger");

    const entry = completionFor(
      trigger,
      [],
      undefined,
      { query: "", paths: [], searching: false, failed: false },
      listed,
    )?.entries.find((each) => each.label === label);

    if (entry?.pick.kind !== "template") throw new Error(`no template row ${label}`);

    return entry.pick;
  };

  it("opens the form of its variables, and Done attaches the resource, from the menu's row to the chip", () => {
    const pick = pickOf("A repository");
    const picked = templatePick(pick.server, pick.template, pick.completions);

    expect(picked).toMatchObject({ kind: "form", form: { completions: true, values: {} } });

    if (picked.kind !== "form") return;

    // Held until the required variables are filled in.
    expect(templateDone(picked.form)).toEqual({ problem: "Fill in the required fields" });
    expect(templateDone({ ...picked.form, values: { owner: "acme" } })).toHaveProperty("problem");
    expect(templateDone({ ...picked.form, values: { owner: "acme", name: "web" } })).toEqual({
      resource: { server: "repos", uri: "repo://acme/web", name: "A repository" },
    });
  });

  it("attaches a template with no variables at once", () => {
    const pick = pickOf("all");

    expect(templatePick(pick.server, pick.template, pick.completions)).toEqual({
      kind: "attach",
      resource: { server: "repos", uri: "repo://all", name: "all" },
    });
  });

  it("refuses a template with no variables whose URI cannot be attached", () => {
    expect(
      templatePick("repos", { uriTemplate: "ui://app/view", name: "view" }, false),
    ).toMatchObject({
      kind: "refused",
      problem: expect.stringContaining("App"),
    });
  });
});

describe("a filled template's URI that cannot be attached", () => {
  const OPEN: McpMenuTemplate = { uriTemplate: "{+target}", name: "any" };

  it("holds Done, with the reason, when it is over the bound the Session decodes with", () => {
    const form = formOf(OPEN, { target: `x://${"a".repeat(MAX_RESOURCE_URI)}` });

    expect(templateProblem(form)).toContain("over the 2048");
    expect(templateDone(form)).toEqual({ problem: expect.stringContaining("over the 2048") });
  });

  it("holds Done for an App's ui:// resource a variable fills in, in any case", () => {
    for (const target of ["ui://docs/page", "UI://docs/page"]) {
      expect(templateDone(formOf(OPEN, { target }))).toEqual({
        problem: expect.stringContaining("App"),
      });
    }
  });

  it("says nothing while a required field is empty, and lets a good URI through", () => {
    expect(templateProblem(formOf(OPEN, {}))).toBeUndefined();
    expect(templateDone(formOf(OPEN, { target: "file:///a.md" }))).toEqual({
      resource: { server: "repos", uri: "file:///a.md", name: "any" },
    });
  });
});
