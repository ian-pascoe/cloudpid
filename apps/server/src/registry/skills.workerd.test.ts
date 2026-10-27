// An Environment's own Skills over real Durable Object SQLite (ADR-0026, docs/spec.md → The Environment's own Skills): saved
// and removed by the agent as Agent changes with their files before and after, merged over the bundle into the Skill
// set its Workspaces serve, each text kept once, and reverted unless saved again since.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT, MAX_AGENT_CHANGES, skillField } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import {
  hashBundle,
  hashFiles,
  mergeSkills,
  openSkills,
  removeSkill,
  removeSkillAs,
  saveSkillAs,
  skillChangeFiles,
  type SkillFiles,
  skillSetOf,
} from "./skills.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_skill_save",
  reason: "The release steps are the same every time",
};

const BUNDLE = {
  hash: "bundle-version-1",
  files: {
    "pr/SKILL.md": "---\nname: pr\ndescription: The bundled pr.\n---\nBundled.\n",
    "tdd/SKILL.md": "---\nname: tdd\ndescription: Test first.\n---\nRed, green.\n",
  },
};

const skillMd = (name: string, description = `What ${name} does.`, body = "Steps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const release: SkillFiles = {
  "SKILL.md": skillMd("release"),
  "references/steps.md": "1. Tag.\n2. Push.\n",
};

/** Run `body` over a fresh Registry's store, Skills and Agent changes, with a bundle of two Skills. */
const inRegistry = <A>(
  body: (registry: {
    readonly save: (
      folder: string,
      files: SkillFiles,
      at?: number,
      environment?: string,
    ) => Promise<ReturnType<typeof saveSkillAs>>;
    readonly remove: (name: string, at?: number) => ReturnType<typeof removeSkillAs>;
    readonly revert: (id: number, at?: number) => ReturnType<typeof revertAgentChange>;
    readonly set: (
      environment?: string,
    ) => Promise<{ hash: string; files: Record<string, string> }>;
    readonly skills: ReturnType<typeof openSkills>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const changes = openAgentChanges(state.storage);
      const skills = openSkills(state.storage);
      const bundle = await hashBundle(BUNDLE);

      return body({
        store,
        storage: state.storage,
        changes,
        skills,
        save: async (folder, files, at = 1_000, environment = DEFAULT_ENVIRONMENT) =>
          saveSkillAs(
            { storage: state.storage, store, skills, changes, bundle, now: at },
            { environment, folder, files, hashed: await hashFiles(files), author },
          ),
        remove: (name, at = 2_000) =>
          removeSkillAs(
            { storage: state.storage, store, skills, changes, bundle, now: at },
            {
              environment: DEFAULT_ENVIRONMENT,
              name,
              author: { ...author, tool: "environment_skill_remove" },
            },
          ),
        revert: (id, at = 3_000) =>
          revertAgentChange(
            state.storage,
            store,
            changes,
            { environment: DEFAULT_ENVIRONMENT, id },
            at,
            { skills, bundle },
          ),
        set: async (environment = DEFAULT_ENVIRONMENT) => {
          const merged = await mergeSkills([skills.list(environment)], bundle);

          return skillSetOf(merged, bundle, skills);
        },
      });
    },
  );

describe("saving an Environment's Skill", () => {
  it("keeps it by name with its description, and merges it over the bundle into the Skill set", async () => {
    const [saved, listed, set] = await inRegistry(async ({ save, skills, set }) => [
      await save("release", release),
      skills.list(DEFAULT_ENVIRONMENT),
      await set(),
    ]);

    expect(saved).toMatchObject({
      status: "saved",
      skill: { name: "release", description: "What release does." },
      shadows: false,
    });
    expect(listed).toEqual([
      expect.objectContaining({
        name: "release",
        description: "What release does.",
        savedAt: 1_000,
      }),
    ]);
    expect(set.files).toEqual({
      "release/SKILL.md": release["SKILL.md"],
      "release/references/steps.md": release["references/steps.md"],
      ...BUNDLE.files,
    });
    expect(set.hash).not.toBe(BUNDLE.hash);
  });

  it("leaves the set the bundle, under its own hash, while the Environment keeps no Skill", async () => {
    const set = await inRegistry(async ({ set }) => set());

    expect(set).toEqual(BUNDLE);
  });

  it("hides a bundled Skill of the same name", async () => {
    const own = { "SKILL.md": skillMd("pr", "Our own pr.") };

    const [saved, set] = await inRegistry(async ({ save, set }) => [
      await save("pr", own),
      await set(),
    ]);

    expect(saved).toMatchObject({ status: "saved", shadows: true });
    expect(set.files).toEqual({
      "pr/SKILL.md": own["SKILL.md"],
      "tdd/SKILL.md": BUNDLE.files["tdd/SKILL.md"],
    });
  });

  it("does not reach another Environment's set", async () => {
    const set = await inRegistry(async ({ store, save, set }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("release", release);

      return set("0000abcd");
    });

    expect(set).toEqual(BUNDLE);
  });

  it("records nothing for the files it keeps already", async () => {
    const [again, listed] = await inRegistry(async ({ save, changes }) => {
      await save("release", release);

      return [await save("release", { ...release }, 2_000), changes.list(DEFAULT_ENVIRONMENT)];
    });

    expect(again).toMatchObject({ status: "unchanged" });
    expect(listed).toHaveLength(1);
  });

  it("keeps identical files once, for every Skill and change that has them", async () => {
    const rows = await inRegistry(async ({ save, storage }) => {
      const shared = "Shared text.\n";

      await save("release", { ...release, "NOTES.md": shared });
      await save("deploy", { "SKILL.md": skillMd("deploy"), "NOTES.md": shared });
      await save("release", { ...release, "NOTES.md": shared, "MORE.md": "More.\n" }, 2_000);

      return storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM skill_files")
        .toArray()[0]?.count;
    });

    // release's two files, the shared one, deploy's SKILL.md and MORE.md.
    expect(rows).toBe(5);
  });

  it.each([
    [
      "a name with capitals",
      "Release",
      { "SKILL.md": skillMd("Release") },
      "lowercase letters, digits and hyphens",
    ],
    ["two hyphens in a row", "re--lease", { "SKILL.md": skillMd("re--lease") }, "two in a row"],
    [
      "a name over 64 characters",
      "a".repeat(65),
      { "SKILL.md": skillMd("a".repeat(65)) },
      "more than the 64",
    ],
    [
      "a name that is not the folder's",
      "releases",
      { "SKILL.md": skillMd("release") },
      "must be the same",
    ],
    ["no SKILL.md", "release", { "README.md": "Hi.\n" }, "no SKILL.md"],
    ["no frontmatter", "release", { "SKILL.md": "# Release\n" }, "no YAML frontmatter"],
    [
      "no description",
      "release",
      { "SKILL.md": "---\nname: release\n---\n" },
      "sets no description",
    ],
    [
      "a description over 1024 characters",
      "release",
      { "SKILL.md": skillMd("release", "d".repeat(1025)) },
      "more than the 1024",
    ],
    ["a binary file", "release", { ...release, "logo.bin": "PNG\0\0" }, "a binary file"],
    [
      "a file over 128 KB",
      "release",
      { ...release, "big.md": "x".repeat(128 * 1024 + 1) },
      "more than the 131072",
    ],
    [
      "a credential",
      "release",
      { ...release, "env.md": `token: ghp_${"a".repeat(36)}` },
      "looks like a credential",
    ],
    [
      "a local path",
      "release",
      { ...release, "where.md": "See /home/ian/notes.\n" },
      "a local path",
    ],
    ["a path with ..", "release", { ...release, "../escape.md": "Out.\n" }, "`..` segment"],
  ])("refuses %s, saying why, and saves and records nothing", async (_, folder, files, message) => {
    const [saved, listed, changed] = await inRegistry(async ({ save, skills, changes }) => [
      await save(folder, files),
      skills.list(DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(saved).toMatchObject({ status: "rejected", message: expect.stringContaining(message) });
    expect(listed).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("refuses a Skill that would take the Environment's set past 100 Skills, the bundle's counted", async () => {
    const saved = await inRegistry(async ({ save }) => {
      // The bundle holds 2: 98 of the Environment's own make 100.
      for (let index = 0; index < 98; index += 1) {
        await save(`skill-${index}`, { "SKILL.md": skillMd(`skill-${index}`) });
      }

      return [
        await save("skill-0", { "SKILL.md": skillMd("skill-0", "Saved again.") }),
        await save("one-more", { "SKILL.md": skillMd("one-more") }),
      ];
    });

    expect(saved[0]).toMatchObject({ status: "saved" });
    expect(saved[1]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("101 Skills, more than the 100"),
    });
  });

  it("refuses a Skill that would take the Environment's set past 8 MB, the bundle's counted", async () => {
    // About 1 MB a Skill: 8 files of 126 KB.
    const big = (name: string): SkillFiles => ({
      "SKILL.md": skillMd(name),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, at) => [
          `references/${at}.md`,
          `${name} ${at}.\n`.repeat(14_000),
        ]),
      ),
    });

    const saved = await inRegistry(async ({ save }) => {
      const kept = [];

      for (let index = 0; index < 9; index += 1) {
        kept.push(await save(`big-${index}`, big(`big-${index}`)));
      }

      return kept;
    });

    expect(saved.slice(0, 8).map((each) => each.status)).toEqual(Array(8).fill("saved"));
    expect(saved[8]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("more than the 8388608 a set may"),
    });
  });

  it("is refused for an Environment that does not exist", async () => {
    const saved = await inRegistry(async ({ save }) => save("release", release, 1_000, "0000dead"));

    expect(saved).toEqual({ status: "missing" });
  });
});

describe("a Skill's Agent changes", () => {
  it("record the files before and after by hash, which skillChangeFiles gives back as text", async () => {
    const edited = {
      ...release,
      "SKILL.md": skillMd("release", "What release does.", "New steps."),
    };

    const [listed, files] = await inRegistry(async ({ save, changes, skills }) => {
      await save("release", release);
      await save("release", edited, 2_000);

      const all = changes.list(DEFAULT_ENVIRONMENT);

      return [all, all.map((change) => skillChangeFiles(skills, change))];
    });

    expect(listed.map(({ field, tool }) => ({ field, tool }))).toEqual([
      { field: skillField("release"), tool: "environment_skill_save" },
      { field: skillField("release"), tool: "environment_skill_save" },
    ]);
    expect(files).toEqual([
      {
        before: [
          { path: "SKILL.md", text: release["SKILL.md"] },
          { path: "references/steps.md", text: release["references/steps.md"] },
        ],
        after: [
          { path: "SKILL.md", text: edited["SKILL.md"] },
          { path: "references/steps.md", text: release["references/steps.md"] },
        ],
      },
      {
        before: null,
        after: [
          { path: "SKILL.md", text: release["SKILL.md"] },
          { path: "references/steps.md", text: release["references/steps.md"] },
        ],
      },
    ]);
  });

  it("revert a save to the files before, and a new Skill's save by removing it", async () => {
    const edited = { "SKILL.md": skillMd("release", "Edited.") };

    const [afterFirst, afterSecond] = await inRegistry(
      async ({ save, revert, skills, changes }) => {
        await save("release", release);
        await save("release", edited, 2_000);

        const [latest, first] = changes.list(DEFAULT_ENVIRONMENT);

        expect(revert(latest!.id)).toMatchObject({ status: "reverted" });

        const restored = skills.get(DEFAULT_ENVIRONMENT, "release");

        // The first save's own revert: the Skill it made is removed.
        expect(revert(first!.id, 4_000)).toMatchObject({ status: "reverted" });

        return [restored, skills.get(DEFAULT_ENVIRONMENT, "release")];
      },
    );

    expect(afterFirst).toMatchObject({ description: "What release does." });
    expect(afterFirst?.files).toHaveProperty(["references/steps.md"]);
    expect(afterSecond).toBeNull();
  });

  it("revert a removal by bringing the Skill back", async () => {
    const [removed, restored, set] = await inRegistry(
      async ({ save, remove, revert, changes, skills, set }) => {
        await save("release", release);

        const gone = remove("release");
        const [removal] = changes.list(DEFAULT_ENVIRONMENT);

        expect(removal).toMatchObject({ field: skillField("release"), after: null });
        expect(revert(removal!.id)).toMatchObject({
          status: "reverted",
          change: { actor: "owner", before: null },
        });

        return [gone, skills.get(DEFAULT_ENVIRONMENT, "release"), await set()];
      },
    );

    expect(removed).toMatchObject({ status: "removed", bundled: false });
    expect(restored).toMatchObject({ name: "release", description: "What release does." });
    expect(set.files["release/references/steps.md"]).toBe(release["references/steps.md"]);
  });

  it("refuse a revert once the Skill was saved again since", async () => {
    const reverted = await inRegistry(async ({ save, revert, changes }) => {
      await save("release", release);

      const [first] = changes.list(DEFAULT_ENVIRONMENT);

      await save("release", { "SKILL.md": skillMd("release", "Again.") }, 2_000);

      return revert(first!.id);
    });

    expect(reverted).toMatchObject({
      status: "refused",
      message: expect.stringContaining("saved again since"),
    });
  });

  it("record nothing for removing a Skill the Environment does not keep", async () => {
    const removed = await inRegistry(async ({ remove }) => remove("release"));

    expect(removed).toMatchObject({ status: "absent" });
  });
});

describe("the texts of a Skill's files", () => {
  it("are dropped once no Skill and no change kept refers to them", async () => {
    const [kept, dropped] = await inRegistry(async ({ save, remove, store, storage }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("gone", { "SKILL.md": skillMd("gone"), "OLD.md": "Only here.\n" });
      remove("gone");
      await save("stays", { "SKILL.md": skillMd("stays") }, 2_000, "0000abcd");

      const has = (text: string) =>
        storage.sql.exec("SELECT 1 FROM skill_files WHERE content = ?", text).toArray().length > 0;

      // The removal still refers to them: they are kept.
      const before = has("Only here.\n");

      // Then the history is pruned past both changes.
      for (let index = 0; index < MAX_AGENT_CHANGES; index += 1) {
        await save("churn", { "SKILL.md": skillMd("churn", `Version ${index}.`) }, 3_000 + index);
      }

      return [before, [has("Only here.\n"), has(skillMd("stays"))]];
    });

    expect(kept).toBe(true);
    // Another Environment's Skill keeps its own.
    expect(dropped).toEqual([false, true]);
  });

  it("go with the owner's removal of a Skill no change refers to, and with the Environment", async () => {
    const counts = await inRegistry(async ({ storage, skills, store }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      const hashed = await hashFiles({ "SKILL.md": skillMd("mine") });

      // As the owner's own save would keep it, with no change.
      skills.put(
        "0000abcd",
        { name: "mine", description: "What mine does.", files: hashed.files },
        hashed.contents,
        1_000,
      );
      skills.put(
        "0000abcd",
        { name: "yours", description: "What yours does.", files: hashed.files },
        hashed.contents,
        1_000,
      );

      const count = () =>
        storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM skill_files")
          .toArray()[0]?.count;

      const removed = removeSkill(storage, skills, { environment: "0000abcd", name: "mine" });
      const afterRemove = count();

      store.deleteEnvironment("0000abcd");

      return [removed, afterRemove, count(), skills.list("0000abcd")];
    });

    expect(counts).toEqual([true, 1, 0, []]);
  });
});
