// docs/architecture/mcp-apps.md → App Panes (Modes). What a View's `ui/request-display-mode` is answered with: `inline` (the
// card) and `fullscreen` (the App Pane) are offered, and `pip` is refused with the mode the View is in. Moving a View to
// the mode it asked for is the place's (`onRequest`): it tears the View down and mounts it there, so the answer is the
// mode the View will be in, which its next `ui/initialize` then says.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- a handler is given a View's own `params`, decoded here before it is read */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- a plain handler over the bridge's promises.
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { AppPlace } from "./places.ts";
import type { RequestHandler } from "./bridge.ts";
import { AVAILABLE_DISPLAY_MODES, type DisplayContext, type DisplayMode } from "./host-context.ts";

/** The display mode a View in `place` is in: only the App Pane is `fullscreen`. */
export const modeOfPlace = (place: AppPlace): DisplayMode =>
  place === "app-pane" ? "fullscreen" : "inline";

/** Whether a View in `place` fills a Pane, both axes fixed: the one test of it, so the places do not each spell it. */
export const isFullscreen = (place: AppPlace): boolean => modeOfPlace(place) === "fullscreen";

/**
 * How a View in `place` is shown, for its host context: the mode, an App Pane's height in px (its width and height are both
 * fixed; a card's height is the View's own), and the insets only an App Pane on a phone has, a sheet. `insets` reads them
 * from the page when they are needed.
 */
export const displayOf = (
  place: AppPlace,
  now: {
    readonly height: number;
    readonly mobile: boolean;
    readonly insets: () => DisplayContext["safeAreaInsets"];
  },
): DisplayContext => ({
  mode: modeOfPlace(place),
  height: isFullscreen(place) ? now.height : undefined,
  safeAreaInsets: isFullscreen(place) && now.mobile ? now.insets() : undefined,
});

const decodeRequest = Schema.decodeUnknownOption(Schema.Struct({ mode: Schema.String }));

/** The mode a View asked for, when it is one cloudpid offers. */
export const offeredMode = (params: unknown): DisplayMode | undefined => {
  const asked = decodeRequest(params);

  if (Option.isNone(asked)) return undefined;

  return Option.getOrUndefined(
    Arr.findFirst(AVAILABLE_DISPLAY_MODES, (mode) => mode === asked.value.mode),
  );
};

/** The handler of `ui/request-display-mode` for a View in `place`; `onRequest` moves it to the mode it is given. */
export const displayModeHandler =
  (place: AppPlace, onRequest: (mode: DisplayMode) => void): RequestHandler =>
  (params) => {
    const current = modeOfPlace(place);
    const asked = offeredMode(params);

    if (asked === undefined || asked === current) return Promise.resolve({ mode: current });

    onRequest(asked);

    return Promise.resolve({ mode: asked });
  };
