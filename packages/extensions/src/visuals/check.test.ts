// docs/architecture/visuals.md → Tools (visual_check), The check. What the model is told of a check: the text of the findings, and
// the bounds the host's screenshot is held to being the transcript's.
// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { VISUAL_CHECK_IMAGE_CHARACTERS, type VisualCheckResult } from "../browser/contract.ts";
import { MAX_IMAGE_CHARACTERS } from "../images.ts";
import { describeCheck } from "./check.ts";

const INPUT = { html: "<p>x</p>", width: 736, theme: "light", top: 0 } as const;

const RESULT: VisualCheckResult = {
  coldStart: false,
  contentHeight: 900,
  screenshot: { data: "AAAA", mimeType: "image/jpeg", top: 0, height: 900, quality: 80 },
  clipped: false,
  growth: { grows: false, heights: [900, 900] },
  console: [],
  violations: [],
  failedLoads: [],
  warnings: [],
};

describe("the screenshot's bound", () => {
  it("is the transcript's", () => {
    expect(VISUAL_CHECK_IMAGE_CHARACTERS).toBe(MAX_IMAGE_CHARACTERS);
  });
});

describe("describeCheck", () => {
  it("says a clean page is clean", () => {
    expect(describeCheck(INPUT, RESULT, [])).toBe(
      [
        "Checked at 736 px wide in the light theme. The page is 900 px tall. The screenshot shows 0 to 900 px.",
        "No console messages, CSP violations or failed loads.",
      ].join("\n"),
    );
  });

  it("says where a clipped screenshot ends, so the next check can start there", () => {
    const text = describeCheck(
      INPUT,
      {
        ...RESULT,
        contentHeight: 8_000,
        clipped: true,
        screenshot: { ...RESULT.screenshot!, height: 3_000 },
      },
      [],
    );

    expect(text).toContain(
      "The screenshot shows 0 to 3000 px, not the whole page: check again with top 3000 to see on.",
    );
  });

  it("lists what the page logged, was blocked from and failed to load, with the warnings of the show and of the check", () => {
    const text = describeCheck(
      { ...INPUT, theme: "dark" },
      {
        ...RESULT,
        console: [{ type: "error", text: "boom" }],
        violations: ["script-src-elem blocked https://evil.example/x.js"],
        failedLoads: [
          { url: "https://evil.example/a.png", reason: "csp" },
          { url: "", reason: "net::ERR_FAILED" },
        ],
        warnings: ["The page had not finished loading after 10 s; it was measured as it was."],
      },
      ["A host not on the list: evil.example"],
    );

    expect(text).toContain("in the dark theme");
    expect(text).toContain("Console (1):\n- [error] boom");
    expect(text).toContain(
      "CSP violations (1):\n- script-src-elem blocked https://evil.example/x.js",
    );
    expect(text).toContain(
      "Failed loads (2):\n- https://evil.example/a.png (csp)\n- (unknown) (net::ERR_FAILED)",
    );
    expect(text).not.toContain("No console messages");
    expect(text).toContain("Warning: A host not on the list: evil.example");
    expect(text).toContain("Warning: The page had not finished loading after 10 s");
  });

  it("says a page that grows with its frame is, and what to look for", () => {
    const text = describeCheck(
      INPUT,
      { ...RESULT, growth: { grows: true, heights: [300, 400, 500, 600] } },
      [],
    );

    expect(text).toContain(
      "grows after each time its frame is resized (heights 300, 400, 500, 600)",
    );
  });

  it("says when there is no screenshot", () => {
    const { screenshot: _taken, ...without } = RESULT;

    expect(describeCheck(INPUT, without, [])).toContain(
      "There is no screenshot (see the warnings).",
    );
  });
});
