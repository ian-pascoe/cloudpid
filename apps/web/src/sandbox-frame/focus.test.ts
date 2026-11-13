// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live). Which View holds the keyboard focus:
// the one whose frame is the document's active element, which moving focus from one frame to another does not announce.
// @effect-diagnostics globalTimers:off -- a poll on native timers, driven by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FocusWatch, POLL_MS } from "./focus.ts";

let one: HTMLIFrameElement;
let two: HTMLIFrameElement;

const frame = () => {
  const element = document.createElement("iframe");

  element.setAttribute("tabindex", "0");
  document.body.append(element);

  return element;
};

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom reports each frame page it was told not to load.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  one = frame();
  two = frame();
});

afterEach(() => {
  one.remove();
  two.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the View that holds the focus", () => {
  it("is the one whose frame is the active element, told when the window blurs into it", () => {
    const watch = new FocusWatch(document, window);
    const seen: Array<Element | null> = [];

    watch.subscribe((active) => seen.push(active));
    one.focus();
    window.dispatchEvent(new Event("blur"));

    expect(seen.at(-1)).toBe(one);
  });

  it("moves from one frame to another, which fires no window event, within a poll", () => {
    const watch = new FocusWatch(document, window);
    const first = vi.fn();
    const second = vi.fn();

    watch.subscribe((active) => {
      first(active === one);
    });
    watch.subscribe((active) => {
      second(active === two);
    });

    one.focus();
    window.dispatchEvent(new Event("blur"));
    expect(first).toHaveBeenLastCalledWith(true);
    expect(second).toHaveBeenLastCalledWith(false);

    // Focus goes from the one frame to the other with nothing said to the page.
    two.focus();
    vi.advanceTimersByTime(POLL_MS);

    expect(first).toHaveBeenLastCalledWith(false);
    expect(second).toHaveBeenLastCalledWith(true);
  });

  it("stops polling once no frame holds the focus, and starts again on the next blur", () => {
    const watch = new FocusWatch(document, window);
    const seen = vi.fn();

    watch.subscribe(seen);
    one.focus();
    window.dispatchEvent(new Event("blur"));
    one.blur();
    vi.advanceTimersByTime(POLL_MS);

    const calls = seen.mock.calls.length;

    vi.advanceTimersByTime(POLL_MS * 10);
    expect(seen.mock.calls.length).toBe(calls);
  });

  it("listens for nothing while no View is subscribed", () => {
    const watch = new FocusWatch(document, window);
    const seen = vi.fn();

    watch.subscribe(seen)();
    one.focus();
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(POLL_MS * 4);

    expect(seen).not.toHaveBeenCalled();
  });
});
