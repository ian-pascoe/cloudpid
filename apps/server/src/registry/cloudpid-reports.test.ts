// What a cloudpid report posts, without GitHub (`cloudpid-reports.ts`; `docs/architecture/agent-capabilities.md` →
// cloudpid reports, ADR-0051): which of the owner's Repos a title or body names, a row per term kind, exclusion and
// boundary; the mentions it defuses; and cloudpid's footer.
import { describe, expect, it } from "vitest";
import {
  type AgentCloudpidReportInput,
  cloudpidReportFooter,
  defuseMentions,
  namedRepoTerms,
} from "./cloudpid-reports.ts";

type Repo = { readonly name: string; readonly url: string };

const acme: Repo = {
  name: "acme-portal",
  url: "https://github.com/SpiritLedSoftware/acme-portal.git",
};

const plain: Repo = { name: "web", url: "https://github.com/spiritledsoftware/web.git" };
const own: Repo = { name: "cloudpid", url: "https://github.com/ian-pascoe/cloudpid.git" };
const ownElsewhere: Repo = { name: "cp-fork", url: "https://github.com/Ian-Pascoe/cloudpid" };
const mine: Repo = { name: "notes", url: "https://github.com/ian-pascoe/private-notes.git" };
const shortOwner: Repo = { name: "app", url: "https://github.com/abc/app.git" };
const shortName: Repo = { name: "x1", url: "https://github.com/abc/a-b1.git" };
const gitlab: Repo = { name: "infra", url: "https://gitlab.example.com/team/sub/infra-tools" };
const gitlabDir: Repo = { name: "ops-scripts", url: "https://gitlab.example.com/team/ops" };
const scp: Repo = { name: "acme-portal", url: "git@github.com:spiritledsoftware/acme-portal.git" };

describe("namedRepoTerms", () => {
  it.each<[string, ReadonlyArray<Repo>, string, ReadonlyArray<string>]>([
    [
      "a Repo's GitHub owner/name, in any case",
      [plain],
      "the clone of SpiritLedSoftware/Web failed",
      ["spiritledsoftware/web", "spiritledsoftware"],
    ],
    [
      "a Repo's owner, not ian-pascoe, of 4 or more characters",
      [plain],
      "cloning spiritledsoftware's repos",
      ["spiritledsoftware"],
    ],
    ["a Repo's directory", [plain], "ran pnpm test in /workspace/web", ["/workspace/web"]],
    [
      "a Repo's directory with / after it",
      [plain],
      "read /workspace/web/src/index.ts",
      ["/workspace/web"],
    ],
    [
      "a compound bare name of 6 or more characters",
      [acme],
      "acme-portal's tests hung",
      ["acme-portal"],
    ],
    [
      "a non-GitHub Repo's host/path and name",
      [gitlab],
      "gitlab.example.com/team/sub/infra-tools would not clone",
      ["gitlab.example.com/team/sub/infra-tools", "infra-tools"],
    ],
    ["not a non-GitHub Repo's first path segment as an owner", [gitlab], "the team's repos", []],
    ["a non-GitHub Repo's compound directory", [gitlabDir], "ops-scripts hung", ["ops-scripts"]],
    [
      "a URL it can't parse, whole, and its directory's compound name",
      [scp],
      "git@github.com:spiritledsoftware/acme-portal.git would not clone",
      ["git@github.com:spiritledsoftware/acme-portal.git", "acme-portal"],
    ],
    [
      "each term once, in the Repo's order",
      [acme],
      "acme-portal and /workspace/acme-portal and acme-portal",
      ["/workspace/acme-portal", "acme-portal"],
    ],
    ["nothing in plain words", [acme, plain], "the bash tool hung on a web request", []],
    ["not a bare name that is not compound", [plain], "a webhook to the web", []],
    ["not a compound bare name under 6 characters", [shortName], "a-b1 broke", []],
    ["not a term inside a longer word", [acme], "my-acme-portal-v2 and acme-portal_x", []],
    ["not an owner under 4 characters", [shortOwner], "abc did it", []],
    ["not ian-pascoe, cloudpid's own owner", [mine], "ian-pascoe's account", []],
    [
      "but ian-pascoe's other repos by owner/name",
      [mine],
      "ian-pascoe/private-notes",
      ["ian-pascoe/private-notes", "private-notes"],
    ],
    [
      "nothing of a Repo of ian-pascoe/cloudpid, whatever its directory",
      [own, ownElsewhere],
      "ian-pascoe/cloudpid in /workspace/cloudpid and /workspace/cp-fork",
      [],
    ],
    [
      "a name below cloudpid's own paths, though not the paths themselves",
      [acme],
      "read /workspace/.agents/skills/acme-portal/SKILL.md",
      ["acme-portal"],
    ],
    [
      "a name in a file under /workspace/.cloudpid",
      [acme],
      "see /workspace/.cloudpid/tmp/acme-portal.log",
      ["acme-portal"],
    ],
    [
      "not cloudpid's own paths, for a Repo whose directory starts like them",
      [{ name: ".agents", url: "https://github.com/spiritledsoftware/agents-kit.git" }],
      "wrote /workspace/.agents/skills/x/SKILL.md",
      [],
    ],
  ])("matches %s", (_, repos, text, terms) => {
    expect(namedRepoTerms(repos, [text])).toEqual(terms);
  });

  it("checks every text it is given", () => {
    expect(namedRepoTerms([acme, plain], ["acme-portal hung", "in /workspace/web"])).toEqual([
      "acme-portal",
      "/workspace/web",
    ]);
  });
});

describe("defuseMentions", () => {
  it.each<[string, string, string]>([
    ["a mention in prose", "@someone said", "@\u200bsomeone said"],
    ["each mention", "@a and @b", "@\u200ba and @\u200bb"],
    ["not one in a code span", "`@decorator` and @x", "`@decorator` and @\u200bx"],
    ["not one in a fenced block", "```\n@Input()\n```\n@y", "```\n@Input()\n```\n@\u200by"],
    ["not one in an unclosed fence", "```\n@Input()", "```\n@Input()"],
  ])("defuses %s", (_, text, defused) => {
    expect(defuseMentions(text)).toBe(defused);
  });
});

describe("cloudpidReportFooter", () => {
  const input: AgentCloudpidReportInput = {
    session: "s1",
    conversation: 1,
    task: 7,
    title: "bash ignores its timeout",
    body: "x".repeat(60),
    kind: "bug",
    tool: "bash",
    footer: {
      stage: "pr-731",
      version: "v-1234",
      model: "anthropic/claude-opus-4-5",
      thinking: "high",
      agent: "agent-1",
    },
  };

  it("names the kind, the tool, the stage, the version, the model, the conversation and the Session's page", () => {
    const footer = cloudpidReportFooter(input, "https://cloudpid.example.com");

    for (const part of [
      "bug",
      "`bash`",
      "pr-731",
      "v-1234",
      "anthropic/claude-opus-4-5",
      "high",
      "agent-1",
      "https://cloudpid.example.com/sessions/s1",
    ]) {
      expect(footer).toContain(part);
    }
  });

  it("names an unknown version, no tool, and the bare Session with no origin", () => {
    const footer = cloudpidReportFooter(
      { ...input, tool: undefined, footer: { ...input.footer, version: undefined } },
      undefined,
    );

    expect(footer).toContain("unknown");
    expect(footer).not.toContain("`bash`");
    expect(footer).toMatch(/\bs1$/m);
    expect(footer).not.toContain("/sessions/");
  });

  it("names nothing of the title or body", () => {
    const footer = cloudpidReportFooter(input, undefined);

    expect(footer).not.toContain(input.title);
    expect(footer).not.toContain(input.body);
  });
});
