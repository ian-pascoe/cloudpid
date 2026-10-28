// The draft composer's lookups (`session/lookups.ts`) on a Workspace's own DO, with no Session: the Prompt templates and
// Skills of a repo's directory, the Environment's Skills with them, and the `@` menu's files, listed once for requests close
// together.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { FileListings, fileListingsLayer } from "../session/file-search.ts";
import { type WorkspaceLookups, workspaceLookups } from "../session/lookups.ts";
import { uniqueWorkspace } from "./session.workerd.helpers.ts";

const DEPLOY_SKILL =
  "---\nname: deploy\ndescription: Deploy this repo to staging.\n---\n\nRun `./deploy.sh`.\n";

const REVIEW_TEMPLATE =
  "---\ndescription: Review a change\nargument-hint: <ref>\n---\n\nReview $1.\n";

/** Run `use` with the lookups over the test Worker's Workspace DOs; the listings it held, too. */
const withLookups = <A, E>(use: (lookups: WorkspaceLookups) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const listings = yield* FileListings;
    const answer = yield* use(workspaceLookups(env.WORKSPACES, listings));

    return { answer, held: yield* listings.held };
  }).pipe(
    // The test is the lookups' entry point, as the main Worker is.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(fileListingsLayer()),
    Effect.runPromise,
  );

/** Workspace `slug` with a repo `demo` that has a Skill, a Prompt template and a source file. */
const withRepo = async (slug: string) => {
  const workspace = new ComputerExecutionEnv({
    workspace: env.WORKSPACES.getByName(slug),
    id: `computer:${slug}`,
    cwd: "/workspace",
  });

  for (const [path, content] of [
    ["demo/.agents/skills/deploy/SKILL.md", DEPLOY_SKILL],
    ["demo/.agents/prompts/review.md", REVIEW_TEMPLATE],
    ["demo/src/app.ts", "export {};\n"],
  ] as const) {
    getOrThrow(
      await workspace.createDir(
        `/workspace/${path.slice(0, path.lastIndexOf("/"))}`,
        { recursive: true },
        BACKGROUND_CONTEXT,
      ),
    );
    getOrThrow(await workspace.writeFile(path, content, BACKGROUND_CONTEXT));
  }

  return { object: slug, directory: "/workspace/demo" };
};

describe("the draft composer's lookups", () => {
  it("offer a repo's templates and Skills, the Environment's Skills after them, and no commands", async () => {
    const place = await withRepo(uniqueWorkspace());

    await env.WORKSPACES.getByName(place.object).updateSkills({
      hash: "sha256:environment",
      files: {
        "tdd/SKILL.md": "---\nname: tdd\ndescription: Test first.\n---\n\nRed, green.\n",
      },
    });
    const { answer } = await withLookups((lookups) => lookups.catalog(place));

    expect(answer.commands).toEqual([]);
    expect(answer.templates).toEqual([
      { name: "review", description: "Review a change", argumentHint: "<ref>" },
    ]);
    expect(answer.skills[0]).toEqual({
      name: "deploy",
      description: "Deploy this repo to staging.",
    });
    expect(answer.skills.map((skill) => skill.name)).toContain("tdd");
  });

  it("offer the directory's files, listing it once for requests close together", async () => {
    const place = await withRepo(uniqueWorkspace());

    const { answer, held } = await withLookups((lookups) =>
      Effect.all([lookups.files(place, "app.ts"), lookups.files(place, "src/")]),
    );

    expect(answer).toEqual([{ paths: ["src/app.ts"] }, { paths: ["src/", "src/app.ts"] }]);
    expect(held).toEqual([`computer:${place.object}:/workspace/demo`]);
  });
});
