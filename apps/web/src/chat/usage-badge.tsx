// @effect-diagnostics globalDate:off globalTimers:off -- a growing cost is read against the wall clock, ticked by a React effect.
// What the Session has spent, in the header: the models' cost and its Workspace's Containers', and against its limit when
// the settings set one. Hovering, focusing or tapping it shows the breakdown.

import { useAtomValue } from "@effect/atom-react";
import type { SessionUsage } from "@cloudpid/protocol";
import { Coins } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { byteSize, dollars, duration, spendLevel, tokenCount } from "../format.ts";
import { usageAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import { type LiveContainerUsage, liveContainerUsage } from "./usage.ts";

/** The gap between the badge and its breakdown. */
const GAP = 4;

/** How often a growing Container cost is brought up to date. */
const TICK_MS = 1000;

/** The time now, again every `TICK_MS` while `ticking`. */
const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());

    if (!ticking) return;

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);

    return () => clearInterval(timer);
  }, [ticking]);

  return now;
};

/** "10:42": a time of day. */
const timeOfDay = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const Row = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex justify-between gap-4">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="tabular-nums">{children}</dd>
  </div>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-1">
    <h3 className="font-medium">{title}</h3>
    <dl className="flex flex-col gap-0.5">{children}</dl>
  </section>
);

/** What the Session's spend is made of: the models' tokens and cost, and the Containers' time and cost. */
const Breakdown = ({
  usage,
  container,
}: {
  usage: SessionUsage;
  container: LiveContainerUsage | undefined;
}) => (
  <div className="flex flex-col gap-3">
    <Section title={`Models · ${dollars(usage.cost)}`}>
      <Row label="Input">{tokenCount(usage.input)} tokens</Row>
      <Row label="Output">{tokenCount(usage.output)} tokens</Row>
      <Row label="Cache read">{tokenCount(usage.cacheRead)} tokens</Row>
      <Row label="Cache write">{tokenCount(usage.cacheWrite)} tokens</Row>
      <Row label="Spend limit">
        {usage.limit === null ? "none" : `${dollars(usage.cost)} of ${dollars(usage.limit)}`}
      </Row>
    </Section>
    {usage.container !== undefined && container !== undefined && (
      <Section title={`Container · ${dollars(container.total)}`}>
        <Row label="Run time">
          {duration(container.runSeconds * 1000)} on {usage.container.instance}
          {usage.container.running && " (running)"}
        </Row>
        <Row label="CPU time">{duration(container.cpuSeconds * 1000)}</Row>
        <Row label="Memory">{dollars(container.memory)}</Row>
        <Row label="CPU">{dollars(container.cpu)}</Row>
        <Row label="Disk">{dollars(container.disk)}</Row>
        <Row label="Egress">
          {dollars(container.egress)} ({byteSize(usage.container.egressBytes)})
        </Row>
        <p className="mt-1 text-muted-foreground">
          {usage.container.reportedThrough === null
            ? "Estimated from the time the Container ran."
            : `Cloudflare's figures to ${timeOfDay(usage.container.reportedThrough)}, estimated since.`}{" "}
          The Workspace's whole Container, at list prices; not held to the spend limit.
        </p>
      </Section>
    )}
  </div>
);

/**
 * The Session's spend so far, turning to a warning near the spend limit and to an error at it (the limit holds the
 * models' cost only). The breakdown opens on hover, focus and a tap, and closes when the pointer or the focus leaves.
 */
export const UsageBadge = () => {
  const usage = useAtomValue(usageAtom(useShownSessionId()));

  const growing =
    usage?.container !== undefined && liveContainerUsage(usage.container, Date.now()).growing;

  const now = useNow(growing);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  if (usage === null) return null;

  const container =
    usage.container === undefined ? undefined : liveContainerUsage(usage.container, now);

  const total = usage.cost + (container?.total ?? 0);
  const level = spendLevel(usage.cost, usage.limit);

  /** Open the breakdown under the badge, its right edge on the badge's: a popover in the top layer, so never clipped. */
  const show = () => {
    const button = trigger.current;
    const breakdown = panel.current;

    if (button === null || breakdown === null || breakdown.matches(":popover-open")) return;

    const box = button.getBoundingClientRect();

    breakdown.style.top = `${box.bottom + GAP}px`;
    breakdown.style.right = `${Math.max(GAP, window.innerWidth - box.right)}px`;
    breakdown.showPopover();
  };

  const hide = () => {
    if (panel.current?.matches(":popover-open") === true) panel.current.hidePopover();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-describedby={id}
        data-level={level}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // A tap focuses the badge, which opens the breakdown; a tap elsewhere takes the focus and closes it.
        onClick={show}
        onKeyDown={(event) => {
          if (event.key === "Escape") hide();
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs tabular-nums",
          level === "near" && "border-amber-500 text-amber-700 dark:text-amber-400",
          level === "over" && "border-destructive text-destructive",
        )}
      >
        <Coins className="size-3.5" aria-hidden />
        <span className="sr-only">Spent</span>
        {dollars(total)}
        {usage.limit !== null && (
          <span className="text-muted-foreground"> / {dollars(usage.limit)}</span>
        )}
        {level === "over" && <span className="font-medium">Limit reached</span>}
      </button>
      <div
        ref={panel}
        id={id}
        popover="manual"
        role="tooltip"
        className="fixed m-0 w-72 max-w-[calc(100vw-8px)] rounded-lg border bg-background p-3 text-xs text-foreground shadow-sm"
        style={{ left: "auto", bottom: "auto" }}
      >
        <Breakdown usage={usage} container={container} />
      </div>
    </>
  );
};
