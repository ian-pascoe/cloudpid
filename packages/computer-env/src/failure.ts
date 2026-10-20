// Failures raised in the Workspace DO, where `@cloudflare/computer`'s errors still carry their POSIX code.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics extendsNativeError:off missingPipeableSignature:off
import type { FileErrorCode } from "@earendil-works/pi-durable/env";
import type { WireError } from "./wire.ts";

const POSIX_CODES = new Map<string, FileErrorCode>([
  ["ABORT_ERR", "aborted"],
  ["ENOENT", "not_found"],
  ["EACCES", "permission_denied"],
  ["EPERM", "permission_denied"],
  ["EROFS", "permission_denied"],
  ["ENOTDIR", "not_directory"],
  ["EISDIR", "is_directory"],
  ["EINVAL", "invalid"],
  ["ENOTSUP", "not_supported"],
]);

/** A failure the host decides itself, already in pi-durable's terms. */
export class HostFailure extends Error {
  readonly wire: WireError;

  constructor(code: FileErrorCode, message: string, path: string) {
    super(message);
    this.wire = { code, message, path };
  }
}

/** The POSIX code of a Workspace error (`ENOENT`, …). */
export const posixCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause ? String(cause.code) : undefined;

export const toWireError = (cause: unknown, path: string): WireError => {
  if (cause instanceof HostFailure) return cause.wire;

  const message = cause instanceof Error ? cause.message : String(cause);

  return { code: POSIX_CODES.get(posixCode(cause) ?? "") ?? "unknown", message, path };
};
