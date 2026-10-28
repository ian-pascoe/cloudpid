// An Environment's own Skills, and those kept for every Environment (scope `*`), over real Durable Object SQLite (ADR-0026,
// docs/spec.md → The Environment's own Skills): saved and removed by the agent as Agent changes with their files before
// and after, merged (the Environment's own, then those for every Environment, then the bundle) into the Skill set its
// Workspaces serve, each text kept once, and reverted unless saved again since.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_ENVIRONMENT,
  EVERY_ENVIRONMENT_SCOPE,
  MAX_AGENT_CHANGES,
  type SkillExpectation,
  skillField,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import {
  previewSkillSave,
  hashBundle,
  hashFiles,
  mergeSkills,
  openSkills,
  removeSkill,
  removeSkillAs,
  saveSkillAs,
  skillChangeFiles,
  type SkillFiles,
  skillLayers,
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
      expected?: SkillExpectation,
    ) => Promise<ReturnType<typeof saveSkillAs>>;
    readonly check: (
      folder: string,
      files: SkillFiles,
      environment?: string,
    ) => Promise<ReturnType<typeof previewSkillSave>>;
    readonly remove: (
      name: string,
      at?: number,
      environment?: string,
      expected?: SkillExpectation,
    ) => ReturnType<typeof removeSkillAs>;
    readonly revert: (
      id: number,
      at?: number,
      environment?: string,
    ) => ReturnType<typeof revertAgentChange>;
    readonly set: (
      environment?: string,
    ) => Promise<{ hash: string; files: Record<string, string> }>;
    readonly skills: ReturnType<typeof openSkills>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
    readonly bundle: Awaited<ReturnType<typeof hashBundle>>;
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
        bundle,
        changes,
        skills,
        save: async (folder, files, at = 1_000, environment = DEFAULT_ENVIRONMENT, expected) =>
          saveSkillAs(
            { storage: state.storage, store, skills, changes, bundle, now: at },
            { environment, folder, files, hashed: await hashFiles(files), author, expected },
          ),
        check: async (folder, files, environment = DEFAULT_ENVIRONMENT) =>
          previewSkillSave(
            { store, skills, bundle },
            { environment, folder, files, hashed: await hashFiles(files) },
          ),
        remove: (name, at = 2_000, environment = DEFAULT_ENVIRONMENT, expected) =>
          removeSkillAs(
            { storage: state.storage, store, skills, changes, bundle, now: at },
            {
              environment,
              name,
              author: { ...author, tool: "environment_skill_remove" },
              expected,
            },
          ),
        revert: (id, at = 3_000, environment = DEFAULT_ENVIRONMENT) =>
          revertAgentChange(state.storage, store, changes, { environment, id }, at, {
            skills,
            bundle,
          }),
        set: async (environment = DEFAULT_ENVIRONMENT) => {
          const merged = await mergeSkills(skillLayers(skills, environment), bundle);

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
      bundled: false,
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

    expect(saved).toMatchObject({ status: "saved", bundled: true });
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
    const counts = await inRegistry(async ({ storage, skills, store, bundle }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      const hashed = await hashFiles({ "SKILL.md": skillMd("mine") });

      // As the owner's own save would keep it, with no change.
      skills.put(
        "0000abcd",
        { name: "mine", description: "What mine does.", files: hashed.files, source: null },
        hashed.contents,
        1_000,
      );
      skills.put(
        "0000abcd",
        { name: "yours", description: "What yours does.", files: hashed.files, source: null },
        hashed.contents,
        1_000,
      );

      const count = () =>
        storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM skill_files")
          .toArray()[0]?.count;

      const removed = removeSkill(
        { storage, store, skills, bundle },
        { environment: "0000abcd", name: "mine" },
      );

      const afterRemove = count();

      store.deleteEnvironment("0000abcd");

      return [removed, afterRemove, count(), skills.list("0000abcd")];
    });

    expect(counts).toEqual([{ status: "removed" }, 1, 0, []]);
  });
});

const EVERY = EVERY_ENVIRONMENT_SCOPE;

/** About 1 MB a Skill: 8 files of 126 KB. */
const big = (name: string): SkillFiles => ({
  "SKILL.md": skillMd(name),
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, at) => [
      `references/${at}.md`,
      `${name} ${at}.\n`.repeat(14_000),
    ]),
  ),
});

describe("Skills kept for every Environment", () => {
  it("are kept under the scope *, recorded under it with their files, and reach every Environment's set", async () => {
    const [saved, listed, changed, defaults, others] = await inRegistry(
      async ({ store, save, skills, changes, set }) => {
        store.createEnvironment("0000abcd", "Other", 1_000);

        return [
          await save("release", release, 1_000, EVERY),
          skills.list(EVERY),
          changes.list(EVERY),
          await set(),
          await set("0000abcd"),
        ];
      },
    );

    expect(saved).toMatchObject({
      status: "saved",
      environment: { id: "*", name: "every Environment" },
      skill: { name: "release" },
      inherited: false,
      overriddenIn: [],
    });
    expect(listed).toEqual([expect.objectContaining({ name: "release", savedAt: 1_000 })]);
    expect(changed).toEqual([
      expect.objectContaining({
        scope: "*",
        field: skillField("release"),
        actor: "agent",
        before: null,
      }),
    ]);

    const expected = {
      "release/SKILL.md": release["SKILL.md"],
      "release/references/steps.md": release["references/steps.md"],
      ...BUNDLE.files,
    };

    expect(defaults.files).toEqual(expected);
    expect(others.files).toEqual(expected);
  });

  it("keep no row of an Environment's own and stay when an Environment is deleted", async () => {
    const [own, every] = await inRegistry(async ({ store, save, skills }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("release", release, 1_000, EVERY);
      store.deleteEnvironment("0000abcd");

      return [skills.list("0000abcd"), skills.list(EVERY)];
    });

    expect(own).toEqual([]);
    expect(every).toHaveLength(1);
  });

  it("hide the bundle's Skill of the same name, and an Environment's own Skill of the name hides them there only", async () => {
    const everyPr = { "SKILL.md": skillMd("pr", "Our pr for every Environment.") };
    const ownPr = { "SKILL.md": skillMd("pr", "Default's own pr.") };

    const [everywhere, withOwn, other] = await inRegistry(async ({ store, save, set }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("pr", everyPr, 1_000, EVERY);

      const before = await set();

      await save("pr", ownPr, 2_000);

      return [before, await set(), await set("0000abcd")];
    });

    expect(everywhere.files["pr/SKILL.md"]).toBe(everyPr["SKILL.md"]);
    expect(withOwn.files["pr/SKILL.md"]).toBe(ownPr["SKILL.md"]);
    expect(other.files["pr/SKILL.md"]).toBe(everyPr["SKILL.md"]);
    // The bundle's other Skill is served all the same, and no Skill's files are mixed.
    expect(withOwn.files["tdd/SKILL.md"]).toBe(BUNDLE.files["tdd/SKILL.md"]);
    expect(Object.keys(withOwn.files).sort()).toEqual(["pr/SKILL.md", "tdd/SKILL.md"]);
  });

  it("are replaced whole by an Environment's own Skill of the name, never file by file", async () => {
    const own = { "SKILL.md": skillMd("release", "Default's own.") };

    const set = await inRegistry(async ({ save, set }) => {
      await save("release", release, 1_000, EVERY);
      await save("release", own, 2_000);

      return set();
    });

    expect(Object.keys(set.files).filter((path) => path.startsWith("release/"))).toEqual([
      "release/SKILL.md",
    ]);
    expect(set.files["release/SKILL.md"]).toBe(own["SKILL.md"]);
  });

  it("change the set's hash, and an Environment's own copy of the name does not change it for a Skill kept for every Environment", async () => {
    const [bundleHash, everyHash, shadowedHash] = await inRegistry(async ({ save, set }) => {
      const first = await set();

      await save("release", { "SKILL.md": skillMd("release", "Own.") }, 500);

      const shadowed = await set();

      await save("release", release, 1_000, EVERY);

      return [first.hash, (await set("0000abcd")).hash, (await set()).hash === shadowed.hash];
    });

    expect(bundleHash).toBe(BUNDLE.hash);
    expect(everyHash).not.toBe(BUNDLE.hash);
    // The Environment's own `release` hides the one kept for every Environment: its set did not change.
    expect(shadowedHash).toBe(true);
  });

  it("say which Environments' own Skills hide a save, and whether an Environment's own save hides the one for every Environment", async () => {
    const [everyOne, ownOne] = await inRegistry(async ({ store, save }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("release", { "SKILL.md": skillMd("release", "Other's.") }, 500, "0000abcd");

      const everySaved = await save("release", release, 1_000, EVERY);
      const ownSaved = await save("release", { "SKILL.md": skillMd("release", "Mine.") });

      return [everySaved, ownSaved];
    });

    expect(everyOne).toMatchObject({
      status: "saved",
      overriddenIn: [{ id: "0000abcd", name: "Other" }],
    });
    expect(ownOne).toMatchObject({ status: "saved", inherited: true, overriddenIn: [] });
  });

  it("are refused when a save would take an Environment's set past 100 Skills, naming the Environment", async () => {
    const saved = await inRegistry(async ({ store, save }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);

      // The bundle holds 2: 98 of Other's own make 100.
      for (let index = 0; index < 98; index += 1) {
        await save(`skill-${index}`, { "SKILL.md": skillMd(`skill-${index}`) }, 1_000, "0000abcd");
      }

      return [
        // A Skill Other already has by the name hides it there: nothing more is served.
        await save("skill-0", { "SKILL.md": skillMd("skill-0", "For all.") }, 2_000, EVERY),
        await save("one-more", { "SKILL.md": skillMd("one-more") }, 2_000, EVERY),
      ];
    });

    expect(saved[0]).toMatchObject({ status: "saved" });
    expect(saved[1]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining(
        `Environment "Other" (0000abcd)'s Skill set would hold 101 Skills, more than the 100`,
      ),
    });
  });

  it("are refused when a save would take an Environment's set past 8 MB, naming the Environment", async () => {
    const saved = await inRegistry(async ({ store, save, skills }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);

      for (let index = 0; index < 8; index += 1) {
        await save(`big-${index}`, big(`big-${index}`), 1_000, "0000abcd");
      }

      return [await save("big-8", big("big-8"), 2_000, EVERY), skills.list(EVERY)];
    });

    expect(saved[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining(`Environment "Other" (0000abcd)'s Skill set would be`),
    });
    expect(saved[1]).toEqual([]);
  });

  it("are refused when the set of an Environment keeping none of its own would pass 8 MB, though every Environment hides the Skill", async () => {
    const saved = await inRegistry(async ({ store, save, skills }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);

      for (let index = 0; index < 8; index += 1) {
        await save(`big-${index}`, big(`big-${index}`), 1_000, EVERY);
      }

      // Both Environments keep a small Skill of the name, so neither's set would hold the large one.
      await save("big-8", { "SKILL.md": skillMd("big-8") }, 1_000, "0000abcd");
      await save("big-8", { "SKILL.md": skillMd("big-8") }, 1_000);

      return [await save("big-8", big("big-8"), 2_000, EVERY), skills.list(EVERY).length];
    });

    expect(saved[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("keeping none of its own Skills would be"),
    });
    expect(saved[1]).toBe(8);
  });

  it("refuse an Environment's removal of its own Skill that hides a larger one kept for every Environment, when the set would pass 8 MB", async () => {
    const [save, agent, owner, reverted, kept] = await inRegistry(
      async ({ save, remove, revert, skills, store, storage, bundle }) => {
        for (let index = 0; index < 8; index += 1) {
          await save(`big-${index}`, big(`big-${index}`), 1_000, EVERY);
        }

        // Default hides big-0 with a small Skill of its own, and holds one more large Skill: 8 in all.
        const hiding = await save("big-0", { "SKILL.md": skillMd("big-0") }, 2_000);

        await save("extra", big("extra"), 2_100);

        return [
          hiding,
          remove("big-0", 3_000),
          removeSkill(
            { storage, store, skills, bundle },
            { environment: DEFAULT_ENVIRONMENT, name: "big-0" },
          ),
          // The change that made the Skill: its revert would take it out too.
          revert(hiding.status === "saved" ? hiding.change.id : 0, 4_000),
          skills.list(DEFAULT_ENVIRONMENT).map((skill) => skill.name),
        ];
      },
    );

    const refusal = expect.stringContaining(
      "the Skill of the name in the layer below, which big-0 hides, is served instead",
    );

    expect(save).toMatchObject({ status: "saved" });
    expect(agent).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("The Environment's Skill set would be"),
    });
    expect(agent).toMatchObject({ message: refusal });
    expect(owner).toMatchObject({ status: "rejected", message: refusal });
    expect(reverted).toMatchObject({ status: "refused", message: refusal });
    // Nothing was removed, and the refusals recorded nothing.
    expect(kept).toEqual(["big-0", "extra"]);
  });

  it("take out an Environment's own Skill that hides one kept for every Environment when the set still fits", async () => {
    const [removed, owner] = await inRegistry(async ({ save, remove }) => {
      await save("release", release, 1_000, EVERY);
      await save("release", { "SKILL.md": skillMd("release", "Mine.") }, 2_000);

      return [remove("release", 3_000), undefined];
    });

    expect(removed).toMatchObject({ status: "removed", inherited: true });
    expect(owner).toBeUndefined();
  });

  it("count in an Environment's own set, which a save of its own Skill is refused past 100 and 8 MB for", async () => {
    const saved = await inRegistry(async ({ save }) => {
      // The bundle's 2 and 97 for every Environment make 99.
      for (let index = 0; index < 97; index += 1) {
        await save(`every-${index}`, { "SKILL.md": skillMd(`every-${index}`) }, 1_000, EVERY);
      }

      return [
        await save("mine", { "SKILL.md": skillMd("mine") }),
        await save("one-more", { "SKILL.md": skillMd("one-more") }),
        // A Skill of the same name as one for every Environment replaces it in the Environment: no more Skills.
        await save("every-0", { "SKILL.md": skillMd("every-0", "Mine.") }, 2_000),
      ];
    });

    expect(saved[0]).toMatchObject({ status: "saved" });
    expect(saved[1]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("The Environment's Skill set would hold 101 Skills"),
    });
    expect(saved[2]).toMatchObject({ status: "saved" });
  });

  it("are checked without saving or recording: what the scope keeps of the name, and what a save would refuse", async () => {
    const edited = { ...release, "SKILL.md": skillMd("release", "What release does.", "Newer.") };

    const [fresh, same, newer, refused, changes, listed] = await inRegistry(
      async ({ save, check, changes, skills }) => {
        const first = await check("release", release, EVERY);

        await save("release", release, 1_000, EVERY);

        return [
          first,
          await check("release", { ...release }, EVERY),
          await check("release", edited, EVERY),
          await check("release", { "README.md": "Hi.\n" }, EVERY),
          changes.list(EVERY).length,
          skills.list(EVERY).length,
        ];
      },
    );

    expect(fresh).toMatchObject({
      status: "ready",
      environment: { id: "*" },
      name: "release",
      description: "What release does.",
      current: null,
    });
    expect(same).toMatchObject({ status: "unchanged", current: { savedAt: 1_000 } });
    expect(newer).toMatchObject({
      status: "ready",
      current: {
        description: "What release does.",
        savedAt: 1_000,
        files: ["SKILL.md", "references/steps.md"],
      },
    });
    expect(refused).toMatchObject({ status: "rejected" });
    // Only the one save was recorded and kept.
    expect(changes).toBe(1);
    expect(listed).toBe(1);
  });

  it("are saved or removed against what the owner was shown, `expected`, or not at all", async () => {
    const edited = { ...release, "SKILL.md": skillMd("release", "What release does.", "Newer.") };

    const [stale, fresh, staleRemoval, freshRemoval, absent] = await inRegistry(
      async ({ save, remove }) => {
        await save("release", release, 1_000, EVERY);

        // Saved again after the owner was asked (when it was last saved at 1000).
        await save("release", { ...release, "NOTES.md": "More.\n" }, 2_000, EVERY);

        const stale = await save("release", edited, 3_000, EVERY, { savedAt: 1_000 });
        const fresh = await save("release", edited, 3_000, EVERY, { savedAt: 2_000 });
        const staleRemoval = remove("release", 4_000, EVERY, { savedAt: 2_000 });
        const freshRemoval = remove("release", 5_000, EVERY, { savedAt: 3_000 });
        const absent = remove("release", 6_000, EVERY, { savedAt: 3_000 });

        return [stale, fresh, staleRemoval, freshRemoval, absent];
      },
    );

    expect(stale).toMatchObject({ status: "changed-since" });
    expect(fresh).toMatchObject({ status: "saved" });
    expect(staleRemoval).toMatchObject({ status: "changed-since" });
    expect(freshRemoval).toMatchObject({ status: "removed" });
    expect(absent).toMatchObject({ status: "absent" });
  });

  it("are removed as an Agent change under the scope *, saying which Environments keep their own and what is served instead", async () => {
    const [everyRemoval, ownRemoval, set, changes] = await inRegistry(
      async ({ store, save, remove, set, changes }) => {
        store.createEnvironment("0000abcd", "Other", 1_000);
        await save("release", release, 1_000, EVERY);
        await save("release", { "SKILL.md": skillMd("release", "Other's.") }, 1_500, "0000abcd");

        const everyRemoval = remove("release", 2_000, EVERY);

        await save("pr", { "SKILL.md": skillMd("pr", "For all.") }, 2_500, EVERY);
        await save("pr", { "SKILL.md": skillMd("pr", "Mine.") }, 2_600);

        // Mine hides the one for every Environment, which is served again once it is gone.
        const ownRemoval = remove("pr", 3_000);

        return [everyRemoval, ownRemoval, await set(), changes.list(EVERY)];
      },
    );

    expect(everyRemoval).toMatchObject({
      status: "removed",
      environment: { id: "*" },
      bundled: false,
      inherited: false,
      overriddenIn: [{ id: "0000abcd", name: "Other" }],
    });
    expect(ownRemoval).toMatchObject({ status: "removed", bundled: true, inherited: true });
    // The default Environment now serves the one for every Environment, not the bundle's.
    expect(set.files["pr/SKILL.md"]).toContain("For all.");
    expect(changes.map(({ field, after }) => [field, after === null])).toEqual([
      [skillField("pr"), false],
      [skillField("release"), true],
      [skillField("release"), false],
    ]);
  });
});

describe("the Agent changes of Skills kept for every Environment", () => {
  it("are reverted by the owner, as an owner's change under the scope *, with no Approval", async () => {
    const edited = { "SKILL.md": skillMd("release", "Edited.") };

    const [afterLatest, afterFirst, recorded] = await inRegistry(
      async ({ save, revert, skills, changes }) => {
        await save("release", release, 1_000, EVERY);
        await save("release", edited, 2_000, EVERY);

        const [latest, first] = changes.list(EVERY);

        expect(revert(latest!.id, 3_000, EVERY)).toMatchObject({ status: "reverted" });

        const restored = skills.get(EVERY, "release");

        expect(revert(first!.id, 4_000, EVERY)).toMatchObject({ status: "reverted" });

        return [restored, skills.get(EVERY, "release"), changes.list(EVERY)];
      },
    );

    expect(afterLatest).toMatchObject({ description: "What release does." });
    expect(afterFirst).toBeNull();
    expect(recorded.filter((change) => change.actor === "owner")).toHaveLength(2);
    expect(recorded.every((change) => change.scope === "*")).toBe(true);
  });

  it("revert a removal by bringing the Skill back for every Environment, and refuse a revert once it was saved again", async () => {
    const [restored, refused] = await inRegistry(
      async ({ save, remove, revert, changes, skills }) => {
        await save("release", release, 1_000, EVERY);
        remove("release", 2_000, EVERY);

        const [removal] = changes.list(EVERY);
        const back = revert(removal!.id, 3_000, EVERY);

        // The first save gave the Skill files it no longer has.
        await save("release", { "SKILL.md": skillMd("release", "Again.") }, 4_000, EVERY);

        const [, , , first] = changes.list(EVERY);

        return [[back, skills.get(EVERY, "release")], revert(first!.id, 5_000, EVERY)];
      },
    );

    expect(restored).toMatchObject([
      { status: "reverted" },
      { name: "release", description: "Again." },
    ]);
    expect(refused).toMatchObject({
      status: "refused",
      message: expect.stringContaining("saved again since"),
    });
  });

  it("refuse a revert that would bring a Skill back past a limit of an Environment's set, naming it", async () => {
    const reverted = await inRegistry(async ({ store, save, remove, revert, changes }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      await save("one-more", { "SKILL.md": skillMd("one-more") }, 1_000, EVERY);
      remove("one-more", 2_000, EVERY);

      // Other fills its set meanwhile: the bundle's 2 and 98 of its own.
      for (let index = 0; index < 98; index += 1) {
        await save(`skill-${index}`, { "SKILL.md": skillMd(`skill-${index}`) }, 3_000, "0000abcd");
      }

      const [removal] = changes.list(EVERY);

      return revert(removal!.id, 4_000, EVERY);
    });

    expect(reverted).toMatchObject({
      status: "refused",
      message: expect.stringContaining(`Environment "Other" (0000abcd)'s Skill set would hold 101`),
    });
  });

  it("keep their files while a change refers to them, and drop them with the pruned change", async () => {
    const [kept, dropped] = await inRegistry(async ({ save, remove, storage }) => {
      await save("gone", { "SKILL.md": skillMd("gone"), "OLD.md": "Only here.\n" }, 1_000, EVERY);
      remove("gone", 1_500, EVERY);

      const has = (text: string) =>
        storage.sql.exec("SELECT 1 FROM skill_files WHERE content = ?", text).toArray().length > 0;

      const before = has("Only here.\n");

      for (let index = 0; index < MAX_AGENT_CHANGES; index += 1) {
        await save(
          "churn",
          { "SKILL.md": skillMd("churn", `Version ${index}.`) },
          3_000 + index,
          EVERY,
        );
      }

      return [before, has("Only here.\n")];
    });

    expect(kept).toBe(true);
    expect(dropped).toBe(false);
  });

  it("go with the owner's removal of a Skill kept for every Environment, which records no change", async () => {
    const [removed, left, changes] = await inRegistry(
      async ({ save, skills, storage, changes, store, bundle }) => {
        await save("release", release, 1_000, EVERY);
        // As the page's Remove does: the owner's save, with no Agent change of its own.

        const gone = removeSkill(
          { storage, store, skills, bundle },
          { environment: EVERY, name: "release" },
        );

        return [gone, skills.list(EVERY), changes.list(EVERY).length];
      },
    );

    expect(removed).toEqual({ status: "removed" });
    expect(left).toEqual([]);
    // The save's change is the only one.
    expect(changes).toBe(1);
  });
});
