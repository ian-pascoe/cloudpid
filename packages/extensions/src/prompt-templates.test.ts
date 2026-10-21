// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import {
  err,
  FileError,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type FileListEntry,
} from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  discoverPrompts,
  expandTemplate,
  MAX_EXPANDED_FILE_BYTES,
  parseCommandArgs,
  parseTemplate,
  stripFrontmatter,
  substituteArgs,
  templateCall,
} from "./prompt-templates.ts";

/** An environment holding `files` (absolute path to text), answering what discovery asks of one. */
const envOf = (
  cwd: string,
  files: Readonly<Record<string, string>>,
): Pick<ExecutionEnv, "cwd" | "listFiles" | "readTextFile"> => ({
  cwd,
  listFiles: (root) => {
    const prefix = `${root}/`;
    const below = Object.keys(files).filter((path) => path.startsWith(prefix));

    if (below.length === 0) {
      return Promise.resolve(err(new FileError("not_found", "No such directory", root)));
    }

    const entries: FileListEntry[] = [];

    for (const path of below) {
      const relative = path.slice(prefix.length);
      const parts = relative.split("/");

      if (parts.length > 1) entries.push({ path: parts[0]!, kind: "directory" });

      entries.push({ path: relative, kind: "file" });
    }

    return Promise.resolve(ok({ entries, truncated: false }));
  },
  readTextFile: (path) => {
    const text = files[path];

    return Promise.resolve(
      text === undefined ? err(new FileError("not_found", "No such file", path)) : ok(text),
    );
  },
});

describe("parseTemplate", () => {
  it("takes the name from the file, and the description and argument hint from the frontmatter", () => {
    expect(
      parseTemplate(
        "/workspace/app/.agents/prompts/review.md",
        "---\ndescription: Review a change\nargument-hint: <ref> [focus]\n---\n\nReview $1.\n",
      ),
    ).toEqual({
      name: "review",
      description: "Review a change",
      argumentHint: "<ref> [focus]",
      content: "Review $1.",
      filePath: "/workspace/app/.agents/prompts/review.md",
    });
  });

  it("describes a template without a description by its first line, cut to 60 characters", () => {
    const long = "x".repeat(70);

    expect(parseTemplate("/p/a.md", `\n\n  First line\nSecond`)?.description).toBe("  First line");
    expect(parseTemplate("/p/a.md", long)?.description).toBe(`${"x".repeat(60)}...`);
    expect(parseTemplate("/p/a.md", "")?.description).toBe("");
  });

  it("has no argument hint unless the frontmatter gives one", () => {
    expect(parseTemplate("/p/a.md", "Body")).not.toHaveProperty("argumentHint");
  });

  it("skips a file whose frontmatter is not YAML", () => {
    expect(parseTemplate("/p/a.md", "---\ndescription: [unclosed\n---\nBody")).toBeUndefined();
  });

  it("strips a skill's frontmatter, leaving a body without one as it is", () => {
    expect(stripFrontmatter("---\nname: a\ndescription: b\n---\n\n# A\n\nDo it.\n")).toBe(
      "# A\n\nDo it.",
    );
    expect(stripFrontmatter("No frontmatter\r\n")).toBe("No frontmatter\n");
  });
});

describe("parseCommandArgs", () => {
  it("splits on whitespace and groups quotes, as bash does", () => {
    expect(parseCommandArgs(`a  "b c" 'd "e"' f`)).toEqual(["a", "b c", 'd "e"', "f"]);
  });

  it("keeps a quoted empty string", () => {
    expect(parseCommandArgs(`"" x ''`)).toEqual(["", "x", ""]);
  });

  it("has no arguments in blank text", () => {
    expect(parseCommandArgs("  \n ")).toEqual([]);
  });
});

describe("substituteArgs", () => {
  const args = ["one", "two", "three"];

  it("fills positional arguments, a missing one with nothing", () => {
    expect(substituteArgs("$1 then $3 then $4.", args)).toBe("one then three then .");
  });

  it("fills $@ and $ARGUMENTS with every argument", () => {
    expect(substituteArgs("[$@] [$ARGUMENTS]", args)).toBe("[one two three] [one two three]");
  });

  it("uses a default for a missing or empty argument", () => {
    expect(substituteArgs("${2:-x} ${4:-four} ${@:-none}", args)).toBe("two four one two three");
    expect(substituteArgs("${1:-empty} ${@:-none} ${ARGUMENTS:-all}", [""])).toBe("empty none all");
  });

  it("slices the arguments from the Nth, for L of them", () => {
    expect(substituteArgs("${@:2}|${@:1:2}|${@:0}|${@:3:5}", args)).toBe(
      "two three|one two|one two three|three",
    );
  });

  it("does not substitute what an argument brings in", () => {
    expect(substituteArgs("$1 $2", ["$2", "${1:-x}"])).toBe("$2 ${1:-x}");
  });
});

describe("expandTemplate", () => {
  const templates = [{ name: "review", content: "Review $1, focusing on ${@:2}." }];

  it("expands a template's Slash command with its arguments", () => {
    expect(expandTemplate(`/review HEAD~1 "error handling" tests`, templates)).toBe(
      "Review HEAD~1, focusing on error handling tests.",
    );
    expect(expandTemplate("/review\nmain", templates)).toBe("Review main, focusing on .");
  });

  it("names the template a message calls, with its arguments", () => {
    expect(templateCall(`/review a "b c"`, templates)).toEqual({
      template: templates[0],
      args: ["a", "b c"],
    });
    expect(templateCall("/ship", templates)).toBeUndefined();
  });

  it("leaves other text alone", () => {
    expect(expandTemplate("/reviewer x", templates)).toBeUndefined();
    expect(expandTemplate("review x", templates)).toBeUndefined();
    expect(expandTemplate(" /review x", templates)).toBeUndefined();
  });
});

describe("discoverPrompts", () => {
  it("walks .agents/prompts from cwd up to the Workspace root, nearest first, the nearest winning a name", async () => {
    const env = envOf("/workspace/app/web", {
      "/workspace/app/web/.agents/prompts/review.md": "---\ndescription: Web review\n---\nWeb",
      "/workspace/app/.agents/prompts/review.md": "App review",
      "/workspace/app/.agents/prompts/ship.md": "Ship it",
      "/workspace/app/.agents/prompts/notes.txt": "Not a template",
      "/workspace/app/.agents/prompts/nested/deep.md": "Not at the top",
      "/workspace/.agents/prompts/root.md": "Root",
    });

    const found = await Effect.runPromise(discoverPrompts(env));

    expect(
      found.map(({ name, description, filePath }) => ({ name, description, filePath })),
    ).toEqual([
      {
        name: "review",
        description: "Web review",
        filePath: "/workspace/app/web/.agents/prompts/review.md",
      },
      { name: "ship", description: "Ship it", filePath: "/workspace/app/.agents/prompts/ship.md" },
      { name: "root", description: "Root", filePath: "/workspace/.agents/prompts/root.md" },
    ]);
  });

  it("lists no body, and skips a file too big to expand or whose name holds whitespace", async () => {
    const big = "x".repeat(MAX_EXPANDED_FILE_BYTES + 1);

    const env = envOf("/workspace", {
      "/workspace/.agents/prompts/plan.md": "Plan it",
      "/workspace/.agents/prompts/big.md": big,
      "/workspace/.agents/prompts/my plan.md": "Spaced",
    });

    expect(await Effect.runPromise(discoverPrompts(env))).toEqual([
      { name: "plan", description: "Plan it", filePath: "/workspace/.agents/prompts/plan.md" },
    ]);

    // Where the size can be had, a big file is not read at all.
    const read: string[] = [];

    const sized = {
      ...env,
      readTextFile: (path: string, context: Parameters<typeof env.readTextFile>[1]) => {
        read.push(path);

        return env.readTextFile(path, context);
      },
      fileInfo: (path: string) =>
        Promise.resolve(
          ok<FileInfo, FileError>({
            name: path.split("/").at(-1) ?? "",
            path,
            kind: "file" as const,
            size: path.endsWith("big.md") ? big.length : 7,
            mtimeMs: 0,
          }),
        ),
    };

    expect((await Effect.runPromise(discoverPrompts(sized))).map(({ name }) => name)).toEqual([
      "plan",
    ]);
    expect(read).toEqual(["/workspace/.agents/prompts/plan.md"]);
  });

  it("finds none where there is no prompts directory", async () => {
    await expect(Effect.runPromise(discoverPrompts(envOf("/workspace", {})))).resolves.toEqual([]);
  });
});
