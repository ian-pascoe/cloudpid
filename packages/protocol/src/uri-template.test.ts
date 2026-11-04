import { describe, expect, it } from "vitest";
import { expandUriTemplate, uriTemplateVariables } from "./uri-template.ts";

describe("uriTemplateVariables", () => {
  it("lists each variable once, in order, and marks those only {?…} and {&…} use as optional", () => {
    expect(uriTemplateVariables("repo://{owner}/{name}{/path*}{?ref,depth}{&ref}")).toEqual([
      { name: "owner", required: true },
      { name: "name", required: true },
      { name: "path", required: true },
      { name: "ref", required: false },
      { name: "depth", required: false },
    ]);

    // One use that needs it makes it required.
    expect(uriTemplateVariables("a://{x}{?x}")).toEqual([{ name: "x", required: true }]);
  });

  it("reads modifiers, dotted names and operators, and leaves a stray brace as text", () => {
    expect(uriTemplateVariables("f://{+path:5}/{#frag}{.ext}{;p}{a.b}{ bad}{")).toEqual([
      { name: "path", required: true },
      { name: "frag", required: true },
      { name: "ext", required: true },
      { name: "p", required: true },
      { name: "a.b", required: true },
    ]);
    expect(uriTemplateVariables("no variables")).toEqual([]);
  });
});

describe("expandUriTemplate", () => {
  const values = { owner: "ian pascoe", name: "cloud/pid", ref: "main", depth: "", path: "a/b c" };

  it("expands each operator as RFC 6570 does", () => {
    expect(expandUriTemplate("repo://{owner}/{name}", values)).toBe(
      "repo://ian%20pascoe/cloud%2Fpid",
    );
    expect(expandUriTemplate("repo://{+path}", values)).toBe("repo://a/b%20c");
    expect(expandUriTemplate("x{#path}", values)).toBe("x#a/b%20c");
    expect(expandUriTemplate("x{.name}", values)).toBe("x.cloud%2Fpid");
    expect(expandUriTemplate("x{/owner,name}", values)).toBe("x/ian%20pascoe/cloud%2Fpid");
    expect(expandUriTemplate("x{;ref}", values)).toBe("x;ref=main");
    expect(expandUriTemplate("x{?ref,depth}", values)).toBe("x?ref=main");
    expect(expandUriTemplate("x?a=1{&ref}", values)).toBe("x?a=1&ref=main");
  });

  it("applies a prefix modifier, encodes what RFC 3986 reserves, and keeps a percent escape under +", () => {
    expect(expandUriTemplate("{owner:3}", values)).toBe("ian");
    expect(expandUriTemplate("{x}", { x: "a!b'c(d)*e" })).toBe("a%21b%27c%28d%29%2Ae");
    expect(expandUriTemplate("{+x}", { x: "a%20b%zz" })).toBe("a%20b%25zz");
  });

  it("leaves out an expression whose variables have no value, and an empty {?…}", () => {
    expect(expandUriTemplate("a/{missing}/b{?depth}", values)).toBe("a//b");
  });

  it("keeps an expression with an unfilled required variable as written when it is partial", () => {
    expect(expandUriTemplate("repo://{owner}/{name}{?ref}", { owner: "ian" }, true)).toBe(
      "repo://ian/{name}",
    );
    expect(expandUriTemplate("repo://{owner}/{name}{?ref}", { owner: "ian", ref: "x" }, true)).toBe(
      "repo://ian/{name}?ref=x",
    );
  });
});
