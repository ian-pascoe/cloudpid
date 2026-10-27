// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off asyncFunction:off -- the pins over native arrays; hooks, not combinators; the page's answers come as the screen's promises (`ScreenPage`).

// Annotations on the page in the Browser Pane (#243; `docs/spec.md` → Browser → Annotate mode), drawn over its screen
// (`LiveScreen`'s `overlay`) and never into the page: the agent's screenshots never show them.
//
// - Pins: the drafts on the page shown (its URL, fragment aside, from whichever Owner tab drew them), each numbered at
//   its element, which the Pane finds again by its selector as the page scrolls, resizes or changes (`page-pins.ts`), or
//   at its area. A draft whose element the page no longer has is listed as not found on the page. A pin opens on the
//   draft: its crop, text, Edit and Delete.
// - Annotate mode (the toolbar's toggle, `annotateModeAtom`): the screen takes no input; the pointer's element is
//   outlined (hover, on a desktop: `DOM.getNodeForLocation` over the Pane's own connection), a click (a tap on a phone)
//   picks it, and a drag picks an area. Long press and text selection are off while it is on; the wheel still scrolls
//   the page. Leaving it gives the screen its input back.
// - The editor of a pick or a draft, at the foot of the screen, with what it is on and its crop: the diffs' editor
//   (`AnnotationEditor`, `EditorBox`), one per Pane. The screen takes no input while it is open.

import { type PageAnnotation, type PageRect, pageQuote } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useCall } from "../calls.ts";
import { Button } from "../components/ui/button.tsx";
import { hidePopover, Popover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { EditorBox, useSave } from "../review/annotations-ui.tsx";
import { editedDraft, pageTarget } from "../review/drafts.ts";
import {
  AnnotationEditor,
  editingId,
  openOn,
  type PagePick,
  type Picked,
} from "../review/editor.ts";
import { PageDetails } from "../review/review-chips.tsx";
import { annotationsAtom, deleteAnnotationAtom } from "../session/atoms.ts";
import {
  annotateModeAtom,
  type BrowserPaneKey,
  ownerTabPageAtom,
  ownerTabWindowShownAtom,
} from "./browser-pane-atoms.ts";
import type { Point } from "./cdp.ts";
import { ShownScreenPage } from "./live-screen.tsx";
import {
  areaBetween,
  BoxModel,
  CalledFunction,
  Described,
  DESCRIBE_FUNCTION,
  draftsOnPage,
  isDrag,
  NodeForLocation,
  pickedElement,
  pageDraft,
  placePins,
  quadRect,
  ResolvedNode,
  selectorsOf,
} from "./page-annotations.ts";
import { locatedAtom, repaintsAtom } from "./page-pins.ts";
import type { ScreenPage } from "./screen.ts";

/** How often, at most, the element under a hovering mouse is asked for, in ms. */
const HOVER_EVERY_MS = 80;

const Ignored = Schema.Unknown;

/** What Annotate mode's layer shows: the element under a hovering mouse, the area being dragged out, and a note. */
interface PointerState {
  readonly hover: PageRect | null;
  readonly drag: PageRect | null;
  readonly note: string | null;
}

/** Annotate mode's pointer state, for one layer: it starts afresh each time the layer does. */
const AnnotatePointer = ScopedAtom.make(() =>
  Atom.make<PointerState>({ hover: null, drag: null, note: null }),
);

/** The page's scroll and viewport as the last frame shows them. */
const frameState = (page: ScreenPage): Pick<Picked, "scroll" | "viewport"> => {
  const meta = page.metadata();

  return {
    scroll: { x: meta?.scrollOffsetX ?? 0, y: meta?.scrollOffsetY ?? 0 },
    viewport: { width: meta?.deviceWidth ?? 0, height: meta?.deviceHeight ?? 0 },
  };
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

/** A rect of the viewport, placed over the screen again each time it is drawn (the Pane resized, the page zoomed). */
const PlacedOutline = (props: Parameters<typeof Outline>[0]) => {
  useAtomValue(repaintsAtom(props.page));

  return <Outline {...props} />;
};

/** What the editor is open on: a new pick, or a draft. */
type Open =
  | { readonly kind: "new"; readonly pick: PagePick }
  | { readonly kind: "draft"; readonly draft: PageAnnotation };

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
    <PageDetails {...draft} className="max-h-32" />
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

/** What a new pick is on, as a draft's source names it. */
const pickSource = ({ picked, url }: PagePick) =>
  picked.element === undefined ? { url } : { url, element: picked.element };

/** The editor at the foot of the screen: what it is on, its crop and the page's text, the owner's text, Save and Cancel. */
const PageEditor = ({ sessionId, open }: { sessionId: string; open: Open }) => {
  const save = useSave(sessionId);
  const source = open.kind === "draft" ? open.draft.source : pickSource(open.pick);
  const target = pageTarget(source);

  const shown =
    open.kind === "draft"
      ? open.draft
      : { crop: open.pick.crop, ...pageQuote(open.pick.picked.text, open.pick.picked.more) };

  return (
    <div
      role="dialog"
      aria-label={`Annotation on ${target}`}
      className="absolute inset-x-3 bottom-3 z-30 flex max-h-[70%] flex-col gap-2 overflow-auto rounded-lg border bg-background p-3 text-sm shadow-sm"
    >
      <p className="text-xs font-medium">
        {open.kind === "draft" ? "Your Annotation" : "New Annotation"}
      </p>
      <PageDetails
        source={source}
        crop={shown.crop}
        quote={shown.quote}
        more={shown.more}
        className="max-h-24"
      />
      <EditorBox
        label={`${open.kind === "draft" ? "Edit the Annotation" : "Annotation"} on ${target}`}
        placeholder="What should the agent know about this?"
        onSave={(text) => {
          save(
            open.kind === "draft"
              ? editedDraft(open.draft, text)
              : pageDraft(
                  // @effect-diagnostics-next-line cryptoRandomUUID:off -- the browser makes a draft's ID, so its pin shows at once.
                  crypto.randomUUID(),
                  open.pick.picked,
                  open.pick,
                  open.pick.crop,
                  text,
                ),
          );
        }}
      />
    </div>
  );
};

/** Read `Runtime.callFunctionOn`'s value by `schema`. */
const valueOf = <A,>(schema: Schema.Decoder<A>, called: typeof CalledFunction.Type | undefined) =>
  called === undefined || called.exceptionDetails !== undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(schema)(called.result.value));

/**
 * The element under `point` of the viewport, and its box: `DOM.getNodeForLocation`, then `DOM.getBoxModel` (the Live View
 * enables the DOM agent of each connection before its first `DOM.` call: `LiveView.call`).
 */
const elementAt = async (page: ScreenPage, point: Point) => {
  const at = { x: Math.round(point.x), y: Math.round(point.y), ignorePointerEventsNone: true };
  const node = await page.call("DOM.getNodeForLocation", at, NodeForLocation);

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
}: {
  page: ScreenPage;
  url: string;
  ownerTabId: string;
}) => {
  const layer = useRef<HTMLDivElement>(null);
  const [{ hover, drag, note }, setPointer] = useAtom(AnnotatePointer.use());
  const setEditor = useAtomSet(AnnotationEditor.use());

  const press = useRef<{ readonly client: Point; readonly page: Point; dragging: boolean } | null>(
    null,
  );

  const hovered = useRef({ at: 0, asked: 0 });

  const set = (change: Partial<PointerState>) => {
    setPointer((before) => ({ ...before, ...change }));
  };

  // The wheel scrolls the page; a touch makes no callout or selection. Native listeners: React's are passive.
  useEffect(() => {
    const element = layer.current;

    if (element === null) return;

    // The keys go to the page while the screen has the focus: none while annotating.
    const focused = document.activeElement;

    if (focused instanceof HTMLElement && element.parentElement?.contains(focused) === true) {
      focused.blur();
    }

    const wheel = (event: WheelEvent) => {
      page.wheel(event);
    };

    const touch = (event: TouchEvent) => {
      event.preventDefault();
    };

    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchstart", touch, { passive: false });

    // The page scrolled: the outline no longer fits it.
    const stopMoved = page.moved(() => {
      setPointer((before) => ({ ...before, hover: null }));
    });

    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", touch);
      stopMoved();
    };
  }, [page, setPointer]);

  const hoverAt = (point: Point) => {
    const now = performance.now();

    if (now - hovered.current.at < HOVER_EVERY_MS) return;

    const asked = hovered.current.asked + 1;

    hovered.current = { at: now, asked };
    void elementAt(page, point).then((found) => {
      if (hovered.current.asked === asked) set({ hover: found?.box ?? null });
    });
  };

  const pick = (picked: Picked, crop: PagePick["crop"]) => {
    setEditor(openOn({ kind: "page", pick: { picked, crop, url, ownerTabId } }));
  };

  const pickElement = async (point: Point) => {
    const state = frameState(page);
    const found = await elementAt(page, point);

    if (found === undefined) {
      set({ note: "Nothing there to annotate. Drag out an area instead." });

      return;
    }

    const described = await describe(page, found.backendNodeId);

    const picked =
      described === undefined
        ? { box: found.box, text: [], more: 0, ...state }
        : pickedElement(described, found.box, state);

    pick(picked, page.crop(found.box));
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
        set({ note: null });
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
          set({ hover: null });
        }

        if (pressed.dragging) set({ drag: areaBetween(pressed.page, at) });
      }}
      onPointerUp={(event) => {
        const pressed = press.current;

        press.current = null;
        set({ drag: null });

        if (pressed === null) return;

        if (pressed.dragging) {
          const area = areaBetween(pressed.page, page.toPage(event.clientX, event.clientY));

          if (area.width >= 1 && area.height >= 1) {
            pick({ box: area, text: [], more: 0, ...frameState(page) }, page.crop(area));
          }

          return;
        }

        void pickElement(pressed.page);
      }}
      onPointerCancel={() => {
        press.current = null;
        set({ drag: null });
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && press.current === null) set({ hover: null });
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
            <span className="font-mono">{pageTarget(draft.source)}</span> {draft.text}
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

/**
 * The pins of `drafts`, the drafts on the page at `url`: placed again each time the screen is drawn, at their elements
 * as the page last said (found again only while the Pane is `inView`).
 */
const Pins = ({
  page,
  sessionId,
  url,
  drafts,
  inView,
}: {
  page: ScreenPage;
  sessionId: string;
  url: string;
  drafts: readonly PageAnnotation[];
  inView: boolean;
}) => {
  const located = useAtomValue(locatedAtom({ page, selectors: selectorsOf(drafts), url, inView }));
  const remove = useCall(deleteAnnotationAtom(sessionId));
  const setEditor = useAtomSet(AnnotationEditor.use());

  useAtomValue(repaintsAtom(page));

  const meta = page.metadata();
  const scroll = { x: meta?.scrollOffsetX ?? 0, y: meta?.scrollOffsetY ?? 0 };
  const { pinned, missing } = placePins(drafts, located, scroll);

  return (
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
                  setEditor(openOn({ kind: "draft", id: draft.id }, draft.text));
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
  );
};

/** The pins of the drafts on the page at `url`, Annotate mode while `annotating`, and the editor. */
const Layer = ({
  page,
  sessionId,
  url,
  ownerTabId,
  annotating,
  inView,
}: {
  page: ScreenPage;
  sessionId: string;
  url: string;
  ownerTabId: string;
  annotating: boolean;
  inView: boolean;
}) => {
  const annotations = useAtomValue(annotationsAtom(sessionId));
  const drafts = useMemo(() => draftsOnPage(annotations, url), [annotations, url]);
  const editor = useAtomValue(AnnotationEditor.use());

  // A pick made on another page, or a draft deleted elsewhere, is not edited any longer.
  const editing = drafts.find((draft) => draft.id === editingId(editor));

  const open: Open | null =
    editor.on?.kind === "page" && editor.on.pick.url === url
      ? { kind: "new", pick: editor.on.pick }
      : editing === undefined
        ? null
        : { kind: "draft", draft: editing };

  return (
    <>
      {drafts.length > 0 && (
        <Pins page={page} sessionId={sessionId} url={url} drafts={drafts} inView={inView} />
      )}
      {annotating && open === null && (
        <AnnotatePointer.Provider>
          <AnnotateLayer page={page} url={url} ownerTabId={ownerTabId} />
        </AnnotatePointer.Provider>
      )}
      {open !== null && (
        <>
          {/* The page takes no input while the editor is open: what it is on stays where it was picked. */}
          <div
            aria-hidden
            className="absolute inset-0 z-20 touch-none"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
          />
          {open.kind === "new" && (
            <PlacedOutline
              page={page}
              rect={open.pick.picked.box}
              className="pointer-events-none z-20 border-2 border-primary bg-primary/10"
            />
          )}
          <PageEditor sessionId={sessionId} open={open} />
        </>
      )}
    </>
  );
};

/**
 * The Browser Pane's Annotations over its screen (render it as `LiveScreen`'s `overlay`): the pins of the drafts on the
 * page the Owner tab `ownerTabId` shows (none while a window of the tab is shown instead), and Annotate mode
 * (`annotateModeAtom`). The drafts' elements are found again only while the Pane is `inView`.
 */
export const PageAnnotationsOverlay = ({
  pane,
  ownerTabId,
  inView,
}: {
  pane: BrowserPaneKey;
  ownerTabId: string | undefined;
  inView: boolean;
}) => (
  <AnnotationEditor.Provider>
    <Overlay pane={pane} ownerTabId={ownerTabId} inView={inView} />
  </AnnotationEditor.Provider>
);

const Overlay = ({
  pane,
  ownerTabId,
  inView,
}: {
  pane: BrowserPaneKey;
  ownerTabId: string | undefined;
  inView: boolean;
}) => {
  const page = useAtomValue(ShownScreenPage.use());
  const url = useAtomValue(ownerTabPageAtom(pane), (shown) => shown.url ?? undefined);
  const windowShown = useAtomValue(ownerTabWindowShownAtom(pane));
  const annotating = useAtomValue(annotateModeAtom(pane));

  if (page === null || url === undefined || ownerTabId === undefined || windowShown) return null;

  return (
    <Layer
      page={page}
      sessionId={pane.sessionId}
      url={url}
      ownerTabId={ownerTabId}
      annotating={annotating}
      inView={inView}
    />
  );
};
