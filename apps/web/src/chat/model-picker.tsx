// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { isModelId, THINKING_LEVELS, type ThinkingLevel } from "@cloudpid/config";
import type { SessionView } from "@cloudpid/protocol";
import { Brain, ChevronDown } from "lucide-react";
import { type ComponentProps, type ReactNode, type Ref, useImperativeHandle, useRef } from "react";
import { cn } from "../lib/utils.ts";
import { agentSelect, FOLLOW_DEFAULT, modelChoices, modelName } from "../models.ts";
import type { ConfigureChange, Picked } from "../session/connection.ts";

export const isLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/** Opens a picker from elsewhere, as `/model` and `/thinking` do without an argument. */
export type PickerHandle = {
  readonly openModel: () => void;
  readonly openThinking: () => void;
};

/** Open a native select's list where the platform can, else give it the focus so arrows and Space open it. */
const open = (select: HTMLSelectElement | null) => {
  if (select === null || select.disabled) return;

  select.focus();

  try {
    select.showPicker();
  } catch {
    // Not every browser opens a select's picker on request; the focus is the next best thing.
  }
};

/**
 * A quiet chip in the composer's toolbar that is a native select underneath: the select lies invisibly over the chip,
 * so a click, a tap (the platform's own picker on a phone) or the keyboard reaches it, and the chip shows its value.
 */
const ChipSelect = ({
  icon,
  shown,
  mono = false,
  className,
  ...props
}: ComponentProps<"select"> & {
  icon?: ReactNode;
  /** What the chip says: the value in effect. */
  shown: string;
  /** The value is an identifier (a model ID), set in mono. */
  mono?: boolean;
}) => (
  <span
    className={cn(
      "relative inline-flex h-8 min-w-0 shrink items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors",
      "hover:bg-accent hover:text-accent-foreground has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-ring",
      "has-[select:disabled]:opacity-50",
      className,
    )}
  >
    {icon}
    <span className={cn("truncate", mono && "font-mono")}>{shown}</span>
    <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
    <select
      className="absolute inset-0 cursor-pointer appearance-none opacity-0 outline-none disabled:cursor-default pointer-coarse:-inset-y-1.5"
      {...props}
    />
  </span>
);

/**
 * The model and thinking level the Session's next request runs with, as chips in the composer's toolbar. Picking one
 * applies to the Session alone. Each chip shows the value in effect; its list has the default option, named for what it
 * resolves to, while the Session follows the default in the settings, and the default option makes it follow again.
 * While the Session is not live the chips are disabled, as a pick has no connection to go through.
 */
export const ModelPicker = ({
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
  ref?: Ref<PickerHandle>;
}) => {
  const modelSelect = useRef<HTMLSelectElement>(null);
  const levelSelect = useRef<HTMLSelectElement>(null);

  useImperativeHandle(ref, () => ({
    openModel: () => {
      open(modelSelect.current);
    },
    openThinking: () => {
      open(levelSelect.current);
    },
  }));

  const model = view.model === null ? null : `${view.model.provider}/${view.model.modelId}`;
  const shownModel = model === null ? null : modelName(model);

  const modelChoice = agentSelect(model, picked.model, shownModel);
  const levelChoice = agentSelect(view.thinkingLevel, picked.thinkingLevel);

  const following = (isPicked: boolean) => (isPicked ? "" : ", the default");

  return (
    <>
      <ChipSelect
        ref={modelSelect}
        aria-label={`Model: ${shownModel ?? "loading"}${following(picked.model)}`}
        title="Model"
        disabled={disabled || model === null}
        shown={shownModel ?? "Model"}
        mono={shownModel !== null}
        value={modelChoice.value}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ model: null });
          // Only the models the settings accept can be picked: the Session refuses any other.
          else if (isModelId(value)) onConfigure({ model: value });
        }}
      >
        <option value={FOLLOW_DEFAULT}>{modelChoice.defaultLabel}</option>
        {modelChoices(model).map((choice) => (
          <option key={choice} value={choice}>
            {modelName(choice)}
          </option>
        ))}
      </ChipSelect>
      <ChipSelect
        ref={levelSelect}
        aria-label={`Thinking level: ${view.thinkingLevel ?? "loading"}${following(picked.thinkingLevel)}`}
        title="Thinking level"
        disabled={disabled || view.thinkingLevel === null}
        icon={<Brain className="size-3.5 shrink-0" aria-hidden />}
        shown={view.thinkingLevel ?? "Thinking"}
        className="shrink-0"
        value={levelChoice.value}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ thinkingLevel: null });
          else if (isLevel(value)) onConfigure({ thinkingLevel: value });
        }}
      >
        <option value={FOLLOW_DEFAULT}>{levelChoice.defaultLabel}</option>
        {THINKING_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </ChipSelect>
    </>
  );
};
