// docs/architecture/mcp-apps.md → App messages and App context. The chip a card shows of the last context its View told the
// model (`ui/update-model-context`): what it was (cut to a line), and whether the conversation has it yet ("Sent to the model"
// once a turn took it, "Pending" until the next one). The collapsed card shows it too.
import { flatCut, type McpAppContext } from "@cloudpid/protocol";

/** The longest the chip shows of the context, in characters. */
export const SHOWN_CHARS = 120;

/** The App's last context as a line under its header: nothing when it told the model nothing. */
export const AppContextChip = ({ context }: { context: McpAppContext | undefined }) =>
  context === undefined ? null : (
    <div
      className="flex items-center gap-2 border-t px-2 py-1 text-xs text-muted-foreground"
      data-app-context=""
    >
      <span className="shrink-0">Told the model</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={context.text}>
        {flatCut(context.text, SHOWN_CHARS)}
      </span>
      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">
        {context.delivered === true ? "Sent to the model" : "Pending"}
      </span>
    </div>
  );
