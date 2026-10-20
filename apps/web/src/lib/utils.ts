import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names, with later Tailwind utilities winning over earlier ones (shadcn's `cn`). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
