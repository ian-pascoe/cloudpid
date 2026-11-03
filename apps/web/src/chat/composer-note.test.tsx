import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerNote } from "./composer-note.tsx";
import { refusalNote } from "./composer-state.ts";
import { refusalOutcome } from "./mcp-prompt-state.ts";

const render = (
  note: Parameters<typeof ComposerNote>[0]["note"],
  signInHref: (server: string) => string | undefined = (server) => `/sign-in?server=${server}`,
) =>
  renderToStaticMarkup(
    <ComposerNote id="note" note={note} signInHref={signInHref} onRetry={() => {}} />,
  );

describe("the note under the composer", () => {
  it("is an alert for an error and a status for the rest", () => {
    expect(render({ tone: "error", text: "No." })).toContain('role="alert"');
    expect(render({ tone: "info", text: "Copied." })).toContain('role="status"');
  });

  it("offers a link to sign in to the server a refusal names, in a new tab, and Retry", () => {
    const html = render(
      refusalNote(
        refusalOutcome("docs is not signed in", { code: "MCP_SIGN_IN_REQUIRED", server: "docs" }),
      ),
    );

    expect(html).toContain('href="/sign-in?server=docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Sign in to docs");
    expect(html).toContain(">Retry<");
  });

  it("shows the sign-in as no link until the Session's Environment, which its scope is, is known", () => {
    const html = render(
      refusalNote(
        refusalOutcome("docs is not signed in", { code: "MCP_SIGN_IN_REQUIRED", server: "docs" }),
      ),
      () => undefined,
    );

    expect(html).not.toContain("<a ");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Sign in to docs");
  });

  it("offers neither for a refusal of the arguments or of a size", () => {
    const html = render(refusalNote(refusalOutcome("Too big", { code: "MCP_PROMPT_TOO_LARGE" })));

    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Sign in");
  });
});
