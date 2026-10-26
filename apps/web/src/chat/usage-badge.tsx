// @effect-diagnostics globalDate:off globalTimers:off -- a growing cost is read against the wall clock, ticked by a React effect.
// How full the active branch's Context Window is, in the composer's toolbar: a ring filled to the share of the window
// used. Hovering, focusing or tapping it shows what the context is made of, and what the Session has spent: the models'
// cost and its Workspace's Containers', against its limit when the settings set one. Near and at the limit the ring says
// so too.

import { useAtomValue } from "@effect/atom-react";
import type { ContextUsage, SessionUsage } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { hidePopover, placePopover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { byteSize, dollars, duration, spendLevel, tokenCount } from "../format.ts";
import { usageAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import {
  contextLevel,
  contextPercent,
  type LiveContainerUsage,
  liveContainerUsage,
} from "./usage.ts";

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

/** Whether `target` is a node inside one of `elements`. */
const within = (target: EventTarget | null, ...elements: ReadonlyArray<HTMLElement | null>) =>
  target instanceof Node && Arr.some(elements, (element) => element?.contains(target) === true);

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

/** The kinds of message a context is made of, in the order the bar draws them, each a step lighter in the same ink. */
const CONTEXT_PARTS = [
  { key: "system", label: "System prompt & tools", swatch: "bg-foreground" },
  { key: "user", label: "Your messages", swatch: "bg-foreground/65" },
  { key: "assistant", label: "Answers", swatch: "bg-foreground/40" },
  { key: "tools", label: "Tool results", swatch: "bg-foreground/20" },
] as const;

/** A share of the context window, as a CSS width. */
const share = (tokens: number, context: ContextUsage): string =>
  `${Math.min(100, Math.max(0, (tokens / context.contextWindow) * 100))}%`;

const Swatch = ({ className }: { className: string }) => (
  <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-[2px]", className)} />
);

/** What the context is made of: a bar of the window, each kind of message in it, the room left, and where it compacts. */
const ContextSection = ({ context }: { context: ContextUsage | undefined }) => {
  if (context === undefined) {
    return (
      <Section title="Context">
        <p className="text-muted-foreground">Not known for this session's model yet.</p>
      </Section>
    );
  }

  const free = Math.max(0, context.contextWindow - context.tokens);

  return (
    <Section title={`Context · ${contextPercent(context)}% used`}>
      <div className="relative my-1.5" aria-hidden>
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          {Arr.map(CONTEXT_PARTS, ({ key, swatch }) => (
            <span
              key={key}
              className={swatch}
              style={{ width: share(context.parts[key], context) }}
            />
          ))}
        </div>
        {context.compactAt !== null && (
          <span
            className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground"
            style={{ left: share(context.compactAt, context) }}
          />
        )}
      </div>
      {Arr.map(CONTEXT_PARTS, ({ key, label, swatch }) => (
        <Row
          key={key}
          label={
            <>
              <Swatch className={swatch} />
              {label}
            </>
          }
        >
          {tokenCount(context.parts[key])}
        </Row>
      ))}
      <Row
        label={
          <>
            <Swatch className="bg-muted ring-1 ring-border ring-inset" />
            Free
          </>
        }
      >
        {tokenCount(free)}
      </Row>
      <p className="mt-1 text-muted-foreground">
        {tokenCount(context.tokens)} of {tokenCount(context.contextWindow)} tokens.{" "}
        {context.compactAt === null
          ? "Automatic compaction is off."
          : `Compacts automatically at ${tokenCount(context.compactAt)} (the mark on the bar).`}{" "}
        The split is estimated.
      </p>
    </Section>
  );
};

/**
 * What the context is made of, then what the Session's spend is: the models' tokens and cost, and the Containers' time
 * and cost.
 */
const Breakdown = ({
  usage,
  container,
}: {
  usage: SessionUsage;
  container: LiveContainerUsage | undefined;
}) => (
  <div className="flex flex-col gap-3">
    <ContextSection context={usage.context} />
    <Section title={`Spend · ${dollars(usage.cost + (container?.total ?? 0))}`}>
      <Row label="Spend limit">
        {usage.limit === null ? "none" : `${dollars(usage.cost)} of ${dollars(usage.limit)}`}
      </Row>
    </Section>
    <Section title={`Models · ${dollars(usage.cost)}`}>
      <Row label="Input">{tokenCount(usage.input)} tokens</Row>
      <Row label="Output">{tokenCount(usage.output)} tokens</Row>
      <Row label="Cache read">{tokenCount(usage.cacheRead)} tokens</Row>
      <Row label="Cache write">{tokenCount(usage.cacheWrite)} tokens</Row>
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

/** The ring's radius and stroke, in the 20-unit box it is drawn in. */
const RING_RADIUS = 7.5;
const RING_STROKE = 2.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A ring filled clockwise from the top to `percent` of its perimeter. */
const ContextRing = ({ percent }: { percent: number }) => (
  <svg viewBox="0 0 20 20" className="size-[1.125rem] -rotate-90" aria-hidden>
    <circle
      cx="10"
      cy="10"
      r={RING_RADIUS}
      fill="none"
      strokeWidth={RING_STROKE}
      className="stroke-border"
    />
    <circle
      cx="10"
      cy="10"
      r={RING_RADIUS}
      fill="none"
      strokeWidth={RING_STROKE}
      strokeLinecap={percent > 0 ? "round" : "butt"}
      strokeDasharray={`${(RING_LENGTH * percent) / 100} ${RING_LENGTH}`}
      className="stroke-current transition-[stroke-dasharray] duration-500"
    />
  </svg>
);

/**
 * How full the active branch's Context Window is, as a ring, turning to a warning near the spend limit and to an error
 * at it (the limit holds the models' cost only). The breakdown of the context and the spend opens on hover, focus and a
 * tap, and closes when the pointer or the focus leaves, on Escape, on a second tap of the badge, and on a tap or a scroll
 * outside it. Touch needs its own handling: iOS Safari does not focus a tapped button, so no blur ever closes it there.
 */
export const UsageBadge = () => {
  const usage = useAtomValue(usageAtom(useShownSessionId()));

  const growing =
    usage?.container !== undefined && liveContainerUsage(usage.container, Date.now()).growing;

  const now = useNow(growing);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Whether the breakdown was open when a touch or a pen went down on the badge, so its tap toggles it; `null` for a
  // mouse or a keyboard, whose click only opens it (hover and focus already did, so a toggle would close it at once).
  const openAtTap = useRef<boolean | null>(null);

  // While open: a tap outside closes it, as does a scroll (a swipe or a wheel) anywhere but the breakdown, which scrolls
  // itself when long. A scroll that is not the user's (the page settling as a keyboard hides) only moves it along.
  useEffect(() => {
    if (!open) return;

    const close = () => hidePopover(panel.current);

    const onPointerDown = (event: PointerEvent) => {
      if (!within(event.target, trigger.current, panel.current)) close();
    };

    const onScrollGesture = (event: Event) => {
      if (!within(event.target, panel.current)) close();
    };

    const follow = () => {
      if (trigger.current !== null && panel.current !== null) {
        placePopover(panel.current, trigger.current, "end");
      }
    };

    const passive = { capture: true, passive: true } as const;

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("touchmove", onScrollGesture, passive);
    document.addEventListener("wheel", onScrollGesture, passive);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("touchmove", onScrollGesture, passive);
      document.removeEventListener("wheel", onScrollGesture, passive);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  if (usage === null) return null;

  const container =
    usage.container === undefined ? undefined : liveContainerUsage(usage.container, now);

  const total = usage.cost + (container?.total ?? 0);
  const level = spendLevel(usage.cost, usage.limit);
  const percent = usage.context === undefined ? 0 : contextPercent(usage.context);
  const compacting = usage.context !== undefined && contextLevel(usage.context) !== "ok";

  const name = Arr.join(
    [
      usage.context === undefined ? "Context usage" : `Context ${percent}% used`,
      `spent ${dollars(total)}`,
      ...(level === "over" ? ["spend limit reached"] : []),
    ],
    ", ",
  );

  /**
   * Open the breakdown against the badge, its right edge on the badge's: above it in the composer, where there is no
   * room below. A popover in the top layer, so never clipped.
   */
  const show = () => {
    const button = trigger.current;
    const breakdown = panel.current;

    if (button === null || breakdown === null || breakdown.matches(":popover-open")) return;

    breakdown.showPopover();
    placePopover(breakdown, button, "end");
  };

  const hide = () => hidePopover(panel.current);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-describedby={id}
        data-level={level}
        // A mouse's hover only: a touch sends a mouse's enter and leave around its tap, and the leave would close it.
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") show();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") hide();
        }}
        onFocus={show}
        onBlur={hide}
        onPointerDown={(event) => {
          openAtTap.current =
            event.pointerType === "mouse" ? null : panel.current?.matches(":popover-open") === true;
        }}
        // A swipe that starts on the badge is a scroll, not a tap: no click follows.
        onPointerCancel={() => {
          openAtTap.current = null;
        }}
        onClick={() => {
          const wasOpen = openAtTap.current;

          openAtTap.current = null;

          if (wasOpen === true) hide();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") hide();
        }}
        aria-label={name}
        className={cn(
          "touch-target inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors hover:bg-accent",
          compacting ? "text-foreground" : "text-muted-foreground",
          level === "near" && "border border-amber-500 text-amber-700 dark:text-amber-400",
          level === "over" && "border border-destructive px-2 text-destructive",
        )}
      >
        <ContextRing percent={percent} />
        {level === "over" && <span aria-hidden>Limit reached</span>}
      </button>
      <div
        ref={panel}
        id={id}
        popover="manual"
        role="tooltip"
        onToggle={(event) => setOpen(event.newState === "open")}
        // A tap inside leaves the focus on the badge, so its blur does not close the breakdown being read.
        onMouseDown={(event) => event.preventDefault()}
        className="fixed m-0 max-h-[min(70vh,36rem)] w-80 max-w-[calc(100vw-8px)] overflow-y-auto overscroll-y-contain rounded-lg border bg-background p-3 text-xs text-foreground shadow-sm"
      >
        <Breakdown usage={usage} container={container} />
      </div>
    </>
  );
};
