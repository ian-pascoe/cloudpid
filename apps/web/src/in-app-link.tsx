// A link to a page of the app: a plain click shows the page in place (`navigate`); a click with a modifier, or with
// another button, does what the browser does with a link (a new tab or window).

import type { ComponentProps, MouseEvent } from "react";
import { navigate } from "./router.ts";

/** Whether a click on a link is the browser's to handle: with a modifier, or another button than the main one. */
const browserHandles = (event: MouseEvent<HTMLAnchorElement>): boolean =>
  event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;

/**
 * An `<a>` to `href`, a path of the app. Its own `onClick` runs first, and may `preventDefault` to keep the click from
 * navigating.
 */
export const InAppLink = ({
  href,
  onClick,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { readonly href: string }) => (
  <a
    {...props}
    href={href}
    onClick={(event) => {
      onClick?.(event);

      if (event.defaultPrevented || browserHandles(event)) return;

      event.preventDefault();
      navigate(href);
    }}
  />
);
