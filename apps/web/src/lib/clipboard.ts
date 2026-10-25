/**
 * Write `text` to the clipboard, with `html` beside it when given, for the apps that paste formatting. Call it inside the
 * gesture: the write starts at once and the HTML may follow as a promise (a `ClipboardItem`'s data may be one, as iOS
 * wants the write itself in the gesture). Without `ClipboardItem`, or when the rich write fails, the text alone is
 * written. Resolves whether the clipboard took anything.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a promise for React callers, not an Effect.
export const copyToClipboard = (text: string, html?: Promise<string>): Promise<boolean> => {
  // Undefined outside a secure context.
  const clipboard: Clipboard | undefined = navigator.clipboard;

  if (clipboard === undefined) return Promise.resolve(false);

  const plain = () =>
    clipboard.writeText(text).then(
      () => true,
      () => false,
    );

  if (html === undefined || !("ClipboardItem" in window)) return plain();

  return clipboard
    .write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": html.then((value) => new Blob([value], { type: "text/html" })),
      }),
    ])
    .then(() => true, plain);
};
