import { expect, it } from "vitest";
import { extensionName as subagents } from "@cloudpid/extensions/subagents";
import { extensionName as context } from "@cloudpid/extensions/context";
import { extensionName as todo } from "@cloudpid/extensions/todo";
import { extensionName as web } from "@cloudpid/extensions/web";
import { extensionName as secrets } from "@cloudpid/extensions/secrets";
import { extensionName as browser } from "@cloudpid/extensions/browser";

it("exposes one subpath export per extension", () => {
  expect([subagents, context, todo, web, secrets, browser]).toEqual([
    "subagents",
    "context",
    "todo",
    "web",
    "secrets",
    "browser",
  ]);
});
