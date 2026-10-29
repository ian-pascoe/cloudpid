// What `browser_owner_tabs` and `browser_handoff` return to programs (`docs/architecture/agent-capabilities.md` → Values for
// programs): each tool's `structuredOutput`, declared as its `structuredOutputSchema`. It holds what the tool's text
// tells the model, as data: an Owner tab by ID, title and origin (never its URL, which may carry a token), and how a
// handoff ended with the origins of the windows the tab left open (never a URL or a Live View link). A list or text that
// can grow is cut to `MAX_PART_BYTES` stored, with a `<field>_truncated` flag.
// `browser` has none: its result is what the caller's own code returned.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";

/** One Owner tab, as the agent is told of it. */
export const OwnerTabOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "The ID to pass as browser's tab" }),
  title: Schema.String.annotate({
    description: "The page's title, which is the page's own words, cut to 200 characters",
  }),
  origin: Schema.String.annotate({
    description: 'The page\'s origin, never its URL; "" when it has no address',
  }),
  shown: Schema.Boolean.annotate({ description: "The Browser Pane shows this tab" }),
}).annotate({ description: "One of the user's Owner tabs" });

/** `browser_owner_tabs`: the Owner tabs open. */
export const OwnerTabsOutput = Schema.Struct({
  tabs: Schema.Array(OwnerTabOutput).annotate({
    description: "The user's Owner tabs; empty when none is open",
  }),
  tabs_truncated: Schema.Boolean.annotate({
    description: "The list was cut to stay within the size bound of a value",
  }),
});

const Origins = Schema.Array(
  Schema.String.annotate({ description: "A window's origin, never its URL" }),
);

/** `browser_handoff`: how the handoff ended. */
export const HandoffOutput = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "timeout", "ended"]).annotate({
    description:
      "completed: the user finished it; failed: the user reported they could not (see reason); timeout: the user did not finish in time; ended: it ended, but Browser Run did not say how",
  }),
  reason: Schema.NullOr(Schema.String).annotate({
    description: "The user's reason when the handoff failed and they gave one; else null",
  }),
  reason_truncated: Schema.Boolean.annotate({
    description: "The reason was cut to stay within the size bound of a value",
  }),
  windows: Schema.NullOr(Origins).annotate({
    description:
      "The origins of the windows (pop-ups, new tabs) the tab left open, never their URLs; null when the host could not say",
  }),
  windows_truncated: Schema.Boolean.annotate({
    description: "The windows list was cut to stay within the size bound of a value",
  }),
});
