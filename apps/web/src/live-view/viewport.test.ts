import { describe, expect, it } from "vitest";
import { deviceMetrics, fromPage, pinch, screencastSize, toPage } from "./viewport.ts";

describe("the tab's viewport", () => {
  it("is the Pane's size and pixel ratio, mobile with touch on a touch screen", () => {
    expect(deviceMetrics({ width: 390, height: 700, dpr: 3, touch: true }, false)).toEqual({
      metrics: { width: 390, height: 700, deviceScaleFactor: 3, mobile: true },
      touch: true,
    });
    expect(deviceMetrics({ width: 600.4, height: 800.6, dpr: 2, touch: false }, false)).toEqual({
      metrics: { width: 600, height: 801, deviceScaleFactor: 2, mobile: false },
      touch: false,
    });
  });

  it("caps the pixel ratio at 3", () => {
    expect(
      deviceMetrics({ width: 390, height: 700, dpr: 4, touch: true }, false).metrics
        .deviceScaleFactor,
    ).toBe(3);
  });

  it("is a 1280-wide desktop in the Desktop layout, as tall as the Pane's proportions allow", () => {
    expect(deviceMetrics({ width: 400, height: 500, dpr: 3, touch: true }, true)).toEqual({
      metrics: { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false },
      touch: false,
    });
    expect(
      deviceMetrics({ width: 800, height: 300, dpr: 1, touch: true }, true).metrics.height,
    ).toBe(720);
  });

  it("asks for frames as sharp as the screen, within limits", () => {
    expect(screencastSize({ width: 390, height: 700 }, 3)).toEqual({
      maxWidth: 780,
      maxHeight: 1400,
    });
    expect(screencastSize({ width: 1280, height: 1600 }, 2)).toEqual({
      maxWidth: 2048,
      maxHeight: 2560,
    });
  });
});

describe("points between the screen and the tab", () => {
  const frame = { left: 10, top: 50, width: 200 };
  const meta = { deviceWidth: 400, offsetTop: 0 };

  it("scales by how large the frame is drawn", () => {
    expect(toPage({ x: 110, y: 150 }, frame, meta)).toEqual({ x: 200, y: 200 });
    expect(fromPage({ x: 200, y: 200 }, frame, meta)).toEqual({ x: 110, y: 150 });
  });

  it("takes the frame's top offset off", () => {
    expect(toPage({ x: 10, y: 60 }, frame, { deviceWidth: 400, offsetTop: 5 })).toEqual({
      x: 0,
      y: 15,
    });
  });
});

describe("a local pinch in the Desktop layout", () => {
  it("zooms by how far the fingers spread, keeping the point between them still", () => {
    const start = {
      a: { x: 100, y: 100 },
      b: { x: 200, y: 100 },
      zoom: 1,
      scroll: { x: 0, y: 0 },
    };

    expect(pinch(start, { x: 50, y: 100 }, { x: 250, y: 100 }, { min: 0.5, max: 4 })).toEqual({
      zoom: 2,
      scroll: { x: 150, y: 100 },
    });
  });

  it("pans with two fingers moving together, and keeps the zoom in its limits", () => {
    const start = {
      a: { x: 100, y: 100 },
      b: { x: 200, y: 100 },
      zoom: 1,
      scroll: { x: 100, y: 100 },
    };

    expect(pinch(start, { x: 80, y: 60 }, { x: 180, y: 60 }, { min: 0.5, max: 4 })).toEqual({
      zoom: 1,
      scroll: { x: 120, y: 140 },
    });
    expect(pinch(start, { x: 0, y: 100 }, { x: 1000, y: 100 }, { min: 0.5, max: 4 }).zoom).toBe(4);
  });
});
