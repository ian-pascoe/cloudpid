/** The spend limit as the settings page's text box shows it: US dollars, or nothing for no limit. */
export const spendLimitToText = (limit: number | null): string =>
  limit === null ? "" : String(limit);

/**
 * The spend limit a text box holds: nothing for no limit (`null`), otherwise a positive amount of US dollars, with or
 * without a leading `$`. Undefined when the text is not one.
 */
export const spendLimitFromText = (text: string): number | null | undefined => {
  if (text.trim() === "") return null;

  const bare = text.trim().replace(/^\$\s*/, "");

  if (!/^\d*\.?\d+$/.test(bare)) return undefined;

  const amount = Number(bare);

  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
};
