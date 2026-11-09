// The identifier check of a cloudpid report (`cloudpid-reports.ts`; `docs/architecture/agent-capabilities.md` → cloudpid
// reports, ADR-0051): which of the owner's Repos a title or body names, a row per term kind, exclusion and boundary.
import { describe, expect, it } from "vitest";
import { namedRepoTerms } from "./cloudpid-reports.ts";

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
      "a non-GitHub Repo's host/path, owner and name",
      [gitlab],
      "gitlab.example.com/team/sub/infra-tools would not clone",
      ["gitlab.example.com/team/sub/infra-tools", "team", "infra-tools"],
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
      "not within cloudpid's own paths",
      [acme],
      "read /workspace/.agents/skills/acme-portal/SKILL.md and /workspace/.cloudpid/acme-portal.log",
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
