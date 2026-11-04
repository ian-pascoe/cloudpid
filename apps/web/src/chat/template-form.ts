// What a resource template picked from the `@` menu does (`docs/architecture/mcp-in-a-session.md` → Attached resources,
// Arguments and completions): the pick opens a form of its variables, or is the resource at once when it has none, and Done
// makes the resource of the URI the values fill in, unless that URI could not be attached. Pure, so the composer only
// renders it.

// @effect-diagnostics missingPipeableSignature:off -- plain functions over a template and its values.

import {
  attachableUriProblem,
  expandUriTemplate,
  type McpMenuTemplate,
  type McpPromptArgument,
  uriTemplateVariables,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { requiredFilled } from "./argument-form.tsx";

/** The form open on a resource template: its server, whether it completes, and the values typed so far. */
export interface TemplateForm {
  readonly server: string;
  readonly template: McpMenuTemplate;
  readonly completions: boolean;
  readonly values: Readonly<Record<string, string>>;
}

/** The resource a template form's values make: its server, its URI and what the chip calls it. */
export interface TemplateResource {
  readonly server: string;
  readonly uri: string;
  readonly name: string;
}

/** What a template is called: its title, else its name. */
export const templateTitle = (template: Pick<McpMenuTemplate, "title" | "name">): string =>
  template.title ?? template.name;

/** A template's variables as form fields: each by name, the ones its URI cannot do without required. */
export const templateFields = (template: McpMenuTemplate): McpPromptArgument[] =>
  Arr.map(uriTemplateVariables(template.uriTemplate), ({ name, required }) => ({
    name,
    required,
  }));

/** The resource the form's values make: its URI, and what the chip calls it. */
export const templateResource = (form: TemplateForm): TemplateResource => ({
  server: form.server,
  uri: expandUriTemplate(form.template.uriTemplate, form.values),
  name: templateTitle(form.template),
});

/**
 * Why Done is held while the form is filled in, or undefined: the URI the values make is over what an attached resource may
 * have (the Session would refuse the whole message) or an App's. Nothing is said while a required field is still empty: Done
 * waits for it anyway.
 */
export const templateProblem = (form: TemplateForm): string | undefined =>
  requiredFilled(templateFields(form.template), form.values)
    ? attachableUriProblem(templateResource(form).uri)
    : undefined;

/** What picking a template does: open its form, attach its resource at once, or say why it cannot be attached. */
export type TemplatePick =
  | { readonly kind: "form"; readonly form: TemplateForm }
  | { readonly kind: "attach"; readonly resource: TemplateResource }
  | { readonly kind: "refused"; readonly problem: string };

/** The pick of `template` of `server`, which completes its variables when `completions`. */
export const templatePick = (
  server: string,
  template: McpMenuTemplate,
  completions: boolean,
): TemplatePick => {
  const form: TemplateForm = { server, template, completions, values: {} };

  // A template with no variables is a resource already.
  if (templateFields(template).length > 0) return { kind: "form", form };

  const resource = templateResource(form);
  const problem = attachableUriProblem(resource.uri);

  return problem === undefined ? { kind: "attach", resource } : { kind: "refused", problem };
};

/** Done on `form`: the resource its values make, or why it is held. */
export const templateDone = (
  form: TemplateForm,
): { readonly resource: TemplateResource } | { readonly problem: string } => {
  const resource = templateResource(form);

  const problem =
    templateProblem(form) ??
    (requiredFilled(templateFields(form.template), form.values)
      ? undefined
      : "Fill in the required fields");

  return problem === undefined ? { resource } : { problem };
};
