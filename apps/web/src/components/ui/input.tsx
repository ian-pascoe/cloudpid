import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/** A styled text input. */
export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input
    className={cn(
      "h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
);
