import type {
  ConversationId,
  ElicitationForm,
  McpElicitationPage,
  McpElicitationRequest,
} from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { McpElicitationCard } from "./mcp-elicitation-card.tsx";
import { elicitationLine } from "./mcp-elicitation-detail.ts";
import {
  countdown,
  enteredOf,
  initialValues,
  ownValue,
  refusalOf,
  sourceLabel,
  timeZoneName,
  toRfc3339,
} from "./mcp-elicitation-form.ts";

const FORM: ElicitationForm = {
  fields: [
    { kind: "text", name: "name", title: "Your name", required: true, default: "Ada" },
    { kind: "email", name: "mail", required: false },
    { kind: "url", name: "site", required: false },
    { kind: "date", name: "born", required: false },
    { kind: "date_time", name: "at", required: false },
    { kind: "integer", name: "count", required: false, min: 1, max: 9 },
    { kind: "number", name: "ratio", required: false },
    { kind: "boolean", name: "agree", required: false, default: true },
    {
      kind: "choice",
      name: "size",
      required: true,
      options: [
        { value: "s", title: "Small" },
        { value: "l", title: "Large" },
      ],
    },
    {
      kind: "choice",
      name: "colour",
      required: false,
      options: Array.from({ length: 6 }, (_, i) => ({ value: `c${i}`, title: `Colour ${i}` })),
    },
    {
      kind: "multi_choice",
      name: "tags",
      required: false,
      options: [
        { value: "a", title: "A" },
        { value: "b", title: "B" },
      ],
      default: ["a"],
    },
    { kind: "text", name: "bio", required: false, maxLength: 500 },
  ],
};

const request = (
  form: ElicitationForm,
  more: Partial<McpElicitationRequest> = {},
): McpElicitationRequest => ({
  id: "call-1:7",
  callId: "call-1",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  server: "github",
  tool: "mcp__github__create_issue",
  message: "Tell me about the issue",
  form,
  notes: [],
  deadline: 10 * 60 * 1000 + 1000,
  ...more,
});

const render = (req: McpElicitationRequest, disabled = false, agent?: string) =>
  renderToStaticMarkup(
    <McpElicitationCard
      request={req}
      disabled={disabled}
      agent={agent}
      now={1000}
      onAnswer={() => Promise.resolve(null)}
    />,
  );

describe("McpElicitationCard", () => {
  it("names the server, shows the message as plain text, and the standing footer", () => {
    const markup = render(request(FORM, { message: "<b>bold</b> **x**" }));

    expect(markup).toContain("github asks for your input");
    expect(markup).toContain("&lt;b&gt;bold&lt;/b&gt; **x**");
    expect(markup).not.toContain("<b>bold</b>");
    expect(markup).toContain(
      "Only github gets what you enter, and its reply to the agent may repeat it. Never enter a password or key here.",
    );
    expect(markup).toContain("github&#x27;s call ends in 10:00");
  });

  it("shows no countdown for a Modern server's question, which waits for the owner with no deadline", () => {
    // Its `deadline` is far off, for a client from before `waits`: the card ignores it.
    const markup = render({ ...request(FORM), waits: "owner" });

    expect(markup).toContain("github waits for your answer");
    expect(markup).not.toContain("call ends in");
  });

  it("says a prompt send's question is from getting the prompt, with a countdown to the get going on", () => {
    const markup = render(
      request(FORM, {
        prompt: "Review PR",
        tool: "/mcp__github__review",
        deadline: 5 * 60 * 1000 + 1000,
      }),
      false,
      "reviewer (checks)",
    );

    expect(markup).toContain("getting prompt Review PR");
    expect(markup).not.toContain("during");
    expect(markup).not.toContain("subagent");
    expect(markup).toContain("github&#x27;s prompt goes on without an answer in 5:00");
    expect(markup).not.toContain("call ends in");
  });

  it("draws a widget per kind, prefills defaults and marks required fields", () => {
    const markup = render(request(FORM));

    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="Ada"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="url"');
    expect(markup).toContain('type="date"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="1"');
    expect(markup).toContain('max="9"');
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    // Two options: radios. Six: a select. A multi choice: a checkbox group with its default checked.
    expect(markup).toContain('type="radio"');
    expect(markup).toContain("<select");
    expect(markup).toContain("Colour 5");
    expect(markup).toContain('role="group"');
    // A long text is a textarea.
    expect(markup).toContain("<textarea");
    expect(markup.match(/text-destructive">\*/g)?.length).toBe(2);
  });

  it("says which agent asked, and where the server's definition is", () => {
    expect(render(request(FORM))).toContain("· the agent");
    expect(render(request(FORM), false, "reviewer (checks)")).toContain(
      "· subagent reviewer (checks)",
    );
    expect(render(request(FORM, { source: { kind: "global" } }))).toContain(">Global<");
    expect(render(request(FORM, { source: { kind: "environment" } }))).toContain(
      ">This environment<",
    );
    expect(
      render(request(FORM, { source: { kind: "repo", slug: "ian-pascoe/cloudpid" } })),
    ).toContain(">from ian-pascoe/cloudpid<");
    expect(render(request(FORM))).not.toContain("rounded border px-1");
  });

  it("names the time zone a date and time is read in", () => {
    expect(render(request(FORM))).toContain(`In your time zone, ${timeZoneName()}`);
    expect(
      render(request({ fields: [{ kind: "text", name: "a", required: false }] })),
    ).not.toContain("time zone");
  });

  it("tells assistive technology what is required, and names each group", () => {
    const markup = render(request(FORM));

    // The text field is required; the optional email is not.
    expect(markup).toMatch(
      /<input[^>]*aria-required="true"[^>]*value="Ada"|<input[^>]*value="Ada"[^>]*aria-required="true"/,
    );
    expect(markup).toMatch(
      /role="radiogroup"[^>]*aria-required="true"|aria-required="true"[^>]*role="radiogroup"/,
    );

    // A group is named by its title, which is no `label` for an input that is not there.
    const groups = markup.match(/<div role="(?:radio)?group"[^>]*aria-labelledby="([^"]+)"/g) ?? [];

    expect(groups).toHaveLength(2);

    for (const group of groups) {
      const [, labelled = ""] = /aria-labelledby="([^"]+)"/.exec(group) ?? [];

      expect(markup).toContain(`<span id="${labelled}"`);
      expect(markup).not.toContain(`<label id="${labelled}"`);
    }
  });

  it("describes a field by its note and zone, and survives a field named constructor", () => {
    const form: ElicitationForm = {
      fields: [
        { kind: "text", name: "constructor", description: "Who", required: true },
        { kind: "text", name: "__proto__", required: false },
      ],
    };

    const markup = render(request(form));

    expect(markup).toContain("Who");
    expect(markup).toMatch(/aria-describedby="[^"]*-f0-description"/);
    expect(markup).not.toContain('role="alert"');
    expect(ownValue({}, "constructor")).toBeUndefined();
  });

  it("starts with Submit off while a required field is empty, and on once the form is valid", () => {
    const needs = render(request(FORM));

    expect(needs).toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/,
    );

    const simple: ElicitationForm = {
      fields: [{ kind: "text", name: "name", required: true, default: "Ada" }],
    };

    expect(render(request(simple))).not.toMatch(/type="submit"[^>]*disabled/);
  });

  it("offers Accept and Decline for a form with no fields, and Cancel that closes quietly", () => {
    const markup = render(request({ fields: [] }));

    expect(markup).toContain(">Accept<");
    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Closes without answering; github may ask again");
    expect(markup).not.toContain(">Submit<");
  });

  it("is off and reads Reconnecting… while the Session is not live", () => {
    const markup = render(request({ fields: [] }), true);

    expect(markup).toContain("Reconnecting…");
    expect(markup).not.toContain("call ends in");
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("a form's values", () => {
  it("start from the defaults and are entered as JSON types", () => {
    expect(enteredOf(FORM, initialValues(FORM))).toMatchObject({
      name: "Ada",
      agree: true,
      tags: ["a"],
      count: "",
    });
    expect(
      enteredOf(FORM, { ...initialValues(FORM), count: "3", ratio: "2.5", size: "s" }),
    ).toMatchObject({ count: 3, ratio: 2.5, size: "s" });
  });

  it("send a date and time as RFC 3339 with the zone's offset", () => {
    expect(toRfc3339("2025-03-04T05:06", 120)).toBe("2025-03-04T05:06:00+02:00");
    expect(toRfc3339("2025-03-04T05:06", -330)).toBe("2025-03-04T05:06:00-05:30");
    expect(toRfc3339("2025-03-04T05:06", 0)).toBe("2025-03-04T05:06:00+00:00");
    expect(toRfc3339("", 0)).toBe("");
  });

  it("count down to the deadline as m:ss", () => {
    expect(countdown(10 * 60 * 1000, 0)).toBe("10:00");
    expect(countdown(552_000, 0)).toBe("9:12");
    expect(countdown(1000, 5000)).toBe("0:00");
  });
});

describe("a refused answer", () => {
  const form: ElicitationForm = {
    fields: [
      { kind: "text", name: "name", required: true },
      { kind: "text", name: "a: b", required: false },
    ],
  };

  it("is marked on the field the Session names", () => {
    expect(refusalOf(form, "name: matches one of your Secrets")).toEqual({
      field: "name",
      text: "matches one of your Secrets",
    });
    expect(refusalOf(form, "name: is required")).toEqual({ field: "name", text: "is required" });
  });

  it("takes the longest field name, and a message that names none as the card's", () => {
    expect(refusalOf(form, "a: b: is too long")).toEqual({ field: "a: b", text: "is too long" });
    expect(refusalOf(form, "This request ended")).toEqual({ text: "This request ended" });
    expect(refusalOf(form, "The answer does not fit the form")).toEqual({
      text: "The answer does not fit the form",
    });
  });
});

describe("where a server is defined", () => {
  it("is Global, This environment, or the Repo's name; nothing for a kind not known", () => {
    expect(sourceLabel({ kind: "global" })).toBe("Global");
    expect(sourceLabel({ kind: "environment" })).toBe("This environment");
    expect(sourceLabel({ kind: "repo", slug: "a/b" })).toBe("from a/b");
    expect(sourceLabel({ kind: "repo" })).toBeUndefined();
    expect(sourceLabel({ kind: "future" })).toBeUndefined();
    expect(sourceLabel(undefined)).toBeUndefined();
  });
});

const PAGE: McpElicitationPage = {
  url: "https://login.Example.com/auth?x=1&y=2",
  host: "login.example.com",
  domain: "example.com",
  opened: false,
};

const renderPage = (
  page: McpElicitationPage,
  more: Partial<McpElicitationRequest> = {},
  retryReady = false,
  disabled = false,
) =>
  renderToStaticMarkup(
    <McpElicitationCard
      request={request({ fields: [] }, { message: "Sign in to <b>continue</b>", page, ...more })}
      disabled={disabled}
      retryReady={retryReady}
      now={1000}
      onAnswer={() => Promise.resolve(null)}
    />,
  );

describe("McpElicitationCard, a page to open", () => {
  it("shows the address as plain text with its domain emphasized, and an Open link that leaves no opener", () => {
    const markup = renderPage(PAGE);

    expect(markup).toContain("github asks you to open a page");
    expect(markup).toContain("Sign in to &lt;b&gt;continue&lt;/b&gt;");
    expect(markup).toContain("https://login.<strong");
    expect(markup).toContain(">Example.com</strong>/auth?x=1&amp;y=2");
    expect(markup).toContain('href="https://login.Example.com/auth?x=1&amp;y=2"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(">Open<");
    expect(markup).toContain("github&#x27;s call ends in 10:00");
    expect(markup).not.toContain(">Submit<");
    // The spec has no footer for a page: the domain emphasis is the defence.
    expect(markup).not.toContain("Never enter a password");
  });

  it("reads Opened once a page the server goes on from by itself is opened, with Open again and no Decline", () => {
    const markup = renderPage({ ...PAGE, opened: true }, { waits: "owner" });

    expect(markup).toContain("Opened · github goes on when you finish there");
    expect(markup).toContain(">Open again<");
    expect(markup).not.toContain(">Decline<");
    expect(markup).not.toContain("Done, try again");
  });

  it("reads Finished at the host, with nothing to press, once the server says the owner finished", () => {
    const markup = renderPage({ ...PAGE, opened: true, finished: true });

    expect(markup).toContain("Finished at login.example.com");
    expect(markup).toContain("github goes on");
    expect(markup).not.toContain(">Open");
    expect(markup).not.toContain(">Decline<");
  });

  it("offers Done, try again for a page that is sent again, on only once every page is opened", () => {
    const early = renderPage({ ...PAGE, retry: true });
    const ready = renderPage({ ...PAGE, retry: true, opened: true }, {}, true);

    expect(early).toMatch(/<button[^>]*disabled=""[^>]*>Done, try again/);
    expect(early).toContain(">Decline<");
    expect(early).toContain(">Cancel<");
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Done, try again/);
    expect(ready).toContain(">Done, try again<");
    expect(ready).toContain("press Done when you have finished at login.example.com");
  });

  it("offers Decline on a Modern server's page only until it is opened; Cancel stays", () => {
    const early = renderPage({ ...PAGE, retry: true, era: "modern" });
    const opened = renderPage({ ...PAGE, retry: true, era: "modern", opened: true }, {}, true);
    const legacy = renderPage({ ...PAGE, retry: true, era: "legacy", opened: true }, {}, true);

    expect(early).toContain(">Decline<");
    expect(opened).not.toContain(">Decline<");
    expect(opened).toContain(">Cancel<");
    expect(opened).toContain(">Done, try again<");
    // A Legacy `-32042`'s Decline is offered throughout, and so is an era this version does not know's.
    expect(legacy).toContain(">Decline<");
    expect(renderPage({ ...PAGE, retry: true, era: "unknown", opened: true }, {}, true)).toContain(
      ">Decline<",
    );
  });

  it("says the server asked for the page again, and warns about a look-alike host", () => {
    const markup = renderPage({ ...PAGE, again: true, warning: "mixed_script" });

    expect(markup).toContain("Not finished at login.example.com yet");
    expect(markup).toContain("mixes writing systems");
    expect(renderPage({ ...PAGE, warning: "idn" })).toContain("internationalized address");
  });

  it("turns Open into an off button while the Session is not live", () => {
    const markup = renderPage(PAGE, {}, false, true);

    expect(markup).toContain("Reconnecting…");
    expect(markup).not.toContain("<a ");
  });
});

describe("what a call's card says of a page", () => {
  const shown = { server: "github", by: "owner", fields: [], mode: "url", host: "example.com" };

  it("names the host, never the address", () => {
    expect(elicitationLine({ ...shown, action: "accept" })).toBe(
      "You opened a page on example.com for github",
    );
    expect(elicitationLine({ ...shown, action: "decline" })).toBe(
      "You declined github's request to open a page on example.com",
    );
    expect(
      elicitationLine({
        ...shown,
        action: "decline",
        by: "cloudpid",
        reason: "it is a cloudpid page",
      }),
    ).toBe(
      "cloudpid declined github's request to open a page on example.com: it is a cloudpid page",
    );
    expect(elicitationLine({ ...shown, action: "accept", finished: true })).toBe(
      "You opened a page on example.com for github; finished there",
    );
  });
});
