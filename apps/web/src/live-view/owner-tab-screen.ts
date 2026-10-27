// @effect-diagnostics missingPipeableSignature:off -- plain helpers.
// The Browser Pane's latest screen, for the composer to attach with a page (`docs/spec.md` → Attached pages): while a
// Pane is open on a Session, its connection keeps the newest screencast frame in that Session's `latestScreenAtom` (a
// base64 JPEG, as Browser Run sent it, which the composer fits into the message's images); when the Pane goes, so does the
// frame. The composer reads it once, when the owner attaches the shown Owner tab: a Pane that is not open has no screen to
// give, and the composer does not follow it, as frames come many times a second.

import * as Atom from "effect/reactivity/Atom";
import type { Frame } from "./connection.ts";

/** Session `sessionId`'s Browser Pane's latest frame; undefined when no Pane is open on it or none has come. */
export const latestScreenAtom = Atom.family((_sessionId: string) =>
  Atom.make<Frame | undefined>(undefined).pipe(Atom.keepAlive),
);

/**
 * Hand `hear`'s frames (a Live View's `frames`) to `keep` as they come; returns how to stop, which also forgets the
 * frame (`keep(undefined)`).
 */
export const keepScreen = (
  hear: (listener: (frame: Frame) => void) => () => void,
  keep: (frame: Frame | undefined) => void,
): (() => void) => {
  const stop = hear(keep);

  return () => {
    stop();
    keep(undefined);
  };
};

/** The frame as a picture the composer attaches: a JPEG file. */
export const screenFile = (frame: Frame): File => {
  const binary = atob(frame.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new File([bytes], "screen.jpg", { type: "image/jpeg" });
};
