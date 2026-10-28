// Installing Skills from GitHub into an Environment over real Durable Object SQLite (ADR-0026, docs/spec.md → Installing
// from GitHub): fetched through a fake `RepoReader`, kept with their Skill source, recorded as Agent changes when the agent
// installs and as nothing when the owner does, and put back with their source by a revert.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- fakes of `fetch` and the Registry over native arrays.
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_ENVIRONMENT,
  type SkillInstallPin,
  type SkillInstallPreview,
  type SkillSource,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GithubReadError, type RepoReader } from "../github/skill-fetch.ts";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import { installSkills, previewSkillInstall } from "./skill-install.ts";
import {
  contentHash,
  hashBundle,
  hashFiles,
  mergeSkills,
  openSkills,
  removeSkillAs,
  saveSkillAs,
  skillChangeFiles,
  skillSetOf,
} from "./skills.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_skill_install",
  reason: "The user asked for the grill-me Skill",
};

const BUNDLE = {
  hash: "bundle-version-1",
  files: { "pr/SKILL.md": "---\nname: pr\ndescription: The bundled pr.\n---\nBundled.\n" },
};

const COMMIT = "c0ffee0000000000000000000000000000000001";
const LATER = "c0ffee0000000000000000000000000000000002";

const skillMd = (name: string, body = "Steps.") =>
  `---\nname: ${name}\ndescription: What ${name} does.\n---\n${body}\n`;

type Repo = Readonly<Record<string, string>>;

/** A reader over a repo's files, whose default branch's head is `commit`. */
const readerOf = (files: Repo, commit = COMMIT): RepoReader => ({
  commit: async () => commit,
  tree: async () => ({
    truncated: false,
    entries: Object.entries(files).map(([path, text]) => ({
      path,
      type: "blob" as const,
      sha: path,
      size: text.length,
    })),
  }),
  blob: async (_repo, sha) => new TextEncoder().encode(files[sha] ?? ""),
});

/** What an Approval of the Skills `named` of a preview is asked against. */
const pinOf = (previewed: SkillInstallPreview, named: ReadonlyArray<string>): SkillInstallPin => {
  if (previewed.status !== "previewed") throw new Error("the preview shows no Skills");

  return {
    commit: previewed.commit,
    skills: previewed.skills
      .filter((skill) => named.includes(skill.name))
      .map(({ name, path, digest, current }) => ({
        name,
        path,
        digest,
        savedAt: current?.savedAt ?? null,
      })),
  };
};

const REPO = {
  "skills/grill-me/SKILL.md": skillMd("grill-me"),
  "skills/grill-me/references/questions.md": "- why?\n",
  "skills/tdd/SKILL.md": skillMd("tdd"),
} satisfies Repo;

const GRILL_SOURCE: SkillSource = {
  repo: "o/skills",
  path: "skills/grill-me",
  ref: null,
  commit: COMMIT,
};

/** Run `body` over a fresh Registry's store, Skills and Agent changes. */
const inRegistry = <A>(
  body: (registry: {
    readonly install: (
      reader: RepoReader,
      input: {
        source: string;
        skills?: string[];
        owner?: boolean;
        environment?: string;
        pin?: SkillInstallPin;
      },
      at?: number,
    ) => ReturnType<typeof installSkills>;
    readonly preview: (
      reader: RepoReader,
      input: { source: string; skills?: string[]; environment?: string },
    ) => ReturnType<typeof previewSkillInstall>;
    readonly skills: ReturnType<typeof openSkills>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly revert: (id: number, at?: number) => ReturnType<typeof revertAgentChange>;
    readonly set: () => Promise<{ hash: string; files: Record<string, string> }>;
    readonly storage: DurableObjectStorage;
    readonly context: (at: number) => Parameters<typeof saveSkillAs>[0];
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const changes = openAgentChanges(state.storage);
      const skills = openSkills(state.storage);
      const bundle = await hashBundle(BUNDLE);

      const context = (now: number) => ({
        storage: state.storage,
        store,
        skills,
        changes,
        bundle,
        now,
      });

      return body({
        skills,
        changes,
        storage: state.storage,
        context,
        install: (reader, { source, skills: names, owner = false, environment, pin }, at = 1_000) =>
          installSkills(context(at), reader, {
            environment: environment ?? DEFAULT_ENVIRONMENT,
            source,
            skills: names,
            author: owner ? null : { ...author, approved: environment === "*" ? true : undefined },
            pin,
          }),
        preview: (reader, { source, skills: names, environment }) =>
          previewSkillInstall(context(1_000), reader, {
            environment: environment ?? DEFAULT_ENVIRONMENT,
            source,
            skills: names,
          }),
        revert: (id, at = 3_000) =>
          revertAgentChange(
            state.storage,
            store,
            changes,
            { environment: DEFAULT_ENVIRONMENT, id },
            at,
            { skills, bundle },
          ),
        set: async () => {
          const merged = await mergeSkills([skills.list(DEFAULT_ENVIRONMENT)], bundle);

          return skillSetOf(merged, bundle, skills);
        },
      });
    },
  );

describe("installing Skills from GitHub", () => {
  it("keeps the Skill the source names with its Skill source, serves it, and records an Agent change", async () => {
    const [installed, listed, set, changes] = await inRegistry(
      async ({ install, skills, set, changes }) => [
        await install(readerOf(REPO), { source: "o/skills@grill-me" }),
        skills.list(DEFAULT_ENVIRONMENT),
        await set(),
        changes.list(DEFAULT_ENVIRONMENT),
      ],
    );

    expect(installed).toMatchObject({
      status: "installed",
      repo: "o/skills",
      ref: null,
      commit: COMMIT,
      results: [
        { name: "grill-me", path: "skills/grill-me", outcome: "installed", shadows: false },
      ],
    });

    expect(listed).toEqual([
      expect.objectContaining({
        name: "grill-me",
        description: "What grill-me does.",
        source: GRILL_SOURCE,
      }),
    ]);

    expect(set.files).toMatchObject({
      "grill-me/SKILL.md": skillMd("grill-me"),
      "grill-me/references/questions.md": "- why?\n",
      "pr/SKILL.md": BUNDLE.files["pr/SKILL.md"],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor: "agent",
      tool: "environment_skill_install",
      field: "skills.grill-me",
      before: null,
      after: { files: expect.any(Object), source: GRILL_SOURCE },
    });
  });

  it("pins the ref the source named and the commit it resolved to", async () => {
    const [listed] = await inRegistry(async ({ install, skills }) => {
      await install(readerOf(REPO), {
        source: "https://github.com/o/skills/tree/v2/skills/tdd",
      });

      return [skills.list(DEFAULT_ENVIRONMENT)];
    });

    expect(listed).toEqual([
      expect.objectContaining({
        name: "tdd",
        source: { repo: "o/skills", path: "skills/tdd", ref: "v2", commit: COMMIT },
      }),
    ]);
  });

  it("installs nothing and lists the Skills a repo holds when none is named", async () => {
    const [installed, listed, changes] = await inRegistry(async ({ install, skills, changes }) => [
      await install(readerOf(REPO), { source: "o/skills" }),
      skills.list(DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(installed).toMatchObject({
      status: "listed",
      commit: COMMIT,
      available: [
        { name: "grill-me", path: "skills/grill-me" },
        { name: "tdd", path: "skills/tdd" },
      ],
    });

    expect(listed).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('installs every Skill of a repo for ["*"]', async () => {
    const [installed, listed] = await inRegistry(async ({ install, skills }) => [
      await install(readerOf(REPO), { source: "o/skills", skills: ["*"] }),
      skills.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(installed).toMatchObject({ status: "installed" });
    expect(listed.map((skill) => skill.name)).toEqual(["grill-me", "tdd"]);
  });

  it("is the owner's install from the page: kept with its source, recorded as no Agent change", async () => {
    const [installed, listed, changes] = await inRegistry(async ({ install, skills, changes }) => [
      await install(readerOf(REPO), { source: "o/skills@grill-me", owner: true }),
      skills.list(DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(installed).toMatchObject({
      status: "installed",
      results: [{ name: "grill-me", outcome: "installed" }],
    });

    expect(
      installed.status === "installed" ? installed.results[0]?.change : "not installed",
    ).toBeUndefined();
    expect(listed[0]?.source).toEqual(GRILL_SOURCE);
    expect(changes).toEqual([]);
  });

  it("says unchanged for the same commit again, and keeps the new commit when the files are the same but it moved", async () => {
    const [again, moved, listed, changes] = await inRegistry(
      async ({ install, skills, changes }) => {
        await install(readerOf(REPO), { source: "o/skills@grill-me" }, 1_000);

        return [
          await install(readerOf(REPO), { source: "o/skills@grill-me" }, 2_000),
          await install(readerOf(REPO, LATER), { source: "o/skills@grill-me" }, 3_000),
          skills.list(DEFAULT_ENVIRONMENT),
          changes.list(DEFAULT_ENVIRONMENT),
        ];
      },
    );

    expect(again).toMatchObject({ results: [{ name: "grill-me", outcome: "unchanged" }] });
    expect(moved).toMatchObject({ results: [{ name: "grill-me", outcome: "installed" }] });
    expect(listed[0]?.source).toEqual({ ...GRILL_SOURCE, commit: LATER });
    // The install, then the new commit: the unchanged one recorded nothing.
    expect(changes).toHaveLength(2);
  });

  it("replaces a Skill of the name the Environment keeps, and a revert puts back its files and no source", async () => {
    const [saved, reverted, listed] = await inRegistry(
      async ({ install, skills, revert, context }) => {
        const mine = { "SKILL.md": skillMd("grill-me", "Mine.") };

        const first = saveSkillAs(context(500), {
          environment: DEFAULT_ENVIRONMENT,
          folder: "grill-me",
          files: mine,
          hashed: await hashFiles(mine),
          author: { ...author, tool: "environment_skill_save" },
        });

        const installed = await install(readerOf(REPO), { source: "o/skills@grill-me" });
        const change = installed.status === "installed" ? installed.results[0]?.change : undefined;

        return [first, revert(change?.id ?? -1), skills.list(DEFAULT_ENVIRONMENT)];
      },
    );

    expect(saved).toMatchObject({ status: "saved", skill: { source: null } });
    expect(reverted).toMatchObject({ status: "reverted" });
    expect(listed).toEqual([expect.objectContaining({ name: "grill-me", source: null })]);
    expect(listed[0]?.files["SKILL.md"]).toBe(await contentHash(skillMd("grill-me", "Mine.")));
  });

  it("is reverted by removing the Skill it added, and refused once the Skill was saved again", async () => {
    const [reverted, listed, refused] = await inRegistry(
      async ({ install, skills, revert, context }) => {
        const installed = await install(readerOf(REPO), { source: "o/skills@grill-me" });
        const change = installed.status === "installed" ? installed.results[0]?.change : undefined;
        const after = revert(change?.id ?? -1, 2_000);

        const second = await install(readerOf(REPO), { source: "o/skills@grill-me" }, 3_000);
        const secondChange = second.status === "installed" ? second.results[0]?.change : undefined;
        const edited = { "SKILL.md": skillMd("grill-me", "Edited.") };

        saveSkillAs(context(4_000), {
          environment: DEFAULT_ENVIRONMENT,
          folder: "grill-me",
          files: edited,
          hashed: await hashFiles(edited),
          author: { ...author, tool: "environment_skill_save" },
        });

        return [after, skills.list(DEFAULT_ENVIRONMENT), revert(secondChange?.id ?? -1, 5_000)];
      },
    );

    expect(reverted).toMatchObject({ status: "reverted" });
    // The second install's Skill was edited by a save since, so reverting its install is refused.
    expect(refused).toMatchObject({ status: "refused" });
    expect(listed[0]?.files["SKILL.md"]).toBe(await contentHash(skillMd("grill-me", "Edited.")));
  });

  it("keeps the source of a Skill the agent saves again from its Workspace, and a removal's revert brings it back", async () => {
    const [saved, afterRemove, reverted, listed] = await inRegistry(
      async ({ install, skills, revert, context }) => {
        await install(readerOf(REPO), { source: "o/skills@grill-me" });

        const edited = { "SKILL.md": skillMd("grill-me", "Edited."), "extra.md": "more\n" };

        const save = saveSkillAs(context(2_000), {
          environment: DEFAULT_ENVIRONMENT,
          folder: "grill-me",
          files: edited,
          hashed: await hashFiles(edited),
          author: { ...author, tool: "environment_skill_save" },
        });

        const removal = removeSkillAs(context(3_000), {
          environment: DEFAULT_ENVIRONMENT,
          name: "grill-me",
          author: { ...author, tool: "environment_skill_remove" },
        });

        const gone = skills.list(DEFAULT_ENVIRONMENT);
        const undo = revert(removal.status === "removed" ? removal.change.id : -1, 4_000);

        return [save, gone, undo, skills.list(DEFAULT_ENVIRONMENT)];
      },
    );

    expect(saved).toMatchObject({ status: "saved", skill: { source: GRILL_SOURCE } });
    expect(afterRemove).toEqual([]);
    expect(reverted).toMatchObject({ status: "reverted" });
    expect(listed).toEqual([expect.objectContaining({ name: "grill-me", source: GRILL_SOURCE })]);
  });

  it("keeps the source of a Skill kept for every Environment that the agent saves again", async () => {
    const [saved, change, listed] = await inRegistry(async ({ skills, context, changes }) => {
      const kept = { "SKILL.md": skillMd("grill-me") };
      const hashedKept = await hashFiles(kept);

      skills.put(
        "*",
        {
          name: "grill-me",
          description: "What grill-me does.",
          files: hashedKept.files,
          source: GRILL_SOURCE,
        },
        hashedKept.contents,
        1_000,
      );

      const edited = { "SKILL.md": skillMd("grill-me", "Edited.") };

      const save = saveSkillAs(context(2_000), {
        environment: "*",
        folder: "grill-me",
        files: edited,
        hashed: await hashFiles(edited),
        author: { ...author, tool: "environment_skill_save" },
      });

      return [save, changes.list("*")[0], skills.list("*")];
    });

    expect(saved).toMatchObject({ status: "saved", skill: { source: GRILL_SOURCE } });
    expect(change).toMatchObject({
      before: { source: GRILL_SOURCE },
      after: { source: GRILL_SOURCE },
    });
    expect(listed).toEqual([expect.objectContaining({ name: "grill-me", source: GRILL_SOURCE })]);
  });

  it("counts the Skills kept for every Environment in the set an install would make", async () => {
    const results = await inRegistry(async ({ install, skills }) => {
      // The bundle holds `pr`: 99 more Skills for every Environment make 100, the most a set may hold.
      for (let at = 0; at < 99; at += 1) {
        const files = { "SKILL.md": skillMd(`every-${at}`) };
        const hashed = await hashFiles(files);

        skills.put(
          "*",
          {
            name: `every-${at}`,
            description: `What every-${at} does.`,
            files: hashed.files,
            source: null,
          },
          hashed.contents,
          1_000,
        );
      }

      const result = await install(readerOf(REPO), { source: "o/skills@grill-me" });

      return result.status === "installed" ? result.results : result;
    });

    expect(results).toEqual([
      expect.objectContaining({
        name: "grill-me",
        outcome: "rejected",
        message: expect.stringContaining("would hold 101 Skills, more than the 100 a set may"),
      }),
    ]);
  });

  it("shows the files an install added through the Agent change's texts", async () => {
    const [files] = await inRegistry(async ({ install, skills, changes }) => {
      await install(readerOf(REPO), { source: "o/skills@grill-me" });

      const [change] = changes.list(DEFAULT_ENVIRONMENT);

      return [change === undefined ? null : skillChangeFiles(skills, change)];
    });

    expect(files).toEqual({
      before: null,
      after: [
        { path: "SKILL.md", text: skillMd("grill-me") },
        { path: "references/questions.md", text: "- why?\n" },
      ],
    });
  });

  it("installs the Skills the checks accept and reports the ones they refuse", async () => {
    const files = {
      "skills/fine/SKILL.md": skillMd("fine"),
      "skills/leaky/SKILL.md": skillMd("leaky"),
      "skills/leaky/notes.md": "api_key = 'abcdefghijklmnopqrstuvwxyz0123'\n",
      "skills/Bad_Name/SKILL.md": skillMd("Bad_Name"),
    } satisfies Repo;

    const [installed, listed] = await inRegistry(async ({ install, skills }) => [
      await install(readerOf(files), { source: "o/mixed", skills: ["*"] }),
      skills.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(listed.map((skill) => skill.name)).toEqual(["fine"]);
    expect(installed).toMatchObject({ status: "installed" });

    const results = installed.status === "installed" ? installed.results : [];

    expect(
      results
        .map((result) => [result.name, result.outcome])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ["Bad_Name", "rejected"],
      ["fine", "installed"],
      ["leaky", "rejected"],
    ]);

    expect(results.find((result) => result.name === "leaky")?.message).toContain("credential");
    expect(results.find((result) => result.name === "Bad_Name")?.message).toContain("lowercase");
  });

  it("keeps the Skills for every Environment recorded under *, as approved when the install says so, and names the Environments whose own Skill hides one", async () => {
    const [installed, listed, changes, set] = await inRegistry(
      async ({ install, skills, changes, context }) => {
        const own = { "SKILL.md": skillMd("tdd", "Mine.") };

        saveSkillAs(context(500), {
          environment: DEFAULT_ENVIRONMENT,
          folder: "tdd",
          files: own,
          hashed: await hashFiles(own),
          author: { ...author, tool: "environment_skill_save" },
        });

        const done = await install(readerOf(REPO), {
          environment: "*",
          source: "o/skills",
          skills: ["*"],
        });

        return [done, skills.list("*"), changes.list("*"), skills.list(DEFAULT_ENVIRONMENT)];
      },
    );

    expect(installed).toMatchObject({
      status: "installed",
      environment: { id: "*", name: "every Environment" },
      results: [
        { name: "grill-me", outcome: "installed", overriddenIn: [] },
        {
          name: "tdd",
          outcome: "installed",
          overriddenIn: [expect.objectContaining({ id: DEFAULT_ENVIRONMENT })],
        },
      ],
    });
    expect(listed.map((skill) => skill.name)).toEqual(["grill-me", "tdd"]);
    expect(listed[0]?.source).toEqual(GRILL_SOURCE);
    // Newest first.
    expect(changes.map((change) => [change.scope, change.field, change.approved])).toEqual([
      ["*", "skills.tdd", true],
      ["*", "skills.grill-me", true],
    ]);
    // The Environment's own tdd is untouched.
    expect(set.map((skill) => skill.name)).toEqual(["tdd"]);
  });

  it("reads at the commit it was pinned to, keeping a Skill only if it is the one the owner was shown, and while the Skill of its name is the one that was", async () => {
    const asked: Array<string | null> = [];

    const reader: RepoReader = {
      ...readerOf(REPO, COMMIT),
      commit: async (_repo, ref) => {
        asked.push(ref);

        return ref ?? COMMIT;
      },
    };

    const [done, again, notShown, listed] = await inRegistry(
      async ({ install, preview, skills, context }) => {
        const shown = await preview(reader, {
          environment: "*",
          source: "o/skills",
          skills: ["*"],
        });

        const pin = pinOf(shown, ["grill-me"]);

        // The branch moved on since the owner was shown the Skills; they are read at the commit they saw.
        const first = await install(reader, {
          environment: "*",
          source: "o/skills@grill-me",
          skills: ["grill-me"],
          pin: { ...pin, commit: LATER },
        });

        // The Skill of the name was saved again since the owner was asked.
        const edited = { "SKILL.md": skillMd("tdd", "Saved meanwhile.") };

        saveSkillAs(context(1_500), {
          environment: "*",
          folder: "tdd",
          files: edited,
          hashed: await hashFiles(edited),
          author: { ...author, tool: "environment_skill_save" },
        });

        const second = await install(reader, {
          environment: "*",
          source: "o/skills",
          skills: ["tdd"],
          pin: { ...pinOf(shown, ["tdd"]), commit: LATER },
        });

        // A Skill whose files are not the ones shown. Only the Skills the pin names have a result.
        const third = await install(reader, {
          environment: "*",
          source: "o/skills",
          skills: ["*"],
          pin: {
            commit: LATER,
            skills: [{ ...pin.skills[0]!, digest: "not-the-digest-shown" }],
          },
        });

        return [first, second, third, skills.list("*")];
      },
    );

    // The ref was the commit the owner saw, not the branch's head now; the Skill source names the ref as written.
    expect(asked).toContain(LATER);
    expect(done).toMatchObject({
      status: "installed",
      commit: LATER,
      ref: null,
      results: [{ name: "grill-me", outcome: "installed" }],
    });
    expect(again).toMatchObject({
      results: [
        {
          name: "tdd",
          outcome: "rejected",
          message: expect.stringContaining("saved again since the user was asked"),
        },
      ],
    });
    expect(notShown).toMatchObject({
      results: [
        {
          name: "grill-me",
          outcome: "rejected",
          message: expect.stringContaining("its files are not the ones the user was shown"),
        },
      ],
    });
    expect(notShown).toMatchObject({ results: [expect.anything()] });
    expect(listed.find((skill) => skill.name === "grill-me")?.source).toEqual({
      ...GRILL_SOURCE,
      commit: LATER,
    });
    expect(listed.find((skill) => skill.name === "tdd")?.description).toBe("What tdd does.");
  });

  it("reads exactly the folders the owner was shown, never choosing again by name: a folder named foo that holds bar is not the Skill foo", async () => {
    const swapped = {
      "x/foo/SKILL.md": skillMd("bar"),
      "bar/SKILL.md": skillMd("foo"),
      "skills/secret/SKILL.md": `---\nname: secret\ndescription: Internal.\nmetadata:\n  internal: true\n---\nHidden.\n`,
    };

    const [done, listed, missing] = await inRegistry(async ({ install, preview, skills }) => {
      const shown = await preview(readerOf(swapped), {
        environment: "*",
        source: "o/skills",
        skills: ["*"],
      });

      // The owner approved the Skill foo, which is in the folder bar. Selecting by the name foo finds the folder x/foo.
      const pin = pinOf(shown, ["foo"]);

      const first = await install(readerOf(swapped), {
        environment: "*",
        source: "o/skills@foo",
        skills: ["foo"],
        pin,
      });

      // A pinned folder that holds no Skill at the commit is reported, not dropped.
      const second = await install(readerOf(swapped), {
        environment: "*",
        source: "o/skills",
        pin: {
          commit: COMMIT,
          skills: [...pin.skills, { name: "gone", path: "gone", digest: "x", savedAt: null }],
        },
      });

      return [first, skills.list("*"), second];
    });

    expect(done).toMatchObject({
      results: [{ name: "foo", path: "bar", outcome: "installed" }],
    });
    expect(listed.map((skill) => skill.name)).toEqual(["foo"]);
    expect(listed[0]?.source).toMatchObject({ path: "bar" });
    expect(missing).toMatchObject({
      results: [
        { name: "foo", path: "bar", outcome: "unchanged" },
        {
          name: "gone",
          path: "gone",
          outcome: "rejected",
          message: expect.stringContaining("no SKILL.md is in the folder gone"),
        },
      ],
    });
  });

  it("refuses a preview of more Skills than one Approval shows, before reading their files", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, at) => [`skills/s${at}/SKILL.md`, skillMd(`s${at}`)]),
    );

    const reads: string[] = [];
    const reader = readerOf(many);

    const counted: RepoReader = {
      ...reader,
      blob: async (repo, sha) => {
        reads.push(sha);

        return reader.blob(repo, sha);
      },
    };

    const [refused, own] = await inRegistry(async ({ preview, install }) => [
      await preview(counted, { environment: "*", source: "o/skills", skills: ["*"] }),
      // An Environment's own install has no such bound.
      await install(counted, { source: "o/skills", skills: ["*"] }),
    ]);

    expect(refused).toMatchObject({
      status: "refused",
      message: expect.stringContaining("more than the 10 one request may take"),
    });
    expect(own).toMatchObject({ status: "installed" });
  });

  it("is the owner's install for every Environment: kept with its source, no Agent change, the checks across every Environment's set", async () => {
    const [installed, listed, changes] = await inRegistry(async ({ install, skills, changes }) => [
      await install(readerOf(REPO), { environment: "*", source: "o/skills@tdd", owner: true }),
      skills.list("*"),
      changes.list("*"),
    ]);

    expect(installed).toMatchObject({
      status: "installed",
      environment: { id: "*" },
      results: [{ name: "tdd", outcome: "installed" }],
    });
    expect(listed).toEqual([expect.objectContaining({ name: "tdd" })]);
    expect(changes).toEqual([]);
  });

  it("previews what an install would keep, with the files, what is kept already and what the checks refuse, recording nothing", async () => {
    const files = {
      ...REPO,
      "skills/Bad Name/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\nBody.\n",
    };

    const [previewed, listedBefore, changes, several, nobody] = await inRegistry(
      async ({ install, preview, skills, changes }) => {
        await install(readerOf(REPO), { source: "o/skills@tdd", environment: "*" });

        const result = await preview(readerOf(files), {
          environment: "*",
          source: "o/skills",
          skills: ["*"],
        });

        return [
          result,
          skills.list("*").length,
          changes.list("*").length,
          await preview(readerOf(REPO), { environment: "*", source: "o/skills" }),
          await preview(readerOf(REPO), { environment: "0000beef", source: "o/skills@tdd" }),
        ];
      },
    );

    expect(previewed).toMatchObject({
      status: "previewed",
      environment: { id: "*" },
      repo: "o/skills",
      commit: COMMIT,
      skills: [
        {
          name: "grill-me",
          path: "skills/grill-me",
          description: "What grill-me does.",
          unchanged: false,
          current: null,
          files: { "SKILL.md": skillMd("grill-me"), "references/questions.md": "- why?\n" },
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        { name: "tdd", unchanged: true, current: { description: "What tdd does." } },
      ],
      rejected: [expect.objectContaining({ name: "Bad Name" })],
    });
    // Only the install before it kept anything.
    expect(listedBefore).toBe(1);
    expect(changes).toBe(1);
    expect(several).toMatchObject({ status: "listed" });
    expect(nobody).toEqual({ status: "missing" });
  });

  it("refuses what is not a GitHub source, a repo that cannot be read, and an Environment that does not exist", async () => {
    const [notGithub, gone, missing] = await inRegistry(async ({ install }) => [
      await install(readerOf(REPO), { source: "gitlab.com/o/r" }),
      await install(
        {
          ...readerOf(REPO),
          commit: async () => {
            throw GithubReadError.of("not_found", "GitHub has no repo o/skills");
          },
        },
        { source: "o/skills@tdd" },
      ),
      await install(readerOf(REPO), { source: "o/skills@tdd", environment: "0000beef" }),
    ]);

    expect(notGithub).toMatchObject({
      status: "refused",
      message: expect.stringContaining("owner/repo@skill"),
    });
    expect(gone).toMatchObject({
      status: "refused",
      message: "GitHub has no repo o/skills",
    });
    expect(missing).toEqual({ status: "missing" });
  });
});
