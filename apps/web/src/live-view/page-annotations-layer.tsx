// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off globalTimers:off asyncFunction:off -- the pins over native arrays; hooks, not combinators; the page's answers come as the screen's promises (`ScreenPage`), and the pins are found again on timers a React effect owns.

// Annotations on the page in the Browser Pane (#243; `docs/spec.md` → Browser → Annotate mode), drawn over its screen
// (`LiveScreen`'s `overlay`) and never into the page: the agent's screenshots never show them.
//
// - Pins: the drafts on the page shown (its URL, fragment aside, from whichever Owner tab drew them), each numbered at
//   its element, which the Pane finds again by its selector as the page scrolls, resizes or changes (once a second, and
//   after each scroll), or at its area. A draft whose element the page no longer has is listed as not found on the page.
//   A pin opens on the draft: its crop, text, Edit and Delete.
// - Annotate mode (the toolbar's toggle): the screen takes no input; the pointer's element is outlined (hover, on a
//   desktop: `DOM.getNodeForLocation` over the Pane's own connection), a click (a tap on a phone) picks it, and a drag
//   picks an area. Long press and text selection are off while it is on; the wheel still scrolls the page. Leaving it
//   gives the screen its input back.
// - The editor of a pick or a draft, at the foot of the screen, with what it is on and its crop.

import {
  type AnnotationDraft,
  MAX_ANNOTATION_TEXT,
  type PageAnnotation,
  type PageCrop,
  type PageRect,
} from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Trash2 } from "lucide-react";
import { type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useCall } from "../calls.ts";
import { Button } from "../components/ui/button.tsx";
import { hidePopover, Popover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { messageOf } from "../registry.ts";
import { editedDraft } from "../review/drafts.ts";
import { CropImage, QuotedLines } from "../review/review-chips.tsx";
import { annotationsAtom, deleteAnnotationAtom, saveAnnotationAtom } from "../session/atoms.ts";
import type { Point } from "./cdp.ts";
import { ScreenPageContext } from "./live-screen.tsx";
import {
  areaBetween,
  BoxModel,
  CalledFunction,
  Described,
  DESCRIBE_FUNCTION,
  draftsOnPage,
  isDrag,
  Located,
  locatedBySelector,
  locateScript,
  NodeForLocation,
  type Picked,
  pickedElement,
  pageDraft,
  pinLabel,
  placePins,
  quadRect,
  ResolvedNode,
  selectorsOf,
} from "./page-annotations.ts";
import type { ScreenPage } from "./screen.ts";

/** How often the drafts' elements are found again while the page holds still, and how soon after it scrolls, in ms. */
const LOCATE_EVERY_MS = 1_000;
const LOCATE_AFTER_MOVE_MS = 120;

/** How often, at most, the element under a hovering mouse is asked for, in ms. */
const HOVER_EVERY_MS = 80;

const Ignored = Schema.Unknown;

/** The page's scroll and viewport as the last frame shows them. */
const frameState = (page: ScreenPage): Pick<Picked, "scroll" | "viewport"> => {
  const meta = page.metadata();

  return {
    scroll: { x: meta?.scrollOffsetX ?? 0, y: meta?.scrollOffsetY ?? 0 },
    viewport: { width: meta?.deviceWidth ?? 0, height: meta?.deviceHeight ?? 0 },
  };
};

/** Draw again on each frame (or resize) of the screen, once per animation frame at most. */
const useRepaint = (page: ScreenPage): void => {
  const [, setTick] = useState(0);

  useEffect(() => {
    let frame: number | null = null;

    const stop = page.painted(() => {
      if (frame !== null) return;

      frame = requestAnimationFrame(() => {
        frame = null;
        setTick((tick) => tick + 1);
      });
    });

    return () => {
      stop();

      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [page]);
};

/**
 * Where the elements of `drafts` are on the page at `url` now, by selector: read at once, once a second, and soon after
 * each scroll or resize. Undefined until the page answered for this URL.
 */
const useLocated = (
  page: ScreenPage,
  drafts: readonly PageAnnotation[],
  url: string,
): ReadonlyMap<string, PageRect | null> | undefined => {
  const selectors = useMemo(() => selectorsOf(drafts), [drafts]);
  const key = selectors.join("\n");

  const [located, setLocated] = useState<{
    readonly key: string;
    readonly url: string;
    readonly rects: ReadonlyMap<string, PageRect | null>;
  } | null>(null);

  useEffect(() => {
    const wanted = key === "" ? [] : key.split("\n");
    let reading = false;
    let stopped = false;
    let soon: ReturnType<typeof setTimeout> | null = null;

    const read = () => {
      if (reading || stopped) return;

      if (wanted.length === 0) {
        setLocated({ key, url, rects: new Map() });

        return;
      }

      reading = true;
      void page.evaluate(locateScript(wanted), Located).then((answer) => {
        reading = false;

        if (stopped || answer === undefined) return;

        const rects = locatedBySelector(wanted, answer, url);

        if (rects !== undefined) setLocated({ key, url, rects });
      });
    };

    read();

    const every = setInterval(read, LOCATE_EVERY_MS);

    const stopMoved = page.moved(() => {
      if (soon !== null) clearTimeout(soon);

      soon = setTimeout(read, LOCATE_AFTER_MOVE_MS);
    });

    return () => {
      stopped = true;
      clearInterval(every);
      stopMoved();

      if (soon !== null) clearTimeout(soon);
    };
  }, [page, key, url]);

  return located !== null && located.key === key && located.url === url ? located.rects : undefined;
};

/** A rect of the viewport, placed over the screen. */
const Outline = ({
  page,
  rect,
  className,
  children,
}: {
  page: ScreenPage;
  rect: PageRect;
  className?: string;
  children?: ReactNode;
}) => {
  const placed = page.overlayRect(rect);

  return (
    <div
      className={cn("absolute rounded-sm", className)}
      style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
    >
      {children}
    </div>
  );
};

/** What the editor is open on: a new pick, or a draft. */
type Editing =
  | {
      readonly kind: "new";
      readonly picked: Picked;
      readonly crop: PageCrop | undefined;
      readonly url: string;
      readonly ownerTabId: string;
    }
  | { readonly kind: "draft"; readonly draft: PageAnnotation };

/** What a draft's card shows: what it is on, its crop, the page's text and the owner's. */
const DraftDetails = ({ draft }: { draft: PageAnnotation }) => (
  <>
    <p className="text-xs text-muted-foreground">
      {pinLabel(draft.source)}
      {draft.source.element !== undefined && (
        <span className="ml-1 font-mono break-all">{draft.source.element.selector}</span>
      )}
    </p>
    {draft.crop !== undefined && <CropImage crop={draft.crop} className="max-h-32" />}
    <QuotedLines lines={draft.quote} more={draft.more} />
    <p className="break-words whitespace-pre-wrap">{draft.text}</p>
  </>
);

/** A pin's card: the draft, Edit and Delete. */
const PinCard = ({
  draft,
  onEdit,
  onDelete,
}: {
  draft: PageAnnotation;
  onEdit: () => void;
  onDelete: () => void;
}) => (
  <div className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 p-2 text-sm">
    <DraftDetails draft={draft} />
    <div className="flex gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-2 text-xs text-muted-foreground"
        onClick={(event) => {
          hidePopover(event.currentTarget.closest<HTMLElement>("[popover]"));
          onEdit();
        }}
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-2 text-xs text-muted-foreground"
        onClick={(event) => {
          hidePopover(event.currentTarget.closest<HTMLElement>("[popover]"));
          onDelete();
        }}
      >
        Delete
      </Button>
    </div>
  </div>
);

/** The editor at the foot of the screen: what it is on, its crop, the owner's text, Save and Cancel. */
const Editor = ({
  sessionId,
  editing,
  onClose,
}: {
  sessionId: string;
  editing: Editing;
  onClose: () => void;
}) => {
  const save = useCall(saveAnnotationAtom(sessionId));
  const [text, setText] = useState(editing.kind === "draft" ? editing.draft.text : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const blank = text.trim() === "";

  const on =
    editing.kind === "draft"
      ? pinLabel(editing.draft.source)
      : editing.picked.element === undefined
        ? "An area"
        : `<${editing.picked.element.tag}>`;

  const crop = editing.kind === "draft" ? editing.draft.crop : editing.crop;

  const submit = () => {
    if (blank || saving) return;

    const draft: AnnotationDraft =
      editing.kind === "draft"
        ? editedDraft(editing.draft, text.trim())
        : pageDraft(
            // @effect-diagnostics-next-line cryptoRandomUUID:off -- the browser makes a draft's ID, so its pin shows at once.
            crypto.randomUUID(),
            editing.picked,
            { url: editing.url, ownerTabId: editing.ownerTabId },
            editing.crop,
            text.trim(),
          );

    setSaving(true);
    setError(null);
    void save(draft).then((exit) => {
      if (Exit.isSuccess(exit)) {
        onClose();

        return;
      }

      if (Cause.hasInterruptsOnly(exit.cause)) return;

      setSaving(false);
      setError(messageOf(exit.cause));
    });
  };

  return (
    <div
      role="dialog"
      aria-label={`Annotation on ${on}`}
      className="absolute inset-x-3 bottom-3 z-30 flex max-h-[70%] flex-col gap-2 overflow-auto rounded-lg border bg-background p-3 text-sm shadow-sm"
    >
      <p className="text-xs text-muted-foreground">
        {editing.kind === "draft" ? "Your Annotation on " : "New Annotation on "}
        <span className="font-mono text-foreground">{on}</span>
        {editing.kind === "new" && editing.picked.element === undefined && " of the page"}
      </p>
      {crop !== undefined && <CropImage crop={crop} className="max-h-24" />}
      <textarea
        aria-label={`Annotation on ${on}`}
        aria-describedby={error === null ? undefined : errorId}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the owner just picked what to write about.
        autoFocus
        rows={3}
        maxLength={MAX_ANNOTATION_TEXT}
        value={text}
        placeholder="What should the agent know about this?"
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }

          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        className="block min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:text-sm"
      />
      {error !== null && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={blank || saving} onClick={submit}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </div>
  );
};

/** Read `Runtime.callFunctionOn`'s value by `schema`. */
const valueOf = <A,>(schema: Schema.Decoder<A>, called: typeof CalledFunction.Type | undefined) =>
  called === undefined || called.exceptionDetails !== undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(schema)(called.result.value));

/** The element under `point` of the viewport, and its box: `DOM.getNodeForLocation`, then `DOM.getBoxModel`. */
const elementAt = async (page: ScreenPage, point: Point) => {
  const at = { x: Math.round(point.x), y: Math.round(point.y), ignorePointerEventsNone: true };

  const node =
    (await page.call("DOM.getNodeForLocation", at, NodeForLocation)) ??
    // The page's DOM agent may want enabling first (a new connection, after a reconnect).
    (await page
      .call("DOM.enable", {}, Ignored)
      .then(() => page.call("DOM.getNodeForLocation", at, NodeForLocation)));

  if (node === undefined) return undefined;

  const model = await page.call("DOM.getBoxModel", { backendNodeId: node.backendNodeId }, BoxModel);

  const box = model === undefined ? undefined : quadRect(model.model.border);

  return box === undefined ? undefined : { backendNodeId: node.backendNodeId, box };
};

/** What the element `backendNodeId` is and says, read in the page (`DESCRIBE_FUNCTION`). */
const describe = async (page: ScreenPage, backendNodeId: number) => {
  const resolved = await page.call("DOM.resolveNode", { backendNodeId }, ResolvedNode);
  const objectId = resolved?.object.objectId;

  if (objectId === undefined) return undefined;

  const called = await page.call(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: DESCRIBE_FUNCTION, returnByValue: true },
    CalledFunction,
  );

  void page.call("Runtime.releaseObject", { objectId }, Ignored);

  return valueOf(Described, called);
};

/**
 * Annotate mode's layer over the screen: it takes the pointer (so the page gets none), outlines the element under a
 * hovering mouse, and picks the element clicked or tapped, or the area dragged out.
 */
const AnnotateLayer = ({
  page,
  url,
  ownerTabId,
  onPick,
}: {
  page: ScreenPage;
  url: string;
  ownerTabId: string;
  onPick: (editing: Editing) => void;
}) => {
  const layer = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<PageRect | null>(null);
  const [drag, setDrag] = useState<PageRect | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const press = useRef<{ readonly client: Point; readonly page: Point; dragging: boolean } | null>(
    null,
  );

  const hovered = useRef({ at: 0, asked: 0 });

  // The wheel scrolls the page; a touch makes no callout or selection. Native listeners: React's are passive.
  useEffect(() => {
    const element = layer.current;

    if (element === null) return;

    const wheel = (event: WheelEvent) => {
      page.wheel(event);
    };

    const touch = (event: TouchEvent) => {
      event.preventDefault();
    };

    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchstart", touch, { passive: false });

    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", touch);
    };
  }, [page]);

  // The page scrolled: the outline no longer fits it.
  useEffect(
    () =>
      page.moved(() => {
        setHover(null);
      }),
    [page],
  );

  const hoverAt = (point: Point) => {
    const now = performance.now();

    if (now - hovered.current.at < HOVER_EVERY_MS) return;

    const asked = hovered.current.asked + 1;

    hovered.current = { at: now, asked };
    void elementAt(page, point).then((found) => {
      if (hovered.current.asked === asked) setHover(found?.box ?? null);
    });
  };

  const pickElement = async (point: Point) => {
    const state = frameState(page);
    const found = await elementAt(page, point);

    if (found === undefined) {
      setNote("Nothing there to annotate. Drag out an area instead.");

      return;
    }

    const described = await describe(page, found.backendNodeId);

    const picked =
      described === undefined
        ? { box: found.box, text: [], more: 0, ...state }
        : pickedElement(described, found.box, state);

    onPick({ kind: "new", picked, crop: page.crop(found.box), url, ownerTabId });
  };

  const pickArea = (area: PageRect) => {
    onPick({
      kind: "new",
      picked: { box: area, text: [], more: 0, ...frameState(page) },
      crop: page.crop(area),
      url,
      ownerTabId,
    });
  };

  return (
    <div
      ref={layer}
      role="application"
      aria-label="Annotate mode: click or tap an element, or drag out an area"
      className="absolute inset-0 z-20 cursor-crosshair touch-none select-none [-webkit-touch-callout:none]"
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setNote(null);
        press.current = {
          client: { x: event.clientX, y: event.clientY },
          page: page.toPage(event.clientX, event.clientY),
          dragging: false,
        };
      }}
      onPointerMove={(event) => {
        const pressed = press.current;
        const at = page.toPage(event.clientX, event.clientY);

        if (pressed === null) {
          if (event.pointerType === "mouse") hoverAt(at);

          return;
        }

        if (!pressed.dragging && isDrag(pressed.client, { x: event.clientX, y: event.clientY })) {
          pressed.dragging = true;
          setHover(null);
        }

        if (pressed.dragging) setDrag(areaBetween(pressed.page, at));
      }}
      onPointerUp={(event) => {
        const pressed = press.current;

        press.current = null;
        setDrag(null);

        if (pressed === null) return;

        if (pressed.dragging) {
          const area = areaBetween(pressed.page, page.toPage(event.clientX, event.clientY));

          if (area.width >= 1 && area.height >= 1) pickArea(area);

          return;
        }

        void pickElement(pressed.page);
      }}
      onPointerCancel={() => {
        press.current = null;
        setDrag(null);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && press.current === null) setHover(null);
      }}
    >
      {hover !== null && drag === null && (
        <Outline page={page} rect={hover} className="border-2 border-primary bg-primary/10" />
      )}
      {drag !== null && (
        <Outline
          page={page}
          rect={drag}
          className="border-2 border-dashed border-primary bg-primary/10"
        />
      )}
      {note !== null && (
        <p
          role="status"
          className="absolute top-2 left-1/2 -translate-x-1/2 rounded-md bg-foreground px-2 py-1 text-xs text-background"
        >
          {note}
        </p>
      )}
    </div>
  );
};

/** The drafts not found on the page shown: listed, with Delete, since there is nowhere to pin them. */
const Missing = ({
  missing,
  onDelete,
}: {
  missing: readonly { readonly draft: PageAnnotation; readonly number: number }[];
  onDelete: (id: string) => void;
}) => (
  <details className="pointer-events-auto absolute top-2 left-2 z-10 max-w-[min(24rem,calc(100%-1rem))] rounded-md border bg-background/95 px-2 py-1 text-xs shadow-sm">
    <summary className="cursor-pointer">
      {missing.length === 1
        ? "1 Annotation not found on the page"
        : `${missing.length} Annotations not found on the page`}
    </summary>
    <ul className="mt-1 flex flex-col gap-1">
      {missing.map(({ draft, number }) => (
        <li key={draft.id} className="flex items-start gap-1">
          <span className="font-medium">{number}.</span>
          <span className="min-w-0 flex-1 break-words">
            <span className="font-mono">{pinLabel(draft.source)}</span> {draft.text}
          </span>
          <button
            type="button"
            aria-label={`Delete Annotation ${number}`}
            title="Delete this Annotation"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              onDelete(draft.id);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  </details>
);

/** The pins of the drafts on the page at `url`, Annotate mode while `annotating`, and the editor. */
const Layer = ({
  page,
  sessionId,
  url,
  ownerTabId,
  annotating,
}: {
  page: ScreenPage;
  sessionId: string;
  url: string;
  ownerTabId: string;
  annotating: boolean;
}) => {
  const annotations = useAtomValue(annotationsAtom(sessionId));
  const drafts = useMemo(() => draftsOnPage(annotations, url), [annotations, url]);
  const located = useLocated(page, drafts, url);
  const remove = useCall(deleteAnnotationAtom(sessionId));
  const [editing, setEditing] = useState<Editing | null>(null);

  useRepaint(page);

  // A pick made on another page, or a draft deleted elsewhere, is not edited any longer.
  const open =
    editing === null ||
    (editing.kind === "new" && editing.url !== url) ||
    (editing.kind === "draft" && !drafts.some((draft) => draft.id === editing.draft.id))
      ? null
      : editing;

  const meta = page.metadata();
  const scroll = { x: meta?.scrollOffsetX ?? 0, y: meta?.scrollOffsetY ?? 0 };
  const { pinned, missing } = placePins(drafts, located, scroll);

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
        {pinned.map(({ draft, number, rect }) => (
          <Outline
            key={draft.id}
            page={page}
            rect={rect}
            className="border border-dashed border-primary/70"
          >
            <span className="pointer-events-auto absolute -top-3 -left-3">
              <Popover
                label={`Annotation ${number}`}
                title={draft.text}
                className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
                trigger={
                  <>
                    <span aria-hidden>{number}</span>
                    <span className="sr-only">Annotation {number}</span>
                  </>
                }
              >
                <PinCard
                  draft={draft}
                  onEdit={() => {
                    setEditing({ kind: "draft", draft });
                  }}
                  onDelete={() => {
                    void remove(draft.id);
                  }}
                />
              </Popover>
            </span>
          </Outline>
        ))}
        {missing.length > 0 && (
          <Missing
            missing={missing}
            onDelete={(id) => {
              void remove(id);
            }}
          />
        )}
      </div>
      {annotating && open === null && (
        <AnnotateLayer page={page} url={url} ownerTabId={ownerTabId} onPick={setEditing} />
      )}
      {open !== null && (
        <>
          {open.kind === "new" && (
            <Outline
              page={page}
              rect={open.picked.box}
              className="pointer-events-none z-20 border-2 border-primary bg-primary/10"
            />
          )}
          <Editor
            key={open.kind === "draft" ? open.draft.id : "new"}
            sessionId={sessionId}
            editing={open}
            onClose={() => {
              setEditing(null);
            }}
          />
        </>
      )}
    </>
  );
};

/**
 * The Browser Pane's Annotations over its screen: the pins of the drafts on the page at `url` (the Owner tab
 * `ownerTabId` shows), and Annotate mode while `annotating`. Render it as `LiveScreen`'s `overlay`.
 */
export const PageAnnotationsOverlay = ({
  sessionId,
  url,
  ownerTabId,
  annotating,
}: {
  sessionId: string;
  url: string | undefined;
  ownerTabId: string | undefined;
  annotating: boolean;
}) => {
  const page = useContext(ScreenPageContext);

  if (page === null || url === undefined || ownerTabId === undefined) return null;

  return (
    <Layer
      page={page}
      sessionId={sessionId}
      url={url}
      ownerTabId={ownerTabId}
      annotating={annotating}
    />
  );
};
