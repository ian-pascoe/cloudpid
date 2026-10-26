import { describe, expect, it } from "@effect/vitest";
import { addressOf } from "./address.ts";

describe("what the Browser Pane's URL bar opens", () => {
  it("opens an http or https URL as it is", () => {
    expect(addressOf("https://example.com/a?b=c#d")).toEqual({
      url: "https://example.com/a?b=c#d",
    });
    expect(addressOf("  http://localhost:5173/  ")).toEqual({ url: "http://localhost:5173/" });
  });

  it("opens an address without a scheme over https", () => {
    expect(addressOf("example.com")).toEqual({ url: "https://example.com/" });
    expect(addressOf("docs.example.com/guide?x=1")).toEqual({
      url: "https://docs.example.com/guide?x=1",
    });
    expect(addressOf("localhost:3000/app")).toEqual({ url: "https://localhost:3000/app" });
    expect(addressOf("192.168.1.10:8080")).toEqual({ url: "https://192.168.1.10:8080/" });
  });

  it("opens a blank page", () => {
    expect(addressOf("about:blank")).toEqual({ url: "about:blank" });
  });

  it("refuses text that is not a URL, with a note, rather than guessing at it", () => {
    for (const text of ["", "   ", "cats", "how to bake bread", "example .com", "http://"]) {
      expect(addressOf(text)).toEqual({ refused: expect.stringContaining("not a web address") });
    }
  });

  it("refuses other schemes", () => {
    for (const text of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"]) {
      expect(addressOf(text)).toEqual({ refused: expect.stringContaining("http") });
    }
  });
});
