import { describe, expect, it } from "vitest";
import { detectTrigger, parseCommand, replaceTrigger } from "./completion.ts";

describe("detecting a trigger before the caret", () => {
  it("finds a command at the start of the message", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "command", start: 0, end: 1, query: "" });
    expect(detectTrigger("/mod", 4)).toEqual({ kind: "command", start: 0, end: 4, query: "mod" });
  });

  it("takes the whole command word, past the caret", () => {
    expect(detectTrigger("/model", 3)).toEqual({
      kind: "command",
      start: 0,
      end: 6,
      query: "mo",
    });
  });

  it("finds no command after the start, nor a path", () => {
    expect(detectTrigger("see /model", 10)).toBeNull();
    expect(detectTrigger("/tmp/x", 6)).toBeNull();
    expect(detectTrigger(" /model", 7)).toBeNull();
  });

  it("finds a command's argument once a space follows its name", () => {
    expect(detectTrigger("/model op", 9)).toEqual({
      kind: "argument",
      command: "model",
      start: 7,
      end: 9,
      query: "op",
    });
    expect(detectTrigger("/model ", 7)).toEqual({
      kind: "argument",
      command: "model",
      start: 7,
      end: 7,
      query: "",
    });
  });

  it("finds no argument past the first one", () => {
    expect(detectTrigger("/name a b", 9)).toBeNull();
  });

  it("finds a skill at the start of a word", () => {
    expect(detectTrigger("$", 1)).toEqual({ kind: "skill", start: 0, end: 1, query: "" });
    expect(detectTrigger("use $td and", 7)).toEqual({
      kind: "skill",
      start: 4,
      end: 7,
      query: "td",
    });
    expect(detectTrigger("line\n$tdd", 9)).toEqual({
      kind: "skill",
      start: 5,
      end: 9,
      query: "tdd",
    });
  });

  it("finds no skill inside a word", () => {
    expect(detectTrigger("a$b", 3)).toBeNull();
  });

  it("finds a file at the start of a word, with slashes and dots in it", () => {
    expect(detectTrigger("open @src/app.t", 15)).toEqual({
      kind: "file",
      start: 5,
      end: 15,
      query: "src/app.t",
    });
    expect(detectTrigger("@", 1)).toEqual({ kind: "file", start: 0, end: 1, query: "" });
  });

  it("finds no file in an email address", () => {
    expect(detectTrigger("me@example.com", 14)).toBeNull();
  });

  it("finds nothing once the caret leaves the word", () => {
    expect(detectTrigger("$tdd ", 5)).toBeNull();
    expect(detectTrigger("@a b", 4)).toBeNull();
  });

  it("finds nothing inside inline code", () => {
    expect(detectTrigger("run `$HOM", 9)).toBeNull();
    expect(detectTrigger("`a` $td", 7)).toEqual({ kind: "skill", start: 4, end: 7, query: "td" });
  });
});

describe("replacing a trigger with a pick", () => {
  it("can leave the trigger open, with no space and the caret right after the pick", () => {
    expect(replaceTrigger("see @sr now", { start: 4, end: 7 }, "@src/", { space: false })).toEqual({
      text: "see @src/ now",
      caret: 9,
    });
    expect(replaceTrigger("@sr", { start: 0, end: 3 }, "@src/", { space: false })).toEqual({
      text: "@src/",
      caret: 5,
    });
  });

  it("puts the pick and a space in place of the trigger, and the caret after them", () => {
    expect(replaceTrigger("/mo", { start: 0, end: 3 }, "/model")).toEqual({
      text: "/model ",
      caret: 7,
    });
    expect(replaceTrigger("use $td now", { start: 4, end: 7 }, "$tdd")).toEqual({
      text: "use $tdd now",
      caret: 9,
    });
  });
});

describe("parsing a command message", () => {
  it("splits the name from its arguments", () => {
    expect(parseCommand("/name Fix the build ")).toEqual({ name: "name", args: "Fix the build" });
    expect(parseCommand("/stop")).toEqual({ name: "stop", args: "" });
    expect(parseCommand("/compact\nfocus on tests")).toEqual({
      name: "compact",
      args: "focus on tests",
    });
  });

  it("is null for a message that is not a command", () => {
    expect(parseCommand("hello /stop")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/tmp/file is missing")).toBeNull();
  });
});
