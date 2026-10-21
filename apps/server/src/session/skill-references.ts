// `$name` Skill references (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a `$name` in the prose of the
// owner's message that names a known Skill becomes, in place, a Markdown link to the Skill's `SKILL.md`, which the model
// reads when it needs it. Ported from the owner's local pi extension pi-skills-selector (`src/skill-references.ts`, its
// `transformSkillReferences`), which finds the prose with marked's lexer: the same rules, on the Session's Skills
// (`filePath` for pi's `path`), with `marked` imported directly rather than through pi-tui.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- ported as upstream wrote it: plain string functions over marked's tokens.
import { Marked, type Token, type Tokens } from "marked";

/** A Skill a message may reference: its name and the absolute path of its `SKILL.md`. */
export type ReferencedSkill = { readonly name: string; readonly filePath: string };

interface ProseSpan {
  text: string;
  positions: number[];
}

const markdown = new Marked();

// Container text removes line prefixes. Project its characters back onto the source.
function projectSource(source: string, target: string, positions: number[]): number[] | undefined {
  const sourceLines = source.split("\n");
  const targetLines = target.split("\n");
  const result: number[] = [];
  let offset = 0;

  for (const [index, line] of targetLines.entries()) {
    const sourceLine = sourceLines[index];

    if (sourceLine === undefined) return undefined;

    let start = sourceLine.lastIndexOf(line);
    let linePositions = positions.slice(offset, offset + sourceLine.length);

    if (start < 0 && sourceLine.includes("\t")) {
      let expanded = "";

      linePositions = [];

      for (let column = 0; column < sourceLine.length; column++) {
        const character = sourceLine[column] ?? "";
        const replacement = character === "\t" ? " ".repeat(4 - (expanded.length % 4)) : character;

        expanded += replacement;

        const position = positions[offset + column];

        if (position !== undefined) for (const _ of replacement) linePositions.push(position);
      }

      start = expanded.lastIndexOf(line);
    }

    if (start < 0) return undefined;

    for (const position of linePositions.slice(start, start + line.length)) result.push(position);

    const newline = positions[offset + sourceLine.length];

    if (index < targetLines.length - 1 && newline !== undefined) result.push(newline);

    offset += sourceLine.length + 1;
  }

  return result;
}

function collectProse(
  tokens: Token[],
  source: string,
  positions: number[],
  spans: ProseSpan[],
): void {
  let offset = 0;

  for (const token of tokens) {
    const start = source.indexOf(token.raw, offset);

    if (start < 0) return;

    const tokenPositions = positions.slice(start, start + token.raw.length);

    if (token.type === "text" && token.tokens === undefined && token.escaped !== true) {
      spans.push({ text: token.raw, positions: tokenPositions });
    } else if (token.type === "list") {
      collectProse(token.items, token.raw, tokenPositions, spans);
    } else if (token.type === "table") {
      let rowOffset = 0;

      for (const [rowIndex, row] of token.raw.split("\n").entries()) {
        const cells: Tokens.TableCell[] | undefined =
          rowIndex === 0 ? token.header : token.rows[rowIndex - 2];

        const characters: string[] = [];
        const rowPositions: number[] = [];

        let backslashes = 0;

        // Marked removes the escape before a cell's literal pipe, but not a separator.
        for (let index = 0; index < row.length; index++) {
          const character = row[index] ?? "";

          if (character === "|" && backslashes % 2 === 1) {
            characters.pop();
            rowPositions.pop();
          }

          characters.push(character);

          const position = tokenPositions[rowOffset + index];

          if (position !== undefined) rowPositions.push(position);

          backslashes = character === "\\" ? backslashes + 1 : 0;
        }

        const normalizedRow = characters.join("");
        let cellOffset = 0;

        for (const cell of cells ?? []) {
          const content = cell.tokens.map((child) => child.raw).join("");
          const cellStart = normalizedRow.indexOf(content, cellOffset);

          if (cellStart < 0) break;

          collectProse(
            cell.tokens,
            content,
            rowPositions.slice(cellStart, cellStart + content.length),
            spans,
          );
          cellOffset = cellStart + content.length;
        }

        rowOffset += row.length + 1;
      }
    } else if (
      token.type === "blockquote" ||
      token.type === "list_item" ||
      token.type === "paragraph" ||
      token.type === "heading" ||
      token.type === "text" ||
      token.type === "em" ||
      token.type === "strong" ||
      token.type === "del"
    ) {
      const children = token.tokens ?? [];
      const content = children.map((child) => child.raw).join("");
      const projection = projectSource(token.raw, content, tokenPositions);

      // ponytail: uncommon lexer whitespace rewrites stay literal; extend projection if needed.
      if (projection !== undefined) collectProse(children, content, projection, spans);
    }

    offset = start + token.raw.length;
  }
}

function proseSpans(text: string): ProseSpan[] {
  const positions: number[] = [];
  let normalized = "";

  for (let index = 0; index < text.length; index++) {
    positions.push(index);
    normalized += text[index] === "\r" ? "\n" : text[index];

    if (text[index] === "\r" && text[index + 1] === "\n") index++;
  }

  const spans: ProseSpan[] = [];

  collectProse(markdown.lexer(normalized), normalized, positions, spans);

  return spans;
}

function matchesReferenceSource(text: string, start: number, reference: string): boolean {
  const end = start + reference.length;
  const before = text.slice(0, start);

  return (
    text.slice(start, end) === reference &&
    !/[\p{L}\p{M}\p{N}$/-]$/u.test(before) &&
    !/(?<!\\)(?:\\\\)*\\_$/u.test(before) &&
    !/^\\[_$/-]/u.test(text.slice(end))
  );
}

/**
 * `text` with each `$name` in its prose that names one of `skills` (exactly, case-sensitively) replaced in place by a
 * link to the Skill's `SKILL.md`: `[$name](/path/to/SKILL.md)`, every occurrence, in order. Unknown names and
 * expressions such as `$HOME` stay literal, as do an escaped `\$name`, code, and existing Markdown links. A Skill whose
 * path is not absolute and well formed is not linked.
 */
export function linkSkillReferences(text: string, skills: readonly ReferencedSkill[]): string {
  const catalogue = new Map(skills.map((skill) => [skill.name, skill.filePath]));

  const names = [...catalogue.keys()]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // Not upstream's: a message without a `$` has nothing to link, so it is not lexed.
  if (names.length === 0 || !text.includes("$")) return text;

  const referencePattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_$/+-])\\$(${names.join("|")})(?![\\p{L}\\p{M}\\p{N}_$/+-]|\\.[\\p{L}\\p{M}\\p{N}_])`,
    "gu",
  );

  let result = "";
  let offset = 0;

  for (const span of proseSpans(text)) {
    for (const match of span.text.matchAll(referencePattern)) {
      const path = catalogue.get(match[0].slice(1));

      // pi's `isAbsolute`: the Session's paths are POSIX.
      if (path === undefined || !path.startsWith("/") || !path.isWellFormed()) continue;

      const start = span.positions[match.index];

      if (start === undefined || !matchesReferenceSource(text, start, match[0])) continue;

      const destination = encodeURI(path).replace(
        /[?#()]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );

      result += text.slice(offset, start) + `[${match[0]}](${destination})`;
      offset = start + match[0].length;
    }
  }

  return result + text.slice(offset);
}
