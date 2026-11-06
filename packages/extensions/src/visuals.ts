// The `visuals` extension (`docs/architecture/visuals.md` → Tools, Guidance): `visual_show`, which shows the owner a page the
// agent wrote inline in the conversation, kept by the Session's `VisualRecorder` outside History; `visual_check`, which renders
// a page in the Session's browser and says what it measured and saw (`BrowserHost.checkVisual`), showing and keeping nothing;
// and the `visuals` section, two static lines shown whenever either tool is granted, loaded or not, and frozen per Context
// Window. Every conversation has the tools by the usual rules: the root, each subagent whose grant has them, and `codemode`
// scripts, as nested calls.
import { frozenSection, type ToolSpans } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Secrets } from "./secrets/store.ts";
import { BrowserHost } from "./browser/host.ts";
import { BrowserSession } from "./browser/session.ts";
import { VisualCheckTool } from "./visuals/check.ts";
import { VISUAL_CHECK, VISUAL_SHOW, VISUALS_SECTION } from "./visuals/guidance.ts";
import type { VisualRecorder } from "./visuals/recorder.ts";
import { VisualShowTool } from "./visuals/tool.ts";

export const extensionName = "visuals";

export {
  VISUAL_CHECK,
  VISUAL_CHECK_DESCRIPTION,
  VISUAL_SHOW,
  VISUAL_SHOW_DESCRIPTION,
  VISUALS_SECTION,
} from "./visuals/guidance.ts";

export {
  VisualKeepError,
  type VisualKept,
  VisualRecorder,
  type VisualRecorderService,
} from "./visuals/recorder.ts";

/** The tools the `visuals` section is shown for, offered or deferred. */
const VISUAL_TOOLS: ReadonlySet<string> = new Set([VISUAL_SHOW, VISUAL_CHECK]);

const isVisualTool = (tool: { readonly name: string }) => VISUAL_TOOLS.has(tool.name);

/** The `visuals` extension: `visual_show`, `visual_check` and their section. */
export const Visuals: Effect.Effect<
  Extension,
  never,
  Secrets | VisualRecorder | ToolSpans | BrowserHost | BrowserSession
> = Effect.gen(function* () {
  const tool = yield* VisualShowTool;
  const check = yield* VisualCheckTool;

  // Static and frozen: it holds nothing that changes, so a conversation that loads the tool later reads the same text.
  const section = yield* frozenSection("visuals", (input) =>
    Effect.succeed(
      Arr.some(input.agent.tools, isVisualTool) || Arr.some(input.agent.deferred, isVisualTool)
        ? VISUALS_SECTION
        : undefined,
    ),
  );

  return defineExtension({ name: extensionName, tools: [tool, check], sections: [section] });
});
