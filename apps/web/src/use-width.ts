// The width of an element as it changes: a Call diff picks split or stacked by it, the Diff pane its layout and whether
// its file list is a rail.

import { useLayoutEffect, useRef, useState } from "react";

/** The width of the element `ref` is put on, measured before it is first painted and kept up to date; undefined until then. */
export const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();

  useLayoutEffect(() => {
    const element = ref.current;

    if (element === null) return undefined;

    setWidth(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (entry !== undefined) setWidth(entry.contentRect.width);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, width };
};
