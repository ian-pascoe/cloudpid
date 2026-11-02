// What a strict decode reports: each problem with the keys that lead to it and a line for a person to read. Shared by the
// settings (`settings.ts`) and the MCP server entries they hold (`mcp-servers.ts`).
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** One thing wrong with overrides: the keys that lead to it, and a line for a person to read. */
export type SettingsProblem = { readonly keys: ReadonlyArray<string>; readonly line: string };

/** The problems of a failed decode, one per issue. */
export const problemsOf = (error: Schema.SchemaError): ReadonlyArray<SettingsProblem> =>
  Arr.map(formatIssues(error.issue).issues, (issue) => {
    const keys = Arr.map(issue.path ?? [], (key) =>
      String(Predicate.hasProperty(key, "key") ? key.key : key),
    );

    const path = Arr.join(keys, ".");

    return { keys, line: path === "" ? issue.message : `${path}: ${issue.message}` };
  });

/** The lines of `problems` for a person to read, one each, or on one line with `separator`. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a join of plain problems, not a combinator.
export const problemLines = (problems: ReadonlyArray<SettingsProblem>, separator = "\n"): string =>
  Arr.join(
    Arr.map(problems, (problem) => problem.line),
    separator,
  );

/**
 * `decoded` with `extra` problems, which a schema cannot see, added to its own: it succeeds only when it decoded and
 * there are none.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a combination of two plain results, not a combinator.
export const withProblems = <A>(
  decoded: Result.Result<A, ReadonlyArray<SettingsProblem>>,
  extra: ReadonlyArray<SettingsProblem>,
): Result.Result<A, ReadonlyArray<SettingsProblem>> =>
  Result.isSuccess(decoded) && extra.length === 0
    ? decoded
    : Result.fail([...(Result.isFailure(decoded) ? decoded.failure : []), ...extra]);
