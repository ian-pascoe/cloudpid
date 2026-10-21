// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { isModelId, THINKING_LEVELS, type ThinkingLevel } from "@cloudpid/config";
import type { SessionView } from "@cloudpid/protocol";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { agentSelect, FOLLOW_DEFAULT, modelChoices, modelName } from "../models.ts";
import type { ConfigureChange, Picked } from "../session/connection.ts";

const isLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/**
 * The model and thinking level the Session's next request runs with, as selects. Picking one applies to the Session
 * alone. Each select shows the default option, named for what it resolves to, while the Session follows the default in
 * the settings, and the concrete value once the Session picked it; the default option makes it follow again. While the
 * Session is not live the selects are disabled, as a pick has no connection to go through.
 */
export const ModelPicker = ({
  view,
  picked,
  disabled,
  onConfigure,
}: {
  view: Pick<SessionView, "model" | "thinkingLevel">;
  picked: Picked;
  disabled: boolean;
  onConfigure: (change: ConfigureChange) => void;
}) => {
  const model = view.model === null ? null : `${view.model.provider}/${view.model.modelId}`;

  const modelSelect = agentSelect(model, picked.model, model === null ? null : modelName(model));
  const levelSelect = agentSelect(view.thinkingLevel, picked.thinkingLevel);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <NativeSelect
        aria-label="Model"
        disabled={disabled || model === null}
        value={modelSelect.value}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ model: null });
          // Only the models the settings accept can be picked: the Session refuses any other.
          else if (isModelId(value)) onConfigure({ model: value });
        }}
        className="h-8 min-w-0 flex-1 font-mono text-xs md:flex-none"
      >
        <option value={FOLLOW_DEFAULT}>{modelSelect.defaultLabel}</option>
        {modelChoices(model).map((choice) => (
          <option key={choice} value={choice}>
            {modelName(choice)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Thinking level"
        disabled={disabled || view.thinkingLevel === null}
        value={levelSelect.value}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ thinkingLevel: null });
          else if (isLevel(value)) onConfigure({ thinkingLevel: value });
        }}
        className="h-8 min-w-0 shrink-0 text-xs"
      >
        <option value={FOLLOW_DEFAULT}>{levelSelect.defaultLabel}</option>
        {THINKING_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
};
