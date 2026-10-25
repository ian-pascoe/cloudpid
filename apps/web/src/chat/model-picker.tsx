// The model and thinking level the Session's next request runs with, as one chip in the composer's toolbar. Its menu
// lists the models; each opens a submenu of the thinking levels, and picking a level picks both. On a wide screen the
// submenu sits beside the models and follows the one hovered or focused; on a phone a tap on a model goes into its
// levels, with a row back to the models.

import { THINKING_LEVELS } from "@cloudpid/config";
import type { SessionView } from "@cloudpid/protocol";
import { useAtom } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
} from "react";
import { popoverPanel, useAnchoredPopover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { agentSelect, FOLLOW_DEFAULT, modelChoices, modelName, pickedChange } from "../models.ts";
import type { ConfigureChange, Picked } from "../session/state.ts";

/** Opens the picker from elsewhere, as `/model` and `/thinking` do without an argument. */
export type PickerHandle = {
  /** Open it on the models. */
  readonly openModel: () => void;
  /** Open it on the thinking levels of the model in effect. */
  readonly openThinking: () => void;
};

/** Which list a phone shows, and the model whose thinking levels the submenu lists. */
type PickerState = { readonly view: "models" | "levels"; readonly model: string };

const PickerScope = ScopedAtom.make(() =>
  Atom.make<PickerState>({ view: "models", model: FOLLOW_DEFAULT }),
);

/** A row of the menu: a choice, marked when it is the one in effect. */
const row =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:-outline-offset-2 [&_svg]:size-4 [&_svg]:shrink-0";

const Mark = ({ checked }: { checked: boolean }) => (
  <Check className={cn("text-foreground", !checked && "invisible")} aria-hidden />
);

const ListLabel = ({ children }: { children: ReactNode }) => (
  <div role="presentation" className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
    {children}
  </div>
);

/** The rows of the list that holds `from`, in order. */
const rowsBeside = (from: HTMLElement): HTMLElement[] => [
  ...(from.closest("[data-list]")?.querySelectorAll<HTMLElement>("[data-row]") ?? []),
];

const Picker = ({
  view,
  picked,
  disabled,
  onConfigure,
  ref,
}: {
  view: Pick<SessionView, "model" | "thinkingLevel">;
  picked: Picked;
  disabled: boolean;
  onConfigure: (change: ConfigureChange) => void;
  ref?: Ref<PickerHandle> | undefined;
}) => {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [state, setState] = useAtom(PickerScope.use());
  // The list to move the focus into once the next render is on screen.
  const pendingFocus = useRef<"models" | "levels" | null>(null);
  const shownView = useRef(state.view);

  shownView.current = state.view;

  const model = view.model === null ? null : `${view.model.provider}/${view.model.modelId}`;
  const shownModel = model === null ? null : modelName(model);
  const modelChoice = agentSelect(model, picked.model, shownModel);
  const levelChoice = agentSelect(view.thinkingLevel, picked.thinkingLevel);
  const models = [FOLLOW_DEFAULT, ...modelChoices(model)];
  const levels = [FOLLOW_DEFAULT, ...THINKING_LEVELS];

  const modelLabel = (choice: string) =>
    choice === FOLLOW_DEFAULT ? modelChoice.defaultLabel : modelName(choice);

  const levelLabel = (choice: string) =>
    choice === FOLLOW_DEFAULT ? levelChoice.defaultLabel : choice;

  /** Focus the checked row of `list`, or its first. */
  const focusList = (list: "models" | "levels") => {
    const rows = [
      ...(panel.current?.querySelectorAll<HTMLElement>(`[data-list="${list}"] [data-row]`) ?? []),
    ];

    Arr.findFirst(rows, (each) => each.getAttribute("aria-checked") === "true")
      .pipe(
        Option.orElse(() => Arr.head(rows)),
        Option.getOrUndefined,
      )
      ?.focus();
  };

  useEffect(() => {
    if (pendingFocus.current === null) return;

    focusList(pendingFocus.current);
    pendingFocus.current = null;
  });

  useAnchoredPopover(trigger, panel, "start", () => {
    focusList(shownView.current);
  });

  /** Open the menu on `list`, its submenu on the model in effect. */
  const openOn = (list: "models" | "levels") => {
    setState({ view: list, model: modelChoice.value });

    if (!disabled && model !== null) panel.current?.showPopover();
  };

  useImperativeHandle(ref, () => ({
    openModel: () => {
      openOn("models");
    },
    openThinking: () => {
      openOn("levels");
    },
  }));

  const goToLevels = (choice: string) => {
    setState({ view: "levels", model: choice });
    pendingFocus.current = "levels";
  };

  const goToModels = () => {
    setState({ ...state, view: "models" });
    pendingFocus.current = "models";
  };

  const pick = (level: string) => {
    panel.current?.hidePopover();
    onConfigure(pickedChange(state.model, level));
  };

  // The arrows, Home and End move within a list; Right goes into a model's levels, Left back to the models.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-row")) return;

    const rows = rowsBeside(event.target);
    const at = rows.indexOf(event.target);
    const list = event.target.closest("[data-list]")?.getAttribute("data-list");

    const next = Match.value(event.key).pipe(
      Match.when("ArrowDown", () => rows[(at + 1) % rows.length]),
      Match.when("ArrowUp", () => rows[(at - 1 + rows.length) % rows.length]),
      Match.when("Home", () => rows[0]),
      Match.when("End", () => rows.at(-1)),
      Match.orElse(() => undefined),
    );

    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    } else if (event.key === "ArrowRight" && list === "models") {
      event.preventDefault();
      goToLevels(event.target.dataset["value"] ?? FOLLOW_DEFAULT);
    } else if (event.key === "ArrowLeft" && list === "levels") {
      event.preventDefault();
      goToModels();
    }
  };

  const following = (isPicked: boolean) => (isPicked ? "" : ", the default");
  const submenuFor = modelLabel(state.model);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={`Model: ${shownModel ?? "loading"}${following(picked.model)}; thinking level: ${view.thinkingLevel ?? "loading"}${following(picked.thinkingLevel)}`}
        title="Model and thinking level"
        disabled={disabled || model === null}
        onClick={() => {
          // The button opens the menu itself (`popoverTarget`), on the models.
          setState({ view: "models", model: modelChoice.value });
        }}
        className="touch-target inline-flex h-8 min-w-0 shrink items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        {shownModel === null ? (
          <span className="truncate">Model</span>
        ) : (
          <span className="flex min-w-0 font-mono">
            <span className="truncate">{shownModel}</span>
            <span className="shrink-0">:{view.thinkingLevel ?? "…"}</span>
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Model and thinking level"
        onKeyDown={onKeyDown}
        className={cn(
          popoverPanel,
          "max-h-[70vh] w-[min(18rem,calc(100vw-1rem))] gap-1 overflow-y-auto sm:w-[30rem] [&:popover-open]:flex",
        )}
      >
        <div
          data-list="models"
          role="group"
          aria-label="Model"
          className={cn(
            "min-w-0 flex-1 flex-col",
            state.view === "models" ? "flex" : "hidden sm:flex",
          )}
        >
          <ListLabel>Model</ListLabel>
          {Arr.map(models, (choice) => {
            const checked = choice === modelChoice.value;
            const open = choice === state.model;

            return (
              <button
                key={choice}
                type="button"
                data-row
                data-value={choice}
                role="menuitemradio"
                aria-checked={checked}
                aria-haspopup="menu"
                aria-expanded={open && state.view === "levels"}
                onClick={() => {
                  goToLevels(choice);
                }}
                onFocus={() => {
                  if (!open) setState({ ...state, model: choice });
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse" && !open) setState({ ...state, model: choice });
                }}
                className={cn(row, open && "sm:bg-accent/60")}
              >
                <Mark checked={checked} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    choice !== FOLLOW_DEFAULT && "font-mono text-[0.8125rem]",
                  )}
                >
                  {modelLabel(choice)}
                </span>
                <ChevronRight className="text-muted-foreground" aria-hidden />
              </button>
            );
          })}
        </div>
        <div
          data-list="levels"
          role="group"
          aria-label={`Thinking level for ${submenuFor}`}
          className={cn(
            "min-w-0 flex-col sm:w-44 sm:shrink-0 sm:border-l sm:pl-1",
            state.view === "levels" ? "flex" : "hidden sm:flex",
          )}
        >
          <button
            type="button"
            onClick={goToModels}
            className={cn(row, "text-muted-foreground sm:hidden")}
          >
            <ChevronLeft aria-hidden />
            <span className="min-w-0 truncate font-mono text-[0.8125rem]">{submenuFor}</span>
          </button>
          <ListLabel>Thinking level</ListLabel>
          {Arr.map(levels, (choice) => {
            const checked = choice === levelChoice.value;

            return (
              <button
                key={choice}
                type="button"
                data-row
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => {
                  pick(choice);
                }}
                className={row}
              >
                <Mark checked={checked} />
                <span className="min-w-0 flex-1 truncate">{levelLabel(choice)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
};

/**
 * The model and thinking level the Session's next request runs with, as one chip in the composer's toolbar. Picking
 * applies to the Session alone. The chip shows the values in effect; each list has the default option, named for what it
 * resolves to, while the Session follows the default in the settings, and the default option makes it follow again.
 * While the Session is not live the chip is disabled, as a pick has no connection to go through.
 */
export const ModelPicker = (props: {
  view: Pick<SessionView, "model" | "thinkingLevel">;
  picked: Picked;
  disabled: boolean;
  onConfigure: (change: ConfigureChange) => void;
  ref?: Ref<PickerHandle>;
}) => (
  <PickerScope.Provider>
    <Picker {...props} />
  </PickerScope.Provider>
);
