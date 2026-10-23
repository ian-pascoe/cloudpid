// @effect-diagnostics missingPipeableSignature:off -- a plain function of sizes.

// The Live View's frame (#154): the screencast's JPEGs drawn on the canvas, one decode at a time with the newest kept,
// fitted inside the Pane in both dimensions (another device's viewport may win, and its frames be taller or wider than
// this Pane), times the Desktop layout's local zoom; and points and rects between the screen and the tab.

import type { Point } from "./cdp.ts";
import type { Frame, FrameMetadata } from "./connection.ts";
import { fromPage, toPage, type FrameMeta } from "./viewport.ts";

/** A width and a height, in CSS px. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rect in the tab's viewport. */
interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The size a frame of `frame`'s proportions is drawn at to fit inside `pane`: the whole frame shows, whichever of the
 * Pane's sides it meets first.
 */
export const containedSize = (frame: Size, pane: Size): Size => {
  const scale = Math.min(
    pane.width / Math.max(1, frame.width),
    pane.height / Math.max(1, frame.height),
  );

  return { width: frame.width * scale, height: frame.height * scale };
};

export class FrameView {
  private readonly image = new Image();
  private meta: FrameMetadata | undefined;
  private pending: Frame | undefined;
  private drawing = false;
  private disposed = false;
  /** The Desktop layout's local zoom, over the frame fitted to the Pane. */
  zoom = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLDivElement,
    /** A frame shows the tab scrolled, resized or zoomed: what was placed over the last one no longer fits. */
    private readonly moved: () => void,
  ) {}

  /** What the last frame said of the tab, if one came. */
  metadata(): FrameMetadata | undefined {
    return this.meta;
  }

  show(frame: Frame): void {
    if (this.drawing) {
      this.pending = frame;

      return;
    }

    this.draw(frame);
  }

  /** Size the canvas to fit the Pane (times the zoom) and draw the last image. */
  paint(): void {
    const { canvas, container } = this;
    const meta = this.meta;

    if (meta === undefined) return;

    const fitted = containedSize(
      { width: meta.deviceWidth, height: meta.deviceHeight },
      { width: container.clientWidth, height: container.clientHeight },
    );

    const width = fitted.width * this.zoom;
    const height = fitted.height * this.zoom;
    const ratio = Math.min(devicePixelRatio, 3);

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);

    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;

    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    canvas.getContext("2d")?.drawImage(this.image, 0, 0, pixelWidth, pixelHeight);
  }

  /** Where a point on the screen is in the tab's viewport. */
  toPage(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();

    return toPage(
      { x: clientX, y: clientY },
      { left: rect.left, top: rect.top, width: rect.width },
      this.frameMeta(),
    );
  }

  /** A rect in the tab's viewport, in the screen wrapper's coordinates (where the overlays are placed). */
  overlayRect(rect: PageRect): PageRect {
    const canvas = this.canvas.getBoundingClientRect();
    const wrapper = this.wrapperRect();
    const frame = { left: canvas.left, top: canvas.top, width: canvas.width };
    const meta = this.frameMeta();
    const topLeft = fromPage({ x: rect.x, y: rect.y }, frame, meta);
    const zoom = canvas.width / Math.max(1, meta.deviceWidth);

    return {
      x: topLeft.x - wrapper.left,
      y: topLeft.y - wrapper.top,
      w: rect.w * zoom,
      h: rect.h * zoom,
    };
  }

  /** The screen wrapper's rect: the overlays' coordinates. */
  wrapperRect(): DOMRect {
    return (this.container.parentElement ?? this.container).getBoundingClientRect();
  }

  canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  dispose(): void {
    this.disposed = true;
    this.image.onload = null;
    this.image.onerror = null;
  }

  private frameMeta(): FrameMeta {
    return {
      deviceWidth: this.meta?.deviceWidth ?? this.canvas.clientWidth,
      offsetTop: this.meta?.offsetTop ?? 0,
    };
  }

  private draw(frame: Frame): void {
    this.drawing = true;

    const previous = this.meta;

    this.meta = frame.metadata;

    if (
      previous === undefined ||
      previous.scrollOffsetX !== frame.metadata.scrollOffsetX ||
      previous.scrollOffsetY !== frame.metadata.scrollOffsetY ||
      previous.deviceWidth !== frame.metadata.deviceWidth ||
      previous.deviceHeight !== frame.metadata.deviceHeight
    ) {
      this.moved();
    }

    const done = () => {
      if (this.disposed) return;

      this.paint();
      this.drawing = false;

      const next = this.pending;

      this.pending = undefined;

      if (next !== undefined) this.draw(next);
    };

    this.image.onload = done;
    this.image.onerror = done;
    this.image.src = `data:image/jpeg;base64,${frame.data}`;
  }
}
