/**
 * The management tools as the SDK is given them (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
 * The dispatcher and `describe().harness`): each tool the shared declarations (`@cloudpid/protocol/harness-tools`) know,
 * offered only when `describe().harness` lists it. `McpServer` knows a tool's name, description, schemas and annotations;
 * the main Worker's `harness` operation runs its core and answers `{text, structured}`, which this only wraps: the text is
 * the core's (the same words as in a Session, cut for the endpoint), and `structuredContent` is its flat object.
 */
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  HARNESS_TOOLS,
  type HarnessToolName,
  MAX_PAGE_CHARS,
} from "@cloudpid/protocol/harness-tools";
import { ApiResult, HarnessAnswer, harnessServed } from "@cloudpid/protocol/mcp-api";
import type * as Exit from "effect/Exit";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Tool, Wire } from "./tools.ts";

/**
 * The most characters of a management tool's text: a field page whole (`MAX_PAGE_CHARS`) and the note that says where it
 * sits in the field. The core cuts every other answer to 12,000 characters, so only a page comes near it.
 */
export const HARNESS_MAX_TEXT_CHARS = MAX_PAGE_CHARS + 1_000;

/** What `tools/list` titles each tool (every name is here: the type holds it to `HARNESS_TOOLS`). */
const TITLES: Readonly<Record<HarnessToolName, string>> = {
  environment_list: "List Environments to manage",
  environment_get: "Show an Environment",
  settings_get: "Show Settings",
  settings_mcp_list: "List MCP servers",
  settings_mcp_get: "Show an MCP server",
};

const decode = Schema.decodeUnknownExit(ApiResult(HarnessAnswer));

/** A management tool, from its declaration. */
const harnessTool = (name: HarnessToolName): Tool => {
  const declaration = HARNESS_TOOLS[name];

  return {
    name,
    title: TITLES[name],
    served: (description) =>
      description.operations.includes("harness") && harnessServed(description).includes(name),
    maxText: HARNESS_MAX_TEXT_CHARS,
    describe: () => declaration.endpoint.description,
    annotations: declaration.annotations,
    progress: undefined,
    span: undefined,
    input: declaration.endpoint.input,
    output: declaration.endpoint.output,
    call: (api, args, via) => {
      // A plain object with no `harness` is read as the missing method it is (`McpServer`'s `rpcFailure`).
      if (api.harness === undefined) throw new TypeError("api.harness is not a function");

      return api.harness({ tool: name, input: args, via });
    },
    // SAFETY: the result's own type is erased here, as `Tool` says.
    read: (answered) => decode(answered) as Exit.Exit<ApiResult<Wire>, Schema.SchemaError>,
    present: (value) => {
      // SAFETY: `value` was decoded with `HarnessAnswer`.
      const { text, structured } = value as HarnessAnswer;

      // SAFETY: every management tool's structured value is a flat object (`harness-tools.test.ts` holds its schema to one).
      return { text, structured: structured as Readonly<Record<string, Wire>> };
    },
  };
};

/** Every management tool `McpServer` knows, in the order `HARNESS_TOOLS` declares them. */
// SAFETY: the keys of the record are its tools' names.
export const harnessTools: ReadonlyArray<Tool> = Record.keys(HARNESS_TOOLS).map(harnessTool);
