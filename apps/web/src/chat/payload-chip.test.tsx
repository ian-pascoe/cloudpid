// The chip of a webhook payload in the transcript, rendered with `react-dom/server`.

import type { TriggerPayloadChip } from "@cloudpid/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayloadChip, payloadNote } from "./payload-chip.tsx";

const CHIP: TriggerPayloadChip = {
  format: "github",
  event: "workflow_run",
  action: "completed",
  delivery: "d-1",
  size: 40_000,
  shown: 16_384,
  path: "/workspace/.cloudpid/triggers/t1-d-1-ab12cd34.json",
};

describe("a webhook payload's chip", () => {
  it("names where it came from, how big it was, and the file that holds all of it", () => {
    const markup = renderToStaticMarkup(<PayloadChip chip={CHIP} />);

    expect(markup).toContain('aria-label="Webhook payload"');
    expect(markup).toContain("GitHub · workflow_run.completed");
    expect(markup).toContain('title="Delivery d-1"');
    expect(markup).toContain("40000 bytes · first 16384 bytes shown, all of it in a file");
    expect(markup).toContain("/workspace/.cloudpid/triggers/t1-d-1-ab12cd34.json");
  });

  it("says when the whole body was shown, or was too large to keep", () => {
    expect(payloadNote({ ...CHIP, size: 300, shown: 300 })).toBe(
      "300 bytes · all of it shown, and in a file",
    );

    const { path: _path, ...unkept } = CHIP;

    expect(payloadNote({ ...unkept, size: 2_000_000, shown: 0 })).toBe(
      "2000000 bytes · body not kept: too large",
    );
    expect(
      renderToStaticMarkup(
        <PayloadChip chip={{ ...unkept, format: "standard", size: 2_000_000, shown: 0 }} />,
      ),
    ).not.toContain("/workspace");
  });
});
