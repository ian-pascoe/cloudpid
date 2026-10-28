// Updating installed Skills, and the daily check that marks them, over real Durable Object SQLite (ADR-0026, docs/architecture/workspace.md →
// Installing from GitHub → Updates): a save over an installed Skill marks it modified, an update moves it to the ref's
// latest commit as an Agent change (and refuses a modified one unless asked to overwrite), a revert brings back the files,
// the source and the mark, and the check marks the Skills whose folder moved with one request for each repo and ref.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- fakes of GitHub and the Registry over native arrays.
import { MAX_FILE_BYTES, MAX_SKILL_SET_BYTES } from "@cloudpid/extensions/skill-checks";
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT, type SkillUpdatePin } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GithubReadError, type RepoReader } from "../github/skill-fetch.ts";
import { fakeGithub, type Files, skillMd } from "../github/skill-repo.fixture.ts";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import { installSkills } from "./skill-install.ts";
import {
  checkSkillUpdates,
  previewSkillUpdates,
  runDailySkillCheck,
  SKILL_CHECK_DOCUMENT,
  SKILL_CHECK_INTERVAL_MS,
  updateSkills,
} from "./skill-updates.ts";
import { hashFiles, openSkills, saveSkillAs, type SkillChangeContext } from "./skills.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_skill_update",
  reason: "The user asked for the latest grill-me",
};

const REPO = "o/skills";

const files = (extra: Files = {}, body = "Steps."): Files => ({
  "skills/grill-me/SKILL.md": skillMd("grill-me", body),
  "skills/grill-me/references/questions.md": "- why?\n",
  "skills/tdd/SKILL.md": skillMd("tdd"),
  "README.md": "A repo of Skills.\n",
  ...extra,
});

/** Run `body` over a fresh Registry's store, Skills and Agent changes, with a fake GitHub. */
const inRegistry = <A>(
  body: (registry: {
    readonly github: ReturnType<typeof fakeGithub>;
    readonly skills: ReturnType<typeof openSkills>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly storage: DurableObjectStorage;
    readonly context: (at: number) => SkillChangeContext;
    readonly install: (
      source: string,
      options?: { environment?: string; owner?: boolean; at?: number; reader?: RepoReader },
    ) => Promise<void>;
    readonly update: (
      request: Omit<Parameters<typeof updateSkills>[2], "author" | "overwrite"> & {
        overwrite?: boolean;
        owner?: boolean;
        at?: number;
      },
    ) => ReturnType<typeof updateSkills>;
    readonly preview: (
      request: Omit<Parameters<typeof previewSkillUpdates>[2], "overwrite"> & {
        overwrite?: boolean;
      },
    ) => ReturnType<typeof previewSkillUpdates>;
    /** The agent's save of a Skill from a Workspace folder: no source given. */
    readonly edit: (name: string, files: Files, at?: number, environment?: string) => Promise<void>;
    readonly revert: (
      id: number,
      at?: number,
      environment?: string,
    ) => ReturnType<typeof revertAgentChange>;
    readonly check: () => ReturnType<typeof checkSkillUpdates>;
    readonly daily: (at: number) => ReturnType<typeof runDailySkillCheck>;
  }) => Promise<A>,
  github = fakeGithub(),
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const changes = openAgentChanges(state.storage);
      const skills = openSkills(state.storage);

      store.createEnvironment("0000abcd", "Other", 1_000);

      const context = (now: number): SkillChangeContext => ({
        storage: state.storage,
        store,
        skills,
        changes,
        now,
      });

      return body({
        github,
        skills,
        changes,
        storage: state.storage,
        context,
        install: async (source, { environment, owner = false, at = 1_000, reader } = {}) => {
          // The Skills kept Global are installed by the owner here: no Approval is part of the test.
          await installSkills(context(at), reader ?? github.reader, {
            environment: environment ?? DEFAULT_ENVIRONMENT,
            source,
            skills: ["*"],
            author:
              owner || environment === "*"
                ? null
                : { ...author, tool: "environment_skill_install" },
          });
        },
        update: ({ owner = false, at = 2_000, overwrite = false, ...request }) =>
          updateSkills(context(at), github.reader, {
            ...request,
            overwrite,
            author: owner ? null : author,
          }),
        preview: ({ overwrite = false, ...request }) =>
          previewSkillUpdates(context(2_000), github.reader, { ...request, overwrite }),
        edit: async (name, edited, at = 1_500, environment = DEFAULT_ENVIRONMENT) => {
          saveSkillAs(context(at), {
            environment,
            folder: name,
            files: edited,
            hashed: await hashFiles(edited),
            author: { ...author, tool: "environment_skill_save" },
          });
        },
        revert: (id, at = 3_000, environment = DEFAULT_ENVIRONMENT) =>
          revertAgentChange(state.storage, store, changes, { environment, id }, at, skills),
        check: () => checkSkillUpdates(skills, github.reader),
        daily: (at) => runDailySkillCheck({ skills, documents: store }, github.reader, at),
      });
    },
  );

const DAY = SKILL_CHECK_INTERVAL_MS;

describe("a save over an installed Skill", () => {
  it("keeps the source and marks the Skill modified, and a revert brings the mark back off", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [before, after, change, reverted, restored] = await inRegistry(
      async ({ install, edit, skills, changes, revert }) => {
        await install(REPO);

        const installed = skills.get(DEFAULT_ENVIRONMENT, "grill-me");

        await edit("grill-me", { "SKILL.md": skillMd("grill-me", "Edited.") });

        const edited = skills.get(DEFAULT_ENVIRONMENT, "grill-me");
        const saved = changes.list(DEFAULT_ENVIRONMENT)[0];
        const undo = revert(saved?.id ?? -1);

        return [installed, edited, saved, undo, skills.get(DEFAULT_ENVIRONMENT, "grill-me")];
      },
      github,
    );

    expect(before).toMatchObject({ modified: false, source: { repo: REPO } });
    expect(after).toMatchObject({ modified: true, source: before?.source });
    // The change records the mark, so a revert can put it back with the files and the source.
    expect(change).toMatchObject({
      before: expect.not.objectContaining({ modified: true }),
      after: { modified: true },
    });
    expect(reverted).toMatchObject({ status: "reverted" });
    expect(restored).toMatchObject({
      modified: false,
      files: before?.files,
      source: before?.source,
    });
  });

  it("marks nothing for a Skill with no source, or for the same files", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [own, same] = await inRegistry(async ({ install, edit, skills }) => {
      await edit("mine", { "SKILL.md": skillMd("mine") });
      await install(REPO);

      const mine = skills.get(DEFAULT_ENVIRONMENT, "mine");

      await edit("grill-me", {
        "SKILL.md": skillMd("grill-me"),
        "references/questions.md": "- why?\n",
      });

      return [mine, skills.get(DEFAULT_ENVIRONMENT, "grill-me")];
    }, github);

    expect(own).toMatchObject({ modified: false, source: null });
    // The files the Skill has already: nothing is saved, so nothing is marked.
    expect(same).toMatchObject({ modified: false });
  });
});

describe("updating installed Skills", () => {
  it("moves a Skill to the ref's latest commit as an Agent change, with the new source", async () => {
    const github = fakeGithub();
    const first = github.push(REPO, files());

    const [updated, kept, changes] = await inRegistry(
      async ({ install, update, skills, changes }) => {
        await install(REPO);

        const second = github.push(REPO, files({}, "New steps."));

        return [
          await update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me"] }),
          { skill: skills.get(DEFAULT_ENVIRONMENT, "grill-me"), second },
          changes.list(DEFAULT_ENVIRONMENT),
        ] as const;
      },
      github,
    );

    expect(updated).toMatchObject({
      status: "done",
      results: [
        {
          name: "grill-me",
          outcome: "updated",
          overwrote: false,
          from: { commit: first },
          to: { commit: kept.second },
        },
      ],
    });

    expect(kept.skill).toMatchObject({
      modified: false,
      updateAvailable: false,
      source: { repo: REPO, path: "skills/grill-me", ref: null, commit: kept.second },
    });

    expect(changes.filter((change) => change.tool === "environment_skill_update")).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor: "agent",
      field: "skills.grill-me",
      before: { source: { commit: first } },
      after: { source: { commit: kept.second } },
    });
  });

  it("brings back the earlier files, source and mark with a revert, including overwritten edits", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [refused, overwritten, reverted, restored, original] = await inRegistry(
      async ({ install, edit, update, revert, skills, changes }) => {
        await install(REPO);
        await edit("grill-me", { "SKILL.md": skillMd("grill-me", "My edit.") });

        const edited = skills.get(DEFAULT_ENVIRONMENT, "grill-me");

        github.push(REPO, files({}, "New steps."));

        const withheld = await update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me"] });
        const kept = skills.get(DEFAULT_ENVIRONMENT, "grill-me");

        const forced = await update({
          environment: DEFAULT_ENVIRONMENT,
          names: ["grill-me"],
          overwrite: true,
          at: 2_500,
        });

        const change = changes.list(DEFAULT_ENVIRONMENT)[0];
        const undo = revert(change?.id ?? -1, 3_000);

        return [
          withheld,
          { kept, forced },
          undo,
          skills.get(DEFAULT_ENVIRONMENT, "grill-me"),
          edited,
        ] as const;
      },
      github,
    );

    // Edited since installed: refused, and named, with nothing changed.
    expect(refused).toMatchObject({
      status: "done",
      results: [
        {
          name: "grill-me",
          outcome: "modified",
          message: expect.stringContaining("would replace the edits"),
        },
      ],
    });
    expect(overwritten.kept).toMatchObject({ modified: true });
    expect(overwritten.forced).toMatchObject({
      results: [{ name: "grill-me", outcome: "updated", overwrote: true }],
    });
    expect(reverted).toMatchObject({ status: "reverted" });
    // The edits, the mark and the earlier source are back.
    expect(restored).toMatchObject({
      modified: true,
      files: original?.files,
      source: original?.source,
    });
  });

  it("leaves the hash and mark of a Skill reverted to another commit to the next check, which records them again", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [reverted, afterCheck] = await inRegistry(
      async ({ install, update, revert, check, skills, changes }) => {
        await install(REPO);
        github.push(REPO, files({}, "New steps."));
        await update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me"] });

        const change = changes.list(DEFAULT_ENVIRONMENT)[0];

        revert(change?.id ?? -1);

        const right = skills.get(DEFAULT_ENVIRONMENT, "grill-me");

        await check();

        return [right, skills.get(DEFAULT_ENVIRONMENT, "grill-me")] as const;
      },
      github,
    );

    // Back at the first commit: nothing is assumed of the ref until the check has looked.
    expect(reverted).toMatchObject({ updateAvailable: false, folderHash: null });
    // The check records the hash from the tree at that commit, and finds the ref has moved on.
    expect(afterCheck).toMatchObject({ updateAvailable: true, folderHash: expect.any(String) });
  });

  it("updates only the Skills marked update available when none is named, and says when none is", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [none, all, kept] = await inRegistry(async ({ install, update, skills, check }) => {
      await install(REPO);

      const nothing = await update({ environment: DEFAULT_ENVIRONMENT });

      // Only grill-me changes upstream: the check marks it, and an update with no names takes it alone.
      github.push(REPO, files({}, "New steps."));
      await check();

      const marked = await update({ environment: DEFAULT_ENVIRONMENT });

      return [nothing, marked, skills.list(DEFAULT_ENVIRONMENT)] as const;
    }, github);

    expect(none).toMatchObject({ status: "nothing" });
    expect(all).toMatchObject({
      status: "done",
      results: [{ name: "grill-me", outcome: "updated" }],
    });
    expect(kept.map((skill) => [skill.name, skill.source?.commit === undefined])).toEqual([
      ["grill-me", false],
      ["tdd", false],
    ]);
  });

  it("records nothing for a Skill whose folder is the same at the new commit, and clears its mark", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [result, skill, changes, checked] = await inRegistry(
      async ({ install, update, skills, changes, check }) => {
        await install(REPO);

        // Another file of the repo changed: the Skill's folder is the same.
        github.push(REPO, files({ "README.md": "Changed.\n" }));
        skills.recordFound(
          DEFAULT_ENVIRONMENT,
          "tdd",
          skills.get(DEFAULT_ENVIRONMENT, "tdd")?.source?.commit ?? "",
          {
            updateAvailable: true,
          },
        );

        const done = await update({ environment: DEFAULT_ENVIRONMENT, names: ["tdd"] });

        return [
          done,
          skills.get(DEFAULT_ENVIRONMENT, "tdd"),
          changes.list(DEFAULT_ENVIRONMENT),
          await check(),
        ] as const;
      },
      github,
    );

    expect(result).toMatchObject({ results: [{ name: "tdd", outcome: "unchanged" }] });
    expect(skill).toMatchObject({ updateAvailable: false });
    // The install's two changes (grill-me, tdd), and none for the update.
    expect(changes).toHaveLength(2);
    expect(checked).toMatchObject({ marked: 0 });
  });

  it("reads each repo and ref once for all of its Skills, at one commit", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const requests = await inRegistry(async ({ install, update }) => {
      await install(REPO);
      github.push(REPO, files({}, "New steps."));
      github.reset();
      await update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me", "tdd"] });

      return github.requests.filter((request) => !request.startsWith("blob"));
    }, github);

    expect(requests).toEqual([`commit ${REPO}@HEAD`, expect.stringMatching(/^tree o\/skills@/)]);
  });

  it("reports a Skill that cannot be updated and still updates the others", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [result, listed] = await inRegistry(async ({ install, update, edit, skills }) => {
      await install(REPO);
      await edit("mine", { "SKILL.md": skillMd("mine") });

      // grill-me is renamed upstream, tdd gains a file that looks like a credential, and a third is fine.
      github.push(
        REPO,
        files({
          "skills/grill-me/SKILL.md": skillMd("grill-me-2"),
          "skills/tdd/SKILL.md": skillMd("tdd", "New."),
          "skills/tdd/notes.md": "key: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
        }),
      );

      const done = await update({
        environment: DEFAULT_ENVIRONMENT,
        names: ["grill-me", "tdd", "mine", "nope"],
      });

      return [done, skills.list(DEFAULT_ENVIRONMENT)] as const;
    }, github);

    expect(result).toMatchObject({
      status: "done",
      results: [
        { name: "grill-me", outcome: "rejected", message: expect.stringContaining("grill-me-2") },
        { name: "tdd", outcome: "rejected" },
        { name: "mine", outcome: "rejected", message: expect.stringContaining("no Skill source") },
        { name: "nope", outcome: "rejected", message: expect.stringContaining("keeps no Skill") },
      ],
    });
    // Nothing was replaced.
    expect(listed.find((skill) => skill.name === "tdd")?.source?.commit).toBeDefined();
  });

  it("tells why GitHub gave no answer for the Skills of a repo, per Skill", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const result = await inRegistry(async ({ install, update }) => {
      await install(REPO);
      github.fail(
        "o/skills",
        GithubReadError.of("rate_limited", "GitHub's rate limit is used up."),
      );

      return update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me"] });
    }, github);

    expect(result).toMatchObject({
      results: [
        { name: "grill-me", outcome: "rejected", message: "GitHub's rate limit is used up." },
      ],
    });
  });

  it("is the owner's update from the page: no Agent change, even at Global", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [here, atGlobal, changes] = await inRegistry(
      async ({ install, update, skills, changes }) => {
        await install(REPO, { owner: true });
        await install(REPO, { owner: true, environment: "*" });
        github.push(REPO, files({}, "New steps."));

        return [
          await update({ environment: DEFAULT_ENVIRONMENT, names: ["grill-me"], owner: true }),
          await update({ environment: "*", names: ["grill-me"], owner: true }),
          [changes.list(DEFAULT_ENVIRONMENT), changes.list("*"), skills.get("*", "grill-me")],
        ] as const;
      },
      github,
    );

    expect(here).toMatchObject({ results: [{ name: "grill-me", outcome: "updated" }] });
    expect(atGlobal).toMatchObject({
      environment: { id: "*" },
      results: [{ name: "grill-me", outcome: "updated" }],
    });
    expect(changes[0]).toEqual([]);
    expect(changes[1]).toEqual([]);
    expect(changes[2]).toMatchObject({ source: { commit: expect.any(String) } });
  });

  it("refuses an Environment that is not there", async () => {
    const result = await inRegistry(async ({ update }) =>
      update({ environment: "ghost", names: ["grill-me"] }),
    );

    expect(result).toEqual({ status: "missing" });
  });
});

describe("an update at Global the owner approved", () => {
  it("is made at the commits and folders the owner was shown, not at the ref's head by then", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [previewed, updated, kept, changes] = await inRegistry(
      async ({ install, preview, update, skills, changes }) => {
        await install(REPO, { environment: "*" });

        const shown = github.push(REPO, files({}, "Shown steps."));
        const view = await preview({ environment: "*", names: ["grill-me"] });

        // The ref moves on while the owner reads the card.
        github.push(REPO, files({}, "Later steps."));

        const ready = view.status === "done" ? view.results[0] : undefined;

        const pins: SkillUpdatePin[] =
          ready?.outcome === "ready"
            ? [
                {
                  name: "grill-me",
                  savedAt: ready.savedAt,
                  commit: ready.to.commit,
                  folderHash: ready.folderHash,
                },
              ]
            : [];

        const done = await update({ environment: "*", names: ["grill-me"], pins });

        return [
          view,
          done,
          { skill: skills.get("*", "grill-me"), shown },
          changes.list("*"),
        ] as const;
      },
      github,
    );

    expect(previewed).toMatchObject({
      status: "done",
      results: [
        {
          name: "grill-me",
          outcome: "ready",
          overwrites: false,
          files: { "SKILL.md": expect.stringContaining("Shown steps.") },
        },
      ],
    });

    expect(updated).toMatchObject({ results: [{ name: "grill-me", outcome: "updated" }] });
    expect(kept.skill?.source?.commit).toBe(kept.shown);
    expect(changes[0]).toMatchObject({ scope: "*", after: { source: { commit: kept.shown } } });
  });

  it("is refused for a Skill saved again since the owner was asked, or not part of what they saw", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [saved, outsider] = await inRegistry(async ({ install, preview, update, edit }) => {
      await install(REPO, { environment: "*" });
      github.push(REPO, files({}, "Shown steps."));

      const view = await preview({ environment: "*", names: ["grill-me"] });
      const ready = view.status === "done" ? view.results[0] : undefined;

      const pins: SkillUpdatePin[] =
        ready?.outcome === "ready"
          ? [
              {
                name: "grill-me",
                savedAt: ready.savedAt,
                commit: ready.to.commit,
                folderHash: ready.folderHash,
              },
            ]
          : [];

      // Saved again since the owner was asked.
      await edit("grill-me", { "SKILL.md": skillMd("grill-me", "Edited.") }, 1_800, "*");

      const again = await update({ environment: "*", names: ["grill-me"], overwrite: true, pins });

      // tdd moved too, but the owner was not shown it.
      github.push(REPO, files({ "skills/tdd/SKILL.md": skillMd("tdd", "New.") }, "Shown steps."));

      const unseen = await update({ environment: "*", names: ["tdd"], pins });

      return [again, unseen] as const;
    }, github);

    expect(saved).toMatchObject({
      results: [{ name: "grill-me", outcome: "changed-since" }],
    });
    expect(outsider).toMatchObject({
      results: [
        { name: "tdd", outcome: "changed-since", message: expect.stringContaining("not part") },
      ],
    });
  });

  it("finds an approved update made already, whatever moved since, and records nothing again", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [first, again, changes, skill] = await inRegistry(
      async ({ install, preview, update, skills, changes }) => {
        await install(REPO, { environment: "*" });
        github.push(REPO, files({}, "Shown steps."));

        const view = await preview({ environment: "*", names: ["grill-me"] });
        const ready = view.status === "done" ? view.results[0] : undefined;

        const pins: SkillUpdatePin[] =
          ready?.outcome === "ready"
            ? [
                {
                  name: "grill-me",
                  savedAt: ready.savedAt,
                  commit: ready.to.commit,
                  folderHash: ready.folderHash,
                },
              ]
            : [];

        const one = await update({ environment: "*", names: ["grill-me"], pins, at: 2_000 });

        // The Session was evicted before it saw the answer: the same pins are applied again, later, with the ref moved on.
        github.push(REPO, files({}, "Later steps."));

        const two = await update({ environment: "*", names: ["grill-me"], pins, at: 3_000 });

        return [one, two, changes.list("*"), skills.get("*", "grill-me")] as const;
      },
      github,
    );

    expect(first).toMatchObject({ results: [{ name: "grill-me", outcome: "updated" }] });
    expect(again).toMatchObject({ results: [{ name: "grill-me", outcome: "unchanged" }] });
    expect(changes).toHaveLength(1);
    expect(skill?.files["SKILL.md"]).toBeDefined();
  });
});

describe("the daily check", () => {
  it("marks a Skill update available when its folder changed at the ref's head, and not for a commit that leaves it", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [leftAlone, moved, marks] = await inRegistry(async ({ install, check, skills }) => {
      await install(REPO);

      // A commit that touches another file only.
      github.push(REPO, files({ "README.md": "Changed.\n" }));
      const same = await check();

      // A commit that changes grill-me's folder.
      github.push(REPO, files({ "README.md": "Changed.\n" }, "New steps."));
      const changed = await check();

      return [
        same,
        changed,
        skills.list(DEFAULT_ENVIRONMENT).map((skill) => [skill.name, skill.updateAvailable]),
      ] as const;
    }, github);

    expect(leftAlone).toMatchObject({ checked: 2, marked: 0, rateLimited: false });
    expect(moved).toMatchObject({ checked: 2, marked: 1 });
    expect(marks).toEqual([
      ["grill-me", true],
      ["tdd", false],
    ]);
  });

  it("takes the mark off again when the ref goes back to the installed folder", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [first, second, after] = await inRegistry(async ({ install, check, skills }) => {
      await install(REPO);
      github.push(REPO, files({}, "New steps."));
      const marked = await check();
      github.push(REPO, files());
      const cleared = await check();

      return [marked, cleared, skills.get(DEFAULT_ENVIRONMENT, "grill-me")] as const;
    }, github);

    expect(first).toMatchObject({ marked: 1 });
    expect(second).toMatchObject({ cleared: 1 });
    expect(after).toMatchObject({ updateAvailable: false });
  });

  it("shows no update for a Skill pinned to a tag unless the tag moves, and skips a commit", async () => {
    const github = fakeGithub();

    github.push(REPO, files(), "v1");
    github.push(REPO, files());

    const [tagged, afterMain, afterTag, requests] = await inRegistry(
      async ({ install, check, skills }) => {
        await install(`https://github.com/${REPO}/tree/v1`);

        // The default branch moves on; the tag does not.
        github.push(REPO, files({}, "New steps."));
        github.reset();
        await check();

        const quiet = skills.list(DEFAULT_ENVIRONMENT).map((skill) => skill.updateAvailable);
        const asked = [...github.requests];

        github.push(REPO, files({}, "Tag moved."), "v1");
        await check();

        const moved = skills
          .list(DEFAULT_ENVIRONMENT)
          .map((skill) => [skill.name, skill.updateAvailable]);

        return [
          skills.get(DEFAULT_ENVIRONMENT, "grill-me")?.source?.ref,
          quiet,
          moved,
          asked,
        ] as const;
      },
      github,
    );

    expect(tagged).toBe("v1");
    expect(afterMain).toEqual([false, false]);
    expect(afterTag).toEqual([
      ["grill-me", true],
      ["tdd", false],
    ]);
    // The tag's tree, not the default branch's.
    expect(requests.filter((request) => request.startsWith("headTree"))).toEqual([
      `headTree ${REPO}@v1`,
    ]);
  });

  it("never looks at a Skill pinned to a commit", async () => {
    const github = fakeGithub();
    const pinned = github.push(REPO, files());

    const requests = await inRegistry(async ({ install, check }) => {
      await install(`https://github.com/${REPO}/tree/${pinned}`);
      github.reset();
      await check();

      return github.requests;
    }, github);

    expect(requests).toEqual([]);
  });

  it("makes one tree request for each repo and ref across every scope", async () => {
    const github = fakeGithub();

    github.push(REPO, files());
    github.push("o/other", { "SKILL.md": skillMd("other") });

    const [checked, requests] = await inRegistry(async ({ install, check }) => {
      await install(REPO);
      await install(REPO, { environment: "0000abcd" });
      await install(REPO, { environment: "*" });
      await install("o/other", { environment: "*" });
      github.reset();

      return [await check(), [...github.requests]] as const;
    }, github);

    // Three scopes each hold two Skills of o/skills and one holds o/other's: seven Skills, two requests.
    expect(checked).toMatchObject({ checked: 7 });
    expect(requests).toEqual([`headTree ${REPO}@HEAD`, "headTree o/other@HEAD"]);
  });

  it("records the digest of a Skill kept before it was recorded, from the tree at its commit, and keeps it", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [afterFirst, requests, folderHash, afterSecond] = await inRegistry(
      async ({ install, check, skills, storage }) => {
        await install(REPO);
        // As if installed before the digest was recorded.
        storage.sql.exec("UPDATE skills SET folder_hash = NULL");
        github.push(REPO, files({}, "New steps."));
        github.reset();

        const first = await check();
        const asked = [...github.requests];
        const recorded = skills.get(DEFAULT_ENVIRONMENT, "grill-me")?.folderHash;
        github.reset();
        const second = await check();

        return [first, asked, recorded, [second, [...github.requests]]] as const;
      },
      github,
    );

    expect(afterFirst).toMatchObject({ checked: 2, marked: 1 });
    // The head's tree, and the tree at the commit they were installed at, once for both Skills.
    expect(requests).toEqual([`headTree ${REPO}@HEAD`, expect.stringMatching(/^tree o\/skills@/)]);
    expect(folderHash).toEqual(expect.any(String));
    // Recorded: the next check needs no tree at the installed commit.
    expect(afterSecond[1]).toEqual([`headTree ${REPO}@HEAD`]);
  });

  it("leaves the marks alone for a repo GitHub cannot read, and stops at the rate limit", async () => {
    const github = fakeGithub();

    github.push(REPO, files());
    github.push("o/gone", { "SKILL.md": skillMd("gone") });
    github.push("o/last", { "SKILL.md": skillMd("last") });

    const [problem, limited, marks] = await inRegistry(async ({ install, check, skills }) => {
      await install(REPO);
      await install("o/gone");
      await install("o/last");
      github.push(REPO, files({}, "New steps."));
      github.push("o/last", { "SKILL.md": skillMd("last", "New.") });
      github.fail("o/gone", GithubReadError.of("not_found", "GitHub has no repo o/gone"));

      const unreadable = await check();

      github.fail("o/gone", undefined);
      github.fail(REPO, GithubReadError.of("rate_limited", "GitHub's rate limit is used up."));

      const stopped = await check();

      return [
        unreadable,
        stopped,
        skills.list(DEFAULT_ENVIRONMENT).map((skill) => [skill.name, skill.updateAvailable]),
      ] as const;
    }, github);

    // The unreadable repo is told in the log and left alone; the others are checked.
    expect(problem).toMatchObject({
      rateLimited: false,
      problems: [expect.stringContaining("o/gone")],
    });
    expect(limited).toMatchObject({ rateLimited: true });
    // The marks of the first run stand: grill-me and last moved, gone is untouched.
    expect(marks).toEqual([
      ["gone", false],
      ["grill-me", true],
      ["last", true],
      ["tdd", false],
    ]);
  });

  it("leaves alone only the Skill whose installed commit GitHub no longer has, and compares the others", async () => {
    const github = fakeGithub();
    const installed = github.push(REPO, files());

    const [result, marks] = await inRegistry(async ({ install, check, skills, storage }) => {
      await install(REPO);
      // Kept before the digest was recorded: its folder is read from the tree at its commit.
      storage.sql.exec("UPDATE skills SET folder_hash = NULL WHERE name = 'grill-me'");
      github.push(REPO, files({ "skills/tdd/SKILL.md": skillMd("tdd", "New.") }));
      github.forget(installed);

      return [
        await check(),
        skills.list(DEFAULT_ENVIRONMENT).map((skill) => [skill.name, skill.updateAvailable]),
      ] as const;
    }, github);

    expect(result).toMatchObject({
      checked: 1,
      marked: 1,
      rateLimited: false,
      problems: [
        expect.stringContaining(
          "grill-me: its folder at the installed commit could not be read: GitHub has no commit",
        ),
      ],
    });
    expect(marks).toEqual([
      ["grill-me", false],
      ["tdd", true],
    ]);
  });

  it("tries again in an hour after an error that is not GitHub's answer, not tomorrow", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [failed, early, later] = await inRegistry(async ({ install, daily }) => {
      await install(REPO);
      github.fail(REPO, new Error("boom"));

      let failure: Error | undefined;

      try {
        await daily(10 * DAY);
      } catch (cause) {
        failure = cause instanceof Error ? cause : undefined;
      }

      github.fail(REPO, undefined);

      return [
        failure,
        await daily(10 * DAY + 30 * 60_000),
        await daily(10 * DAY + 60 * 60_000),
      ] as const;
    }, github);

    expect(failed).toEqual(new Error("boom"));
    expect(early).toBeUndefined();
    expect(later).toMatchObject({ checked: 2 });
  });

  it("refuses a preview of more Skills than one Approval shows, before any file is read", async () => {
    const github = fakeGithub();
    const names = Array.from({ length: 11 }, (_, at) => `skill-${at}`);

    github.push(
      REPO,
      Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])),
    );

    const [view, requests] = await inRegistry(async ({ install, preview }) => {
      await install(REPO, { environment: "*" });
      github.reset();

      return [await preview({ environment: "*", names }), [...github.requests]] as const;
    }, github);

    expect(view).toMatchObject({
      status: "refused",
      message: expect.stringContaining("shows at most 10"),
    });
    expect(requests).toEqual([]);
  });

  it("refuses, before the owner is asked, an update that would take a Skill set past its limits", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [view, skill] = await inRegistry(async ({ install, preview, skills }) => {
      await install(REPO, { environment: "*" });

      // The Environment's own Skills take 7.5 MB of the set's 8: an update to a Skill of 940 KB would pass it there.
      for (let at = 0; at < 8; at += 1) {
        const own = {
          "SKILL.md": skillMd(`big-${at}`),
          ...Object.fromEntries(
            Array.from({ length: 8 }, (_, part) => [`part-${part}.md`, "x".repeat(117_000)]),
          ),
        };

        const hashed = await hashFiles(own);

        skills.put(
          DEFAULT_ENVIRONMENT,
          {
            name: `big-${at}`,
            description: `What big-${at} does.`,
            files: hashed.files,
            source: null,
          },
          hashed.contents,
          1_000,
        );
      }

      const grown = Object.fromEntries(
        Array.from({ length: 8 }, (_, part) => [
          `skills/grill-me/part-${part}.md`,
          "y".repeat(117_000),
        ]),
      );

      github.push(REPO, files(grown));

      return [
        await preview({ environment: "*", names: ["grill-me"] }),
        skills.get("*", "grill-me"),
      ] as const;
    }, github);

    expect(view).toMatchObject({
      status: "done",
      results: [
        {
          name: "grill-me",
          outcome: "rejected",
          message: expect.stringContaining("more than the 8388608 a set may"),
        },
      ],
    });
    expect(skill?.source?.commit).toBeDefined();
  });

  it("refuses a preview of updates more than a Skill set may hold together, though each passes alone", async () => {
    const github = fakeGithub();
    const names = ["l0", "l1", "l2"];

    github.push(
      REPO,
      Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])),
    );

    const view = await inRegistry(async ({ install, preview }) => {
      await install(REPO, { environment: "*" });

      // Each grows to 3 MiB: 9 MiB together.
      const data = "x".repeat(MAX_FILE_BYTES);

      github.push(
        REPO,
        Object.fromEntries(
          names.flatMap((name) => [
            [`skills/${name}/SKILL.md`, skillMd(name)],
            [`skills/${name}/a.txt`, data],
            [`skills/${name}/b.txt`, data],
          ]),
        ),
      );

      return preview({ environment: "*", names });
    }, github);

    expect(view).toMatchObject({
      status: "refused",
      message: expect.stringContaining(`more than the ${MAX_SKILL_SET_BYTES} a Skill set may hold`),
    });
  });

  it("applies nothing: the Skills' files and sources stay as they were", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [before, after, changes] = await inRegistry(
      async ({ install, check, skills, changes }) => {
        await install(REPO);

        const kept = skills.list(DEFAULT_ENVIRONMENT).map(({ files: f, source }) => [f, source]);

        github.push(REPO, files({}, "New steps."));
        await check();

        return [
          kept,
          skills.list(DEFAULT_ENVIRONMENT).map(({ files: f, source }) => [f, source]),
          changes.list(DEFAULT_ENVIRONMENT),
        ] as const;
      },
      github,
    );

    expect(after).toEqual(before);
    // The install's changes only.
    expect(changes).toHaveLength(2);
  });

  it("runs at most once a day, claims the run, and is due again in an hour after the rate limit", async () => {
    const github = fakeGithub();

    github.push(REPO, files());

    const [none, first, soon, nextDay, limited, retried] = await inRegistry(
      async ({ install, daily, storage }) => {
        // Nothing installed yet: nothing to look at, and nothing recorded.
        const empty = await daily(10 * DAY);

        const documented = storage.sql
          .exec("SELECT name FROM documents WHERE name = ?", SKILL_CHECK_DOCUMENT)
          .toArray().length;

        await install(REPO);
        github.reset();

        const ran = await daily(10 * DAY + 2_000);
        const again = await daily(10 * DAY + 2_000 + DAY - 1);
        const tomorrow = await daily(10 * DAY + 2_000 + DAY);

        github.fail(REPO, GithubReadError.of("rate_limited", "GitHub's rate limit is used up."));

        const stopped = await daily(10 * DAY + 2_000 + 2 * DAY);
        // An hour later it tries again, not a day.
        const early = await daily(10 * DAY + 2_000 + 2 * DAY + 30 * 60_000);
        const later = await daily(10 * DAY + 2_000 + 2 * DAY + 60 * 60_000);

        return [[empty, documented], ran, again, tomorrow, [stopped, early], later] as const;
      },
      github,
    );

    expect(none).toEqual([undefined, 0]);
    expect(first).toMatchObject({ checked: 2 });
    expect(soon).toBeUndefined();
    expect(nextDay).toMatchObject({ checked: 2 });
    expect(limited[0]).toMatchObject({ rateLimited: true });
    expect(limited[1]).toBeUndefined();
    expect(retried).toMatchObject({ rateLimited: true });
  });
});
