// @effect-diagnostics missingPipeableSignature:off -- components and their handlers, not combinators.

// The argument forms the composer opens, with the server's completions behind them (`docs/architecture/mcp-in-a-session.md`
// → Arguments and completions): one for an MCP prompt, and one for a resource template picked from the `@` menu, whose
// variables the owner fills in to make the resource's URI.

import {
  type McpMenuTemplate,
  type McpPromptArgument,
  expandUriTemplate,
  uriTemplateVariables,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { ArgumentForm } from "./argument-form.tsx";
import type { ConversationKey } from "./conversation.ts";
import { promptTitle, type PromptForm } from "./mcp-prompt-state.ts";
import { useFormCompletion } from "./use-form-completion.ts";

/** The form open on a resource template: its server, whether it completes, and the values typed so far. */
export interface TemplateForm {
  readonly server: string;
  readonly template: McpMenuTemplate;
  readonly completions: boolean;
  readonly values: Readonly<Record<string, string>>;
}

/** What a template is called: its title, else its name. */
export const templateTitle = (template: Pick<McpMenuTemplate, "title" | "name">): string =>
  template.title ?? template.name;

/** A template's variables as form fields: each by name, the ones its URI cannot do without required. */
export const templateFields = (template: McpMenuTemplate): McpPromptArgument[] =>
  Arr.map(uriTemplateVariables(template.uriTemplate), ({ name, required }) => ({ name, required }));

/** The resource a template form's values make: its server, its URI and what the chip calls it. */
export interface TemplateResource {
  readonly server: string;
  readonly uri: string;
  readonly name: string;
}

/** The resource the form's values make: its URI, and what the chip calls it. */
export const templateResource = (form: TemplateForm): TemplateResource => ({
  server: form.server,
  uri: expandUriTemplate(form.template.uriTemplate, form.values),
  name: templateTitle(form.template),
});

/** The argument form of a prompt, asking the server for suggestions when it declares the capability. */
export const PromptFormView = ({
  conversation,
  form,
  signInHref,
  onChange,
  onDone,
  onCancel,
}: {
  conversation: ConversationKey;
  form: PromptForm;
  signInHref: (server: string) => string | undefined;
  onChange: (values: Record<string, string>) => void;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const completion = useFormCompletion({
    key: conversation,
    server: form.prompt.server,
    ref: { type: "ref/prompt", name: form.prompt.name },
    enabled: form.prompt.completions,
    signInHref: signInHref(form.prompt.server),
  });

  return (
    <ArgumentForm
      title={promptTitle(form.prompt)}
      server={form.prompt.server}
      fields={form.prompt.arguments}
      values={form.values}
      problem={form.problem}
      completion={completion}
      onChange={onChange}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
};

/** The argument form of a resource template: Done makes the resource of the URI the values fill in. */
export const TemplateFormView = ({
  conversation,
  form,
  signInHref,
  onChange,
  onDone,
  onCancel,
}: {
  conversation: ConversationKey;
  form: TemplateForm;
  signInHref: (server: string) => string | undefined;
  onChange: (values: Record<string, string>) => void;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const completion = useFormCompletion({
    key: conversation,
    server: form.server,
    ref: { type: "ref/resource", uri: form.template.uriTemplate },
    enabled: form.completions,
    signInHref: signInHref(form.server),
  });

  return (
    <ArgumentForm
      title={templateTitle(form.template)}
      server={form.server}
      fields={templateFields(form.template)}
      values={form.values}
      preview={expandUriTemplate(form.template.uriTemplate, form.values, true)}
      completion={completion}
      onChange={onChange}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
};
