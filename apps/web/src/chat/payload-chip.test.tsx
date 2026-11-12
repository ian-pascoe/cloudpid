// The chip of a webhook payload in the transcript, rendered with `react-dom/server`: the file the whole body is in is
// named only when there is one, and what the note says of the cut follows the chip's `truncated`. The words are copy.

import type { TriggerPayloadChip } from "@cloudpid/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PayloadChip, payloadNote } from "./payload-chip.tsx";

const CHIP: TriggerPayloadChip = {
  format: "github",
  event: "workflow_run",
  action: "completed",
  delivery: "d-1",
  size: 40_000,
  shown: 16_384,
  truncated: true,
  path: "/workspace/.cloudpid/triggers/t1-d-1-ab12cd34.json",
};

describe("a webhook payload's chip", () => {
  it("names the file that holds the whole body, when there is one, and the size", () => {
    const markup = renderToStaticMarkup(<PayloadChip chip={CHIP} />);

    expect(markup).toContain(CHIP.path);
    expect(markup).toContain(String(CHIP.size));

    const { path: _path, ...unkept } = CHIP;

    expect(renderToStaticMarkup(<PayloadChip chip={unkept} />)).not.toContain("/workspace");
  });

  it("says the bytes shown only of a body that was cut", () => {
    const { truncated: _truncated, ...whole } = CHIP;

    expect(payloadNote(CHIP)).toContain(String(CHIP.shown));
    // Redaction can leave less than the size without any cut: only `truncated` says the text was cut.
    expect(payloadNote({ ...whole, shown: 120 })).not.toContain("120");
  });
});
