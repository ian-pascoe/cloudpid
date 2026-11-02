// docs/architecture/mcp-apps.md → The App sandbox (What it serves). The headers every sandbox response carries.

// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a response's headers, not a combinator.

/**
 * The fixed headers of every response, a 404 included: nothing is cached (the CSP is per URL), the sandbox never
 * discloses where a View was framed from, and a response is never sniffed into another type. No cookie is set or read.
 */
export const FIXED_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

/** The fixed headers, the response's `content-type`, and a `content-security-policy` when there is one. */
export const sandboxHeaders = (contentType: string, csp?: string): Headers => {
  const headers = new Headers({ ...FIXED_HEADERS, "content-type": contentType });

  if (csp !== undefined) headers.set("content-security-policy", csp);

  return headers;
};
