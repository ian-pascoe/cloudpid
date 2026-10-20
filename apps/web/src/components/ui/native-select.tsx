import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/** A styled native `<select>`: the platform's own picker, which is the right one on a phone. */
export const NativeSelect = ({ className, ...props }: ComponentProps<"select">) => (
  <select
    className={cn(
      "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
);
