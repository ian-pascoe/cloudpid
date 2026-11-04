// The form of a resource template as the composer renders it (`docs/architecture/mcp-in-a-session.md` → Attached resources):
// a value that makes a URI that cannot be attached holds Done, with the reason shown.
import { RegistryContext } from "@effect/atom-react";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { conversationKey } from "./conversation.ts";
import { TemplateFormView } from "./template-form.tsx";

const render = (target: string) =>
  renderToStaticMarkup(
    <RegistryContext.Provider value={AtomRegistry.make()}>
      <TemplateFormView
        conversation={conversationKey("s1", undefined)}
        form={{
          server: "docs",
          template: { uriTemplate: "{+target}", name: "any", title: "Any resource" },
          completions: false,
          values: { target },
        }}
        signInHref={() => undefined}
        onChange={() => {}}
        onDone={() => {}}
        onCancel={() => {}}
      />
    </RegistryContext.Provider>,
  );

describe("the resource template's form", () => {
  it("shows why a ui:// value cannot be attached, and holds Done", () => {
    const html = render("ui://docs/page");

    expect(html).toContain("An App&#x27;s ui:// resource cannot be attached");
    expect(html).toContain('type="button" disabled=""');
  });

  it("holds Done for a URI over the bound, and lets a good one through", () => {
    expect(render(`x://${"a".repeat(2_100)}`)).toContain("over the 2048");
    expect(render("file:///a.md")).not.toContain('disabled=""');
    expect(render("file:///a.md")).not.toContain('role="alert"');
  });
});
