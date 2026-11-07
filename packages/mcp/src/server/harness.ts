/**
 * The management tools as the SDK is given them (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
 * The dispatcher and `describe().harness`): each tool the shared declarations (`@cloudpid/protocol/harness-tools`) know,
 * offered only when `describe().harness` lists it. `McpServer` knows a tool's name, description, schemas and annotations;
 * the main Worker's `harness` operation runs its core and answers `{text, structured}`, which this only wraps: the text is
 * the core's (the same words as in a Session, cut for the endpoint), and `structuredContent` is its flat object.
 */
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferTypedSchemaDecoder:off -- an answer is read for the keys `next` needs, whatever else it holds.
import {
  HARNESS_TOOLS,
  type HarnessToolName,
  MAX_PAGE_CHARS,
} from "@cloudpid/protocol/harness-tools";
import { ApiResult, apiFailure, HarnessAnswer, harnessServed } from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import type * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Enabled, Tool, Wire } from "./tools.ts";

/**
 * The most characters of a management tool's text: a field page whole (`MAX_PAGE_CHARS`), plus 1,000 for the footer that
 * says where the page sits in the field and for the `next` sentence. The core cuts every other answer to 12,000
 * characters, so only a page comes near it.
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

/** What `next` reads of a page, whichever tool answers it: where it is and where the next begins. */
const PageKeys = {
  id: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  next_offset: Schema.optionalKey(Schema.Int),
};

const ScopeKey = Schema.Struct({ id: Schema.String });

const InstructionsKey = Schema.Struct({ text_truncated: Schema.Boolean });

/**
 * A tool's `next` sentence: the keys of its answer it reads (only those, so an answer with more or less is still read),
 * and what follows from them, over the tools that are served.
 */
const nextOf =
  <S extends Schema.Decoder<unknown>>(
    keys: S,
    sentence: (value: S["Type"], enabled: Enabled) => string | undefined,
  ) =>
  (structured: Wire, enabled: Enabled): string | undefined =>
    Option.getOrUndefined(
      Option.flatMap(Schema.decodeUnknownOption(keys)(structured), (value) =>
        Option.fromNullishOr(sentence(value, enabled)),
      ),
    );

/** The call for the page after one that was cut: the same field, from where the page ended. */
const nextPage = (
  tool: string,
  key: "id" | "scope",
  page: { readonly id?: string; readonly field?: string; readonly next_offset?: number },
): string | undefined =>
  page.id === undefined || page.field === undefined || page.next_offset === undefined
    ? undefined
    : `Call ${tool} with ${key}="${page.id}", field="${page.field}" and offset=${String(page.next_offset)} for the next page.`;

const NEXTS: Readonly<
  Record<HarnessToolName, (structured: Wire, enabled: Enabled) => string | undefined>
> = {
  environment_list: nextOf(
    Schema.Struct({ environments: Schema.Array(Schema.Unknown) }),
    ({ environments }, enabled) =>
      enabled.has("environment_get") && environments.length > 0
        ? "Call environment_get with an id to see one Environment's settings."
        : undefined,
  ),
  environment_get: nextOf(
    Schema.Struct({
      ...PageKeys,
      scope: Schema.optionalKey(ScopeKey),
      settings_truncated: Schema.optionalKey(Schema.Boolean),
      variables: Schema.Struct({ value_truncated: Schema.Boolean }).pipe(
        Schema.Array,
        Schema.optionalKey,
      ),
    }),
    (value) => {
      const page = nextPage("environment_get", "id", value);

      if (page !== undefined) return page;

      const cutValue = value.variables?.some((variable) => variable.value_truncated) === true;

      return value.scope !== undefined && (value.settings_truncated === true || cutValue)
        ? `Call environment_get with id="${value.scope.id}" and field (setupScript, startScript, toolchains, ignore or variables.<NAME>) to read a cut text whole.`
        : undefined;
    },
  ),
  settings_get: nextOf(
    Schema.Struct({
      ...PageKeys,
      scope: Schema.optionalKey(ScopeKey),
      instructions: Schema.optionalKey(
        Schema.Struct({
          global: InstructionsKey,
          environment: Schema.NullOr(InstructionsKey),
        }),
      ),
    }),
    (value) => {
      const page = nextPage("settings_get", "scope", value);

      if (page !== undefined) return page;

      if (value.scope === undefined || value.instructions === undefined) return undefined;

      // A cut text is read through the Scope it is kept in: Global's at "*", an Environment's own at its id.
      const cut = Arr.filter(
        [
          value.instructions.global.text_truncated ? "*" : undefined,
          value.instructions.environment?.text_truncated === true ? value.scope.id : undefined,
        ],
        (scope) => scope !== undefined,
      );

      return cut.length === 0
        ? undefined
        : `Call settings_get with field="instructions" and scope ${Arr.join(
            Arr.map(cut, (scope) => `"${scope}"`),
            " or ",
          )} to read the cut Instructions whole.`;
    },
  ),
  settings_mcp_list: nextOf(
    Schema.Struct({ scope: ScopeKey, servers: Schema.Array(Schema.Unknown) }),
    (value, enabled) =>
      enabled.has("settings_mcp_get") && value.servers.length > 0
        ? `Call settings_mcp_get with scope="${value.scope.id}" and a server's name to see it in full.`
        : undefined,
  ),
  settings_mcp_get: () => undefined,
};

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
    call: (api, args, via) =>
      api.harness === undefined
        ? Promise.resolve(
            apiFailure("unsupported", "The server does not support this yet: try again shortly."),
          )
        : api.harness({ tool: name, input: args, via }),
    // SAFETY: the result's own type is erased here, as `Tool` says.
    read: (answered) => decode(answered) as Exit.Exit<ApiResult<Wire>, Schema.SchemaError>,
    present: (value, enabled) => {
      // SAFETY: `value` was decoded with `HarnessAnswer`.
      const { text, structured } = value as HarnessAnswer;

      // SAFETY: every management tool's structured value is a flat object (`harness-tools.test.ts` holds its schema to one).
      const flat = structured as Readonly<Record<string, Wire>>;

      const next = NEXTS[name](structured, enabled);

      return next === undefined
        ? { text, structured: flat }
        : { text: `${text}\n\n${next}`, structured: { ...flat, next } };
    },
  };
};

/** Every management tool `McpServer` knows, in the order `HARNESS_TOOLS` declares them. */
// SAFETY: the keys of the record are its tools' names.
export const harnessTools: ReadonlyArray<Tool> = Record.keys(HARNESS_TOOLS).map(harnessTool);
