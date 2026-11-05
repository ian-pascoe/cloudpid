/**
 * Whether an RPC failed because its callee has no such method, a deploy behind (`docs/architecture/mcp.md` → Deploys).
 * The runtime gives no typed marker for it: workerd throws a plain `TypeError` whose only distinguishing mark is its text
 * (`The RPC receiver does not implement the method "x"`, or `... is not a function` on a plain object, as in the
 * conformance run). So the text is matched here, in the one place every caller that reads it past (the endpoint's
 * handler, the Registry's sign-in read through `McpEngine.fetchPublic`) shares, and a failure it does not recognise is
 * not a missing method. No SDK import: `./types` re-exports it.
 */
// @effect-diagnostics missingPipeableSignature:off -- a predicate over a message.
export const isMissingMethod = (message: string): boolean =>
  /does not implement|is not a function/i.test(message);
