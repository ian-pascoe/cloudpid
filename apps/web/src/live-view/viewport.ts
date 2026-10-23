// The tab's viewport while the Live View shows it (#154), and points between the screen and the tab. The tab is sized
// to the Pane (`Emulation.setDeviceMetricsOverride`), mobile with touch emulation on a touch screen, so a site lays out
// for the owner's screen; the last device to resize wins. The Desktop layout gives a phone a 1280-wide desktop instead,
// which the owner pans and zooms locally with two fingers.

import type { Point } from "./cdp.ts";

/** The width of the Desktop layout's viewport. */
export const DESKTOP_WIDTH = 1280;

/** The Desktop layout's height follows the Pane's proportions, within these. */
const DESKTOP_MIN_HEIGHT = 720;
const DESKTOP_MAX_HEIGHT = 1600;

/** The Pane's frame area, as the page measures it. */
export interface PaneSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** Whether the screen is a touch screen (a coarse pointer). */
  readonly touch: boolean;
}

/** `Emulation.setDeviceMetricsOverride`'s parameters, and whether to turn touch emulation on. */
export interface DeviceMetrics {
  readonly metrics: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
    readonly mobile: boolean;
  };
  readonly touch: boolean;
}

/** The viewport the tab gets for the Pane `pane`, or the Desktop layout's. */
export const deviceMetrics = (pane: PaneSize, desktop: boolean): DeviceMetrics => {
  if (desktop) {
    const height = Math.round((DESKTOP_WIDTH * pane.height) / Math.max(1, pane.width));

    return {
      metrics: {
        width: DESKTOP_WIDTH,
        height: Math.min(DESKTOP_MAX_HEIGHT, Math.max(DESKTOP_MIN_HEIGHT, height)),
        deviceScaleFactor: 1,
        mobile: false,
      },
      touch: false,
    };
  }

  return {
    metrics: {
      width: Math.max(1, Math.round(pane.width)),
      height: Math.max(1, Math.round(pane.height)),
      deviceScaleFactor: Math.min(pane.dpr, 3),
      mobile: pane.touch,
    },
    touch: pane.touch,
  };
};

/** The largest frames asked for: twice the CSS size at most, and never past these. */
const MAX_FRAME_WIDTH = 2048;
const MAX_FRAME_HEIGHT = 2560;

/** `Page.startScreencast`'s size limits. */
export interface ScreencastSize {
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** `Page.startScreencast`'s size limits for a viewport of `size`, on a screen of pixel ratio `dpr`. */
export const screencastSize = (
  size: { readonly width: number; readonly height: number },
  dpr: number,
): ScreencastSize => {
  const scale = Math.min(Math.max(dpr, 1), 2);

  return {
    maxWidth: Math.min(MAX_FRAME_WIDTH, Math.round(size.width * scale)),
    maxHeight: Math.min(MAX_FRAME_HEIGHT, Math.round(size.height * scale)),
  };
};

/** Where the frame is drawn on the screen: its left and top edges and its width, in CSS px. */
export interface FrameBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** What a screencast frame's metadata says of the tab: its width and the offset of its top. */
export interface FrameMeta {
  readonly deviceWidth: number;
  readonly offsetTop: number;
}

/** A point on the screen, in the tab's viewport. */
export const toPage = (client: Point, frame: FrameBox, meta: FrameMeta): Point => {
  const zoom = frame.width / Math.max(1, meta.deviceWidth);

  return {
    x: Math.round((client.x - frame.left) / zoom),
    y: Math.round((client.y - frame.top) / zoom - meta.offsetTop),
  };
};

/** A point in the tab's viewport, on the screen. */
export const fromPage = (page: Point, frame: FrameBox, meta: FrameMeta): Point => {
  const zoom = frame.width / Math.max(1, meta.deviceWidth);

  return {
    x: frame.left + page.x * zoom,
    y: frame.top + (page.y + meta.offsetTop) * zoom,
  };
};

/** Where a two-finger gesture started: both fingers (in the frame's container), the zoom, and the scroll. */
export interface PinchStart {
  readonly a: Point;
  readonly b: Point;
  readonly zoom: number;
  readonly scroll: Point;
}

/** The local zoom of the Desktop layout's frame, and how far its container is scrolled. */
export interface LocalZoom {
  readonly zoom: number;
  readonly scroll: Point;
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * The zoom and scroll after the fingers of `start` moved to `a` and `b`: the zoom follows their spread, within
 * `limits`, and the content point that was between them stays between them.
 */
export const pinch = (
  start: PinchStart,
  a: Point,
  b: Point,
  limits: { readonly min: number; readonly max: number },
): LocalZoom => {
  const spread = Math.hypot(a.x - b.x, a.y - b.y);
  const before = Math.max(1, Math.hypot(start.a.x - start.b.x, start.a.y - start.b.y));
  const zoom = Math.min(limits.max, Math.max(limits.min, (start.zoom * spread) / before));
  const from = midpoint(start.a, start.b);
  const to = midpoint(a, b);

  // The content point under the first midpoint, at zoom 1.
  const content = {
    x: (from.x + start.scroll.x) / start.zoom,
    y: (from.y + start.scroll.y) / start.zoom,
  };

  return {
    zoom,
    scroll: { x: content.x * zoom - to.x, y: content.y * zoom - to.y },
  };
};
