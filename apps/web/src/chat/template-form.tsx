// @effect-diagnostics missingPipeableSignature:off -- components and their handlers, not combinators.

// The argument forms the composer opens, with the server's completions behind them (`docs/architecture/mcp-in-a-session.md`
// → Arguments and completions): one for an MCP prompt, and one for a resource template picked from the `@` menu, whose
// variables the owner fills in to make the resource's URI.

import { expandUriTemplate } from "@cloudpid/protocol";
import { ArgumentForm, type FormCompletion } from "./argument-form.tsx";
import type { ConversationKey } from "./conversation.ts";
import { promptTitle, type PromptForm } from "./mcp-prompt-state.ts";
import {
  type TemplateForm,
  templateFields,
  templateProblem,
  templateTitle,
} from "./template-form.ts";
import { useDraftFormCompletion } from "../draft-completion.ts";
import { useFormCompletion } from "./use-form-completion.ts";

/** The argument form of a prompt with its completions given: the Session composer's and the draft's differ in where they ask. */
export const PromptFormBody = ({
  form,
  completion,
  onChange,
  onDone,
  onCancel,
}: {
  form: PromptForm;
  completion: FormCompletion | undefined;
  onChange: (values: Record<string, string>) => void;
  onDone: () => void;
  onCancel: () => void;
}) => (
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

/** The argument form of a prompt in a Session's composer, asking the Session for suggestions when the server declares the capability. */
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
    <PromptFormBody
      form={form}
      completion={completion}
      onChange={onChange}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
};

/** The argument form of a prompt in the draft composer, asking the Registry (HTTP servers only) for suggestions. */
export const DraftPromptFormView = ({
  environment,
  form,
  onChange,
  onDone,
  onCancel,
}: {
  environment: string;
  form: PromptForm;
  onChange: (values: Record<string, string>) => void;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const completion = useDraftFormCompletion({
    environment,
    server: form.prompt.server,
    ref: { type: "ref/prompt", name: form.prompt.name },
    enabled: form.prompt.completions,
  });

  return (
    <PromptFormBody
      form={form}
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
      blocked={templateProblem(form)}
      completion={completion}
      onChange={onChange}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
};
