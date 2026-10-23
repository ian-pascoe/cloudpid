// The `agents-md` extension through real runs over real files: a scripted model reads and changes files under a
// temporary Workspace root, and the tests check what the system prompt and the tool results show, and that nothing a
// request sent before changes in a later one. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalRandom:off nodeBuiltinImport:off -- real files in a temporary directory, as pi-durable's Node environment reads them.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, openHarness } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  AgentsMdDoc,
  agentsMdExtension,
  boundInstructions,
  instructionDirectories,
  MAX_INSTRUCTION_LINES,
  SECTION_KEY,
  SHOWN_DETAILS_KEY,
} from "./agents-md.ts";
import { ContextManagement } from "./context.ts";

const context = BACKGROUND_CONTEXT;

const text = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");

/** A response that calls tools, in order. */
const call = (
  ...calls: ReadonlyArray<readonly [string, ToolCall["arguments"]]>
): AssistantMessage =>
  fauxAssistantMessage(
    calls.map(([name, args], index) =>
      fauxToolCall(name, args, { id: `call-${name}-${index}-${Math.random()}` }),
    ),
    { stopReason: "toolUse" },
  );

/** One request as the provider got it. */
type Request = {
  /** The `project_context` section in effect, if any. */
  readonly section: string | undefined;
  /** The text of every message the request sent, system prompts left out. */
  readonly transcript: ReadonlyArray<string>;
};

/** A script's nested `read`, as a `codemode` script makes it: its result goes to the script, which returns it. */
const Scripts = defineExtension({
  name: "scripts",
  tools: [
    defineTool({
      name: "script_read",
      description: "Read a file as a script would",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (params, api, ctx) => {
        const nested = await api.executeTool("read", { path: params.path }, ctx);

        return {
          output: [
            { type: "text", text: `script got: ${JSON.stringify(nested.structuredOutput)}` },
          ],
        };
      },
    }),
  ],
});

/** A Workspace root in a temporary directory, with `files` (relative path to text) written in it. */
const workspaceOf = async (files: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "agents-md-"));

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

/**
 * Open a Harness over `root` whose conversation works in `cwd` (relative to `root`) with pi-durable's `read`, `edit` and
 * `write`, the context tools, and the `agents-md` extension, and whose model answers with `steps` in order, then "Done.".
 */
const open = async (
  root: string,
  cwd: string,
  steps: ReadonlyArray<
    AssistantMessage | ((request: Request) => AssistantMessage | Promise<AssistantMessage>)
  >,
  /** The environment each call gets, from the Node one over `root`. */
  envOf: (env: NodeExecutionEnv) => ExecutionEnv = (env) => env,
) => {
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const models = createModels();
  const requests: Request[] = [];

  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 50 }, () => (transcript: { readonly messages: readonly Message[] }) => {
      let section: string | undefined;

      for (const message of transcript.messages) {
        if (
          message.role === "system" &&
          message.sections !== undefined &&
          SECTION_KEY in message.sections
        ) {
          section = message.sections[SECTION_KEY] ?? undefined;
        }
      }

      const request: Request = {
        section,
        transcript: transcript.messages
          .filter((message) => message.role !== "system")
          .map((message) => text(message.content)),
      };

      requests.push(request);

      const step = steps[requests.length - 1];

      return step === undefined
        ? fauxAssistantMessage("Done.")
        : Predicate.isFunction(step)
          ? step(request)
          : step;
    }),
  );

  const service = await Effect.runPromise(
    openHarness(new MemoryStorage(), {
      models,
      env: () => envOf(new NodeExecutionEnv({ cwd: join(root, cwd) })),
    }),
  );

  const extensions = await Effect.runPromise(
    Effect.all([agentsMdExtension({ root }), ContextManagement]).pipe(
      Effect.provide(Context.make(Harness, service)),
    ),
  );

  const coding = defineExtension({
    name: "coding",
    tools: [createReadTool(), createEditTool(), createWriteTool()],
  });

  // The tools first: a wrap applies to the tools installed before it.
  for (const extension of [coding, Scripts, ...extensions]) {
    await Effect.runPromise(service.install(extension));
  }

  const { harness } = service;

  const conversation = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  await (await conversation.submit({ type: "input", content: "Go" }, context)).wait(context);
  await harness.waitForIdle(context);

  /** Every tool result of the root conversation, oldest first: its text and its details. */
  const results = async () => {
    const page = await (await harness.conversation(ROOT_CONVERSATION_ID, context))!.entries(
      { order: "ascending" },
      500,
      undefined,
      context,
    );

    return page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult"
          ? [{ name: message.toolName, text: text(message.content), details: message.details }]
          : [],
      ),
    );
  };

  const shown = async () =>
    (await harness.snapshot(AgentsMdDoc, ROOT_CONVERSATION_ID, context))?.shown ?? {};

  return { requests, results, shown };
};

const ADDED_HEADER = "Project instructions that apply to";

describe("instructionDirectories", () => {
  it("lists the root, each directory between, and the directory, the farthest first", () => {
    expect(instructionDirectories("/workspace/repo/packages/app")).toEqual([
      "/workspace",
      "/workspace/repo",
      "/workspace/repo/packages",
      "/workspace/repo/packages/app",
    ]);
    expect(instructionDirectories("/workspace/")).toEqual(["/workspace"]);
    expect(instructionDirectories("/elsewhere/project")).toEqual(["/elsewhere/project"]);
    expect(instructionDirectories("/tmp/x/y", "/tmp/x")).toEqual(["/tmp/x", "/tmp/x/y"]);
  });
});

describe("boundInstructions", () => {
  it("keeps a file within its bounds and says how much there is", () => {
    const long = Array.from(
      { length: MAX_INSTRUCTION_LINES + 5 },
      (_, index) => `line ${index}`,
    ).join("\n");

    const bounded = boundInstructions("/w/AGENTS.md", long);

    expect(bounded.split("\n")).toHaveLength(MAX_INSTRUCTION_LINES + 1);
    expect(bounded.split("\n").at(-1)).toBe(
      `[/w/AGENTS.md is longer than shown here (${long.length} characters, ${MAX_INSTRUCTION_LINES + 5} lines): read it for the rest.]`,
    );
    expect(boundInstructions("/w/AGENTS.md", "short")).toBe("short");
  });
});

describe("the project_context section", () => {
  it("shows the instructions of the cwd and of each directory above it up to the root, the farthest first", async () => {
    const root = await workspaceOf({
      "AGENTS.md": "Workspace rules.",
      "repo/AGENTS.md": "Repo rules.",
      // The first name in the list wins.
      "repo/pkg/AGENTS.override.md": "Package override.",
      "repo/pkg/CLAUDE.md": "Not this one.",
      "repo/pkg/deeper/AGENTS.md": "Below the cwd: not in the section.",
      "elsewhere/AGENTS.md": "Not above the cwd.",
    });

    const { requests } = await open(root, "repo/pkg", []);

    expect(requests[0]!.section).toBe(
      [
        `<${SECTION_KEY}>`,
        "Project-specific instructions and guidelines from AGENTS.md files. Each applies to the files in its directory and below; where two disagree, the nearer one wins. When you read or change a file in a directory with instructions of its own, they are added to that tool's result: follow them too.",
        "",
        `<project_instructions path="${root}/AGENTS.md">\nWorkspace rules.\n</project_instructions>`,
        "",
        `<project_instructions path="${root}/repo/AGENTS.md">\nRepo rules.\n</project_instructions>`,
        "",
        `<project_instructions path="${root}/repo/pkg/AGENTS.override.md">\nPackage override.\n</project_instructions>`,
        `</${SECTION_KEY}>`,
      ].join("\n"),
    );
  });

  it("is left out where there are no instructions", async () => {
    const root = await workspaceOf({ "repo/README.md": "hi" });

    const { requests } = await open(root, "repo", []);

    expect(requests[0]!.section).toBeUndefined();
  });

  it("stays the same when an AGENTS.md changes, and the change is shown in the result of the call that made it", async () => {
    const root = await workspaceOf({ "repo/AGENTS.md": "Use tabs." });
    const path = join(root, "repo/AGENTS.md");

    const { requests, results } = await open(root, "repo", [
      call(["edit", { path, edits: [{ oldText: "tabs", newText: "spaces" }] }]),
      call(["read", { path: "src/index.ts" }]),
    ]);

    expect(await readFile(path, "utf8")).toBe("Use spaces.");
    // The system prompt is the head of every request: it may not change, or the provider's cache starts over.
    expect(requests.map((request) => request.section)).toEqual(
      requests.map(() => requests[0]!.section),
    );
    expect(requests[0]!.section).toContain("Use tabs.");

    const [edit, read] = await results();

    expect(edit!.text).toContain(
      `[${path} holds the project instructions for ${join(root, "repo")}: what it says now replaces what it said before.]`,
    );
    // The edit's result showed the new text, so a later touch adds nothing.
    expect(read!.text).not.toContain(ADDED_HEADER);
  });
});

describe("read, edit and write", () => {
  it("add the instructions of a directory below the cwd to the result, once", async () => {
    const root = await workspaceOf({
      "repo/AGENTS.md": "Repo rules.",
      "repo/web/AGENTS.md": "Web rules.",
      "repo/web/src/a.ts": "a",
      "repo/web/src/b.ts": "b",
    });

    const { requests, results, shown } = await open(root, "repo", [
      call(["read", { path: "web/src/a.ts" }]),
      call(["read", { path: "web/src/b.ts" }]),
      call(["write", { path: "web/src/c.ts", content: "c" }]),
    ]);

    const [first, second, third] = await results();
    const web = join(root, "repo/web/AGENTS.md");

    expect(first!.text).toBe(
      [
        "a",
        "",
        `[Project instructions that apply to ${join(root, "repo/web/src/a.ts")}, from AGENTS.md files: added by the agents-md extension, not part of the tool's output. Each applies to the files in its directory and below; where two disagree, the nearer one wins.]`,
        `<project_instructions path="${web}">\nWeb rules.\n</project_instructions>`,
      ].join("\n"),
    );
    // The repo's instructions are in the section already.
    expect(first!.text).not.toContain("Repo rules.");
    expect(first!.details).toMatchObject({ [SHOWN_DETAILS_KEY]: { [web]: expect.any(String) } });
    expect(second!.text).toBe("b");
    expect(third!.text).not.toContain(ADDED_HEADER);

    // Every request starts with what the one before it sent: results are only ever added at the end.
    for (const [index, request] of requests.entries()) {
      if (index === 0) continue;

      expect(request.transcript.slice(0, requests[index - 1]!.transcript.length)).toEqual(
        requests[index - 1]!.transcript,
      );
    }

    expect(Object.keys(await shown()).sort()).toEqual([join(root, "repo/AGENTS.md"), web].sort());
  });

  it("add a directory's instructions again when they changed since they were shown", async () => {
    const root = await workspaceOf({
      "repo/web/AGENTS.md": "Web rules.",
      "repo/web/a.ts": "a",
    });

    const web = join(root, "repo/web/AGENTS.md");

    const { results } = await open(root, "repo", [
      call(["read", { path: "web/a.ts" }]),
      async () => {
        // Changed outside the agent's tools, as a `git pull` would.
        await writeFile(web, "New web rules.");

        return call(["read", { path: "web/a.ts" }]);
      },
      call(["read", { path: "web/a.ts" }]),
    ]);

    const [, second, third] = await results();

    expect(second!.text).toContain(
      `[The instructions in ${web} changed since they were shown: these replace them.]\n<project_instructions path="${web}">\nNew web rules.\n</project_instructions>`,
    );
    expect(third!.text).toBe("a");
  });

  it("add nothing to a read of the instructions file itself, nor to a failed call", async () => {
    const root = await workspaceOf({ "repo/web/AGENTS.md": "Web rules." });

    const { results } = await open(root, "repo", [
      call(["read", { path: "web/AGENTS.md" }]),
      call(["read", { path: "web/missing.ts" }]),
    ]);

    const [own, missing] = await results();

    expect(own!.text).toBe("Web rules.");
    expect(missing!.text).not.toContain(ADDED_HEADER);
  });

  it("add nothing to a script's call, whose result is not in the context", async () => {
    const root = await workspaceOf({ "repo/web/AGENTS.md": "Web rules.", "repo/web/a.ts": "a" });

    const { results, shown } = await open(root, "repo", [
      call(["script_read", { path: "web/a.ts" }]),
      call(["read", { path: "web/a.ts" }]),
    ]);

    const [script, read] = await results();

    expect(script!.text).not.toContain("Web rules.");
    expect(read!.text).toContain("Web rules.");
    expect(Object.keys(await shown())).toEqual([join(root, "repo/web/AGENTS.md")]);
  });

  it("keep the instructions after a read that fills the tool's output limit", async () => {
    const big = Array.from({ length: 3_000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join(
      "\n",
    );

    const root = await workspaceOf({ "repo/web/AGENTS.md": "Web rules.", "repo/web/big.txt": big });

    const { results } = await open(root, "repo", [call(["read", { path: "web/big.txt" }])]);

    const [read] = await results();

    expect(read!.text).toContain("Use offset=");
    expect(read!.text).toContain("Web rules.\n</project_instructions>");
  });

  it("ask an environment that finds instructions itself, once a lookup, and read no file for them", async () => {
    const root = await workspaceOf({ "repo/web/a.ts": "a" });
    const asked: string[] = [];

    const { requests, results } = await open(
      root,
      "repo",
      [call(["read", { path: "web/a.ts" }])],
      (env) =>
        Object.assign(env, {
          discoverInstructions: async (directory: string) => {
            asked.push(directory);

            return [
              { path: "/virtual/AGENTS.md", directory: "/virtual", content: "Virtual rules." },
              ...(directory.endsWith("/web")
                ? [{ path: `${directory}/AGENTS.md`, directory, content: "Web rules." }]
                : []),
            ];
          },
        }),
    );

    const [read] = await results();

    expect(asked).toEqual([join(root, "repo"), join(root, "repo/web")]);
    expect(requests[0]!.section).toContain("Virtual rules.");
    // The section shows the first file already; only the web directory's is new.
    expect(read!.text).toContain("Web rules.");
    expect(read!.text).not.toContain("Virtual rules.");
  });

  it("add a directory's instructions again after a Handoff took the result that showed them out", async () => {
    const root = await workspaceOf({ "repo/web/AGENTS.md": "Web rules.", "repo/web/a.ts": "a" });

    const { requests, results, shown } = await open(root, "repo", [
      call(["read", { path: "web/a.ts" }]),
      call(["context_rollover", { handoff: "Keep going with web/a.ts." }]),
      call(["read", { path: "web/a.ts" }]),
    ]);

    const reads = (await results()).filter((result) => result.name === "read");

    expect(reads.map((result) => result.text.includes("Web rules."))).toEqual([true, true]);
    expect(requests.at(-1)!.transcript[0]).toContain("Keep going with web/a.ts.");
    expect(Object.keys(await shown())).toEqual([join(root, "repo/web/AGENTS.md")]);
  });
});
