// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { isModelId, THINKING_LEVELS, type ThinkingLevel } from "@cloudpid/config";
import type { SessionView } from "@cloudpid/protocol";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { modelChoices, modelName } from "../models.ts";
import type { ConfigureChange } from "../session/connection.ts";

/** The select value that makes the Session follow the default again. */
const FOLLOW_DEFAULT = "";

const isLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/**
 * The model and thinking level the Session's next request runs with, as selects. Picking one applies to the Session
 * alone; "Use the default" makes it follow the default in the settings again. While the Session is not live the
 * selects are disabled, as a pick has no connection to go through.
 */
export const ModelPicker = ({
  view,
  disabled,
  onConfigure,
}: {
  view: Pick<SessionView, "model" | "thinkingLevel">;
  disabled: boolean;
  onConfigure: (change: ConfigureChange) => void;
}) => {
  const model = view.model === null ? null : `${view.model.provider}/${view.model.modelId}`;

  return (
    <div className="flex items-center gap-2">
      <NativeSelect
        aria-label="Model"
        disabled={disabled || model === null}
        value={model ?? ""}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ model: null });
          // Only the models the settings accept can be picked: the Session refuses any other.
          else if (isModelId(value)) onConfigure({ model: value });
        }}
        className="h-8 font-mono text-xs"
      >
        {model === null && <option value="">…</option>}
        {modelChoices(model).map((choice) => (
          <option key={choice} value={choice}>
            {modelName(choice)}
          </option>
        ))}
        <option value={FOLLOW_DEFAULT}>Use the default</option>
      </NativeSelect>
      <NativeSelect
        aria-label="Thinking level"
        disabled={disabled || view.thinkingLevel === null}
        value={view.thinkingLevel ?? ""}
        onChange={(event) => {
          const { value } = event.target;

          if (value === FOLLOW_DEFAULT) onConfigure({ thinkingLevel: null });
          else if (isLevel(value)) onConfigure({ thinkingLevel: value });
        }}
        className="h-8 text-xs"
      >
        {view.thinkingLevel === null && <option value="">…</option>}
        {THINKING_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
        <option value={FOLLOW_DEFAULT}>Use the default</option>
      </NativeSelect>
    </div>
  );
};
