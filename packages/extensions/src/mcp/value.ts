// The value a script gets for a call of an MCP tool (`docs/architecture/mcp-in-a-session.md` → Calls and results, The
// script value): the `tools/call` result as the server sent it, without `_meta`, with the text in `content` cut
// largest-first to fit a nested call's value (`MAX_NESTED_STRUCTURED_OUTPUT_BYTES`, one row of storage), and
// `truncated: true` when anything was cut.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain walks over JSON.
import { isJsonObject, type JsonObject } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { MAX_NESTED_STRUCTURED_OUTPUT_BYTES } from "../result-bounds.ts";
import { cutStored, storedBytes } from "../stored-bytes.ts";

/** What a cut string ends with. */
const MARKER = "\n[cut to fit]";

/** Room under the nested bound for what `ResultBounds` counts besides the value itself. */
const HEADROOM_BYTES = 4 * 1024;

/** The weight a script's value may have: the nested bound less its headroom. */
export const SCRIPT_VALUE_BUDGET = MAX_NESTED_STRUCTURED_OUTPUT_BYTES - HEADROOM_BYTES;

/** A string of a content block a cut may shorten: where it lives, what it holds now, and whether it is binary data. */
type Cell = {
  readonly block: number;
  /** A key of the block, or of its embedded `resource`. */
  readonly key: string;
  readonly inResource: boolean;
  readonly binary: boolean;
  readonly text: string;
};

/** A cell still open to a cut, and its place among the cells. */
type Choice = { readonly cell: Cell; readonly position: number };

/** The strings of `block` (number `index`) a cut may shorten: its text and `data`, and an embedded resource's. */
const cellsOf = (index: number, block: Schema.Json): ReadonlyArray<Cell> => {
  if (!isJsonObject(block)) return [];

  const own = ["text", "data"].flatMap((key) => {
    const text = block[key];

    return Predicate.isString(text)
      ? [{ block: index, key, inResource: false, binary: key === "data", text }]
      : [];
  });

  const { resource } = block;

  if (!isJsonObject(resource)) return own;

  const embedded = ["text", "blob"].flatMap((key) => {
    const text = resource[key];

    return Predicate.isString(text)
      ? [{ block: index, key, inResource: true, binary: key === "blob", text }]
      : [];
  });

  return [...own, ...embedded];
};

/** `content` with the cells' texts put back. */
const withCells = (
  content: ReadonlyArray<Schema.Json>,
  cells: ReadonlyArray<Cell>,
): ReadonlyArray<Schema.Json> =>
  Arr.map(content, (block, index) => {
    const mine = cells.filter((cell) => cell.block === index);

    if (mine.length === 0 || !isJsonObject(block)) return block;

    const texts = (inResource: boolean) =>
      Object.fromEntries(
        Arr.flatMap(mine, (cell) =>
          cell.inResource === inResource ? [[cell.key, cell.text]] : [],
        ),
      );

    const resource = isJsonObject(block["resource"]) ? block["resource"] : undefined;

    return resource === undefined
      ? Object.assign({}, block, texts(false))
      : Object.assign({}, block, texts(false), {
          resource: Object.assign({}, resource, texts(true)),
        });
  });

/** The value with `content`: its `structuredContent` and `isError` as the server sent them, never `_meta`. */
const valueWith = (result: JsonObject, content: ReadonlyArray<Schema.Json>, truncated: boolean) => {
  const { structuredContent, isError } = result;
  const base = { content };
  const structured = structuredContent === undefined ? base : { ...base, structuredContent };
  const failing = Predicate.isBoolean(isError) ? { ...structured, isError } : structured;

  return truncated ? { ...failing, truncated: true } : failing;
};

/**
 * The value a script gets from `result` (a `tools/call` result as the server sent it): its `content`,
 * `structuredContent` and `isError`, with `_meta` dropped, and the text cut to `budget` stored bytes when it weighs more.
 * Text is cut largest-first, binary data (an image, a blob) only once no text is left. `structuredContent` is never
 * cut: a value whose `structuredContent` alone is over the budget stays so, and `ResultBounds` refuses it.
 */
export const scriptValueOf = (
  result: JsonObject,
  budget: number = SCRIPT_VALUE_BUDGET,
): JsonObject => {
  const content: ReadonlyArray<Schema.Json> = Array.isArray(result["content"])
    ? result["content"]
    : [];

  // A string longer than the whole budget is cut to its characters first, which keeps what follows cheap.
  const cells = Arr.map(
    Arr.flatMap(content, (block, index) => cellsOf(index, block)),
    (cell) => (cell.text.length > budget ? { ...cell, text: cell.text.slice(0, budget) } : cell),
  );

  let cut = Arr.some(
    Arr.flatMap(content, (block, index) => cellsOf(index, block)),
    (cell) => cell.text.length > budget,
  );

  let current = cells;
  let size = storedBytes(valueWith(result, withCells(content, current), cut));

  // The flag that says text was cut weighs too: a value over the budget is measured with it.
  if (size > budget && !cut) {
    cut = true;
    size = storedBytes(valueWith(result, withCells(content, current), cut));
  }

  const spent = new Set<number>();

  while (size > budget) {
    const open = Arr.flatMap(current, (cell, position): ReadonlyArray<Choice> =>
      spent.has(position) || cell.text === "" ? [] : [{ cell, position }],
    );

    const text = Arr.filter(open, ({ cell }) => !cell.binary);

    const largest = Arr.head(
      Arr.sort(
        text.length > 0 ? text : open,
        Order.flip(Order.mapInput(Order.Number, ({ cell }: Choice) => cell.text.length)),
      ),
    );

    if (Option.isNone(largest)) break;

    const { cell: biggest, position: at } = largest.value;
    const before = storedBytes(biggest.text);
    const shorter = cutStored(biggest.text, Math.max(0, before - (size - budget)), MARKER);

    current = Arr.map(current, (cell, position) =>
      position === at ? { ...cell, text: shorter } : cell,
    );
    spent.add(at);
    size -= before - storedBytes(shorter);
    cut = true;
  }

  return valueWith(result, withCells(content, current), cut);
};
