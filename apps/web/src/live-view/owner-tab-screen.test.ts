// @effect-diagnostics asyncFunction:off -- reads a File, which is Promise-based.
import { describe, expect, it } from "vitest";
import type { Frame } from "./connection.ts";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { keepScreen, latestScreenAtom, screenFile } from "./owner-tab-screen.ts";

const frame = (data: string): Frame => ({
  targetId: "tab",
  data,
  metadata: {
    deviceWidth: 1,
    deviceHeight: 1,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
});

describe("the Browser Pane's latest screen", () => {
  it("is the newest frame of the Pane open on the Session, and gone with the Pane", () => {
    const registry = AtomRegistry.make();
    let listener: ((frame: Frame) => void) | undefined;
    let stopped = false;

    const stop = keepScreen(
      (hear) => {
        listener = hear;

        return () => {
          stopped = true;
        };
      },
      (kept) => {
        registry.set(latestScreenAtom("s1"), kept);
      },
    );

    expect(registry.get(latestScreenAtom("s1"))).toBeUndefined();

    listener?.(frame("AAAA"));
    listener?.(frame("BBBB"));

    expect(registry.get(latestScreenAtom("s1"))?.data).toBe("BBBB");
    expect(registry.get(latestScreenAtom("s2"))).toBeUndefined();

    stop();

    expect(stopped).toBe(true);
    expect(registry.get(latestScreenAtom("s1"))).toBeUndefined();
  });

  it("becomes a JPEG file of the frame's bytes", async () => {
    const file = screenFile(frame(btoa("jpeg bytes")));

    expect(file.type).toBe("image/jpeg");
    expect(file.name).toBe("screen.jpg");
    expect(await file.text()).toBe("jpeg bytes");
  });
});
