// @effect-diagnostics missingPipeableSignature:off -- a plain string function.
/**
 * Whether tool `name` matches `pattern`, where `*` matches any run of characters and nothing else is special. One matcher
 * for every list of tool names and patterns: `tools.offered`, toolsets, `toolExposure` keys and `settings_tool_*`.
 */
export const matchesToolPattern = (pattern: string, name: string): boolean => {
  const parts = pattern.split("*");
  const [first = "", ...rest] = parts;

  if (rest.length === 0) return pattern === name;

  const last = rest[rest.length - 1] ?? "";
  const middle = rest.slice(0, -1);

  if (!name.startsWith(first) || name.length < first.length + last.length) return false;

  let at = first.length;
  const end = name.length - last.length;

  for (const part of middle) {
    const found = name.indexOf(part, at);

    if (found === -1 || found + part.length > end) return false;

    at = found + part.length;
  }

  return name.endsWith(last) && at <= end;
};
