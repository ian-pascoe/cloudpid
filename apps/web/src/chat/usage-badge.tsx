// What the Session has spent, in the header: its cost, and against its limit when the settings set one.

import * as Arr from "effect/Array";
import { useAtomValue } from "@effect/atom-react";
import { Coins } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { dollars, spendLevel, tokenCount } from "../format.ts";
import { usageAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";

/** The Session's cost so far, with its tokens on hover, turning to a warning near the spend limit and to an error at it. */
export const UsageBadge = () => {
  const usage = useAtomValue(usageAtom(useShownSessionId()));

  if (usage === null) return null;

  const level = spendLevel(usage.cost, usage.limit);

  const detail = Arr.join(
    [
      `${tokenCount(usage.totalTokens)} tokens`,
      `${tokenCount(usage.input)} in, ${tokenCount(usage.output)} out`,
      `${tokenCount(usage.cacheRead)} cached`,
      usage.limit === null ? "no spend limit" : `limit ${dollars(usage.limit)}`,
    ],
    " · ",
  );

  return (
    <span
      title={detail}
      data-level={level}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs tabular-nums",
        level === "near" && "border-amber-500 text-amber-700 dark:text-amber-400",
        level === "over" && "border-destructive text-destructive",
      )}
    >
      <Coins className="size-3.5" aria-hidden />
      <span className="sr-only">Spent</span>
      {dollars(usage.cost)}
      {usage.limit !== null && (
        <span className="text-muted-foreground"> / {dollars(usage.limit)}</span>
      )}
      {level === "over" && <span className="font-medium">Limit reached</span>}
    </span>
  );
};
