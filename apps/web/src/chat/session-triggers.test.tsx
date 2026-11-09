import type { TriggerDefinition } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTriggers } from "./session-triggers.tsx";

const trigger = (id: string, name: string, paused = false): TriggerDefinition => ({
  id,
  revision: 1,
  kind: "session",
  environment: "default",
  session: "s-1",
  name,
  message: "Check the build.",
  source: { type: "schedule", cron: "0 9 * * 1", zone: "America/Chicago" },
  whenBusy: "queue",
  paused,
  createdAt: 1,
  updatedAt: 1,
});

const render = (triggers: ReadonlyArray<TriggerDefinition>, problem: string | null = null) =>
  renderToStaticMarkup(
    <SessionTriggers
      triggers={triggers}
      problem={problem}
      onPause={() => undefined}
      onRemove={() => undefined}
    />,
  );

describe("SessionTriggers", () => {
  it("renders nothing when the Session has no trigger", () => {
    expect(render([])).toBe("");
  });

  it("says why a change failed even when the list it was made from is empty now", () => {
    expect(render([], "The Registry did not answer")).toContain("The Registry did not answer");
  });

  it("lists each trigger with its Schedule, and a button to pause or resume it and a ✕ to remove it", () => {
    const html = render([trigger("t1", "Weekly check"), trigger("t2", "Nightly", true)]);

    expect(html).toContain("Triggers");
    expect(html).toContain("Weekly check");
    expect(html).toContain("0 9 * * 1 · America/Chicago");
    expect(html).toContain('aria-label="Pause Weekly check"');
    expect(html).toContain('aria-label="Resume Nightly"');
    expect(html).toContain("(Paused)");
    expect(html).toContain('aria-label="Remove Nightly"');
    expect(html.match(/<button/g)).toHaveLength(4);
  });

  it("says why a pause, resume or removal failed beneath the list, and nothing when none did", () => {
    expect(render([trigger("t1", "Weekly check")])).not.toContain('role="alert"');
    expect(
      render([trigger("t1", "Weekly check")], "The trigger is saved, but isn't scheduled yet"),
    ).toContain("isn&#x27;t scheduled yet");
  });
});
