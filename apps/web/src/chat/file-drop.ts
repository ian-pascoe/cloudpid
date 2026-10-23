// Files dragged over a thread attach to its composer: while a drag that carries files is over the zone,
// `fileDragAtom` is true (the composer shows it), and a drop attaches the files. A zone inside another (a subagent's
// thread in the Session's) keeps its drags to itself. While a zone is listening, a file dropped anywhere else on the
// page is refused rather than opened by the browser in place of the app.

// @effect-diagnostics missingPipeableSignature:off -- a React hook, not a combinator.

import { useAtomSet } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { type RefObject, useEffect } from "react";
import { addAttachmentsAtom } from "./attachments-state.ts";
import type { ConversationKey } from "./conversation.ts";

/** Whether files are being dragged over the thread of the conversation's composer. */
export const fileDragAtom = Atom.family((_key: ConversationKey) => Atom.make(false));

const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") === true;

/** Keep the browser from opening a file dropped outside every zone. */
const refuse = (event: DragEvent) => {
  if (!carriesFiles(event)) return;

  event.preventDefault();

  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
};

/** Listen for files dragged over `zone` while mounted: they attach to the conversation's composer when dropped. */
export const useFileDropZone = (
  zone: RefObject<HTMLElement | null> | undefined,
  key: ConversationKey,
): void => {
  useFileDrop(zone, useAtomSet(addAttachmentsAtom(key)), useAtomSet(fileDragAtom(key)));
};

/**
 * Listen for files dragged over `zone` while mounted: `setActive` hears whether a drag that carries files is over it,
 * and `attach` gets the files dropped.
 */
export const useFileDrop = (
  zone: RefObject<HTMLElement | null> | undefined,
  attach: (files: File[]) => void,
  setActive: (active: boolean) => void,
): void => {
  useEffect(() => {
    const element = zone?.current;

    if (element === null || element === undefined) return;

    // Enter and leave fire for every element inside the zone: the drag is over it while more were entered than left.
    let depth = 0;

    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;

      event.preventDefault();
      event.stopPropagation();
      depth += 1;
      setActive(true);
    };

    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };

    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;

      event.stopPropagation();
      depth = Math.max(0, depth - 1);

      if (depth === 0) setActive(false);
    };

    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;

      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setActive(false);
      attach(Array.from(event.dataTransfer?.files ?? []));
    };

    element.addEventListener("dragenter", enter);
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);

    return () => {
      element.removeEventListener("dragenter", enter);
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
      setActive(false);
    };
  }, [zone, setActive, attach]);
};
