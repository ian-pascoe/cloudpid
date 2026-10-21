// Files dragged over a thread attach to its composer: while a drag that carries files is over `zone`, `active` is true
// (the composer shows it), and a drop hands the files over. A zone inside another (a subagent's thread in the Session's)
// keeps its drags to itself. While it is enabled, a file dropped anywhere else on the page is refused rather than opened
// by the browser in place of the app.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- browser code in a React app with no Effect runtime.

import { type RefObject, useEffect, useRef, useState } from "react";

const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") === true;

/** Keep the browser from opening a file dropped outside every zone. */
const refuse = (event: DragEvent) => {
  if (!carriesFiles(event)) return;

  event.preventDefault();

  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
};

/** Whether files are being dragged over `zone`; `onFiles` gets the ones dropped on it. */
export const useFileDrop = (
  zone: RefObject<HTMLElement | null> | undefined,
  onFiles: (files: File[]) => void,
  enabled: boolean,
): boolean => {
  const [active, setActive] = useState(false);
  const latest = useRef(onFiles);

  latest.current = onFiles;

  useEffect(() => {
    const element = zone?.current;

    if (!enabled || element === null || element === undefined) return;

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
      latest.current(Array.from(event.dataTransfer?.files ?? []));
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
  }, [zone, enabled]);

  return active;
};
