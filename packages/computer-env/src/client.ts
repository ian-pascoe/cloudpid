// The client end of the Workspace DO's file operations: one RPC call per operation, its answer as a pi-durable
// `Result`, and the call's abort honored before and after it.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import type { Context } from "@earendil-works/chord";
import { err, FileError, type Result } from "@earendil-works/pi-durable/env";
import {
  type EnvRequest,
  type EnvResponse,
  fromResult,
  type HostOperation,
  type HostOperations,
  type WireResult,
} from "./wire.ts";

/**
 * What a Workspace DO stub answers for `ComputerExecutionEnv`'s file operations. A stub's RPC types rewrite each
 * answer's type (adding `Disposable`, making arrays readonly), so the answer is only declared as an object here and
 * read as the `WorkspaceEnvHost` answer it is.
 */
export interface ComputerEnvHost {
  fileOperation(request: EnvRequest): Promise<object>;
}

/** The value an operation's successful answer holds. */
export type ValueOf<Operation extends HostOperation> =
  EnvResponse<Operation> extends WireResult<infer Value> ? Value : never;

/** Run one host operation. */
export type Call = <Operation extends HostOperation>(
  context: Context,
  op: Operation,
  ...args: Parameters<HostOperations[Operation]>
) => Promise<Result<ValueOf<Operation>, FileError>>;

/** Failures of the RPC call itself (the Workspace DO was unreachable or reset), not of the operation it asked for. */
const unreachable = new WeakSet<FileError>();

/** Whether `error` says the Workspace DO could not be reached, so the operation may succeed if repeated. */
export const isUnreachable = (error: FileError): boolean => unreachable.has(error);

export const abortedResult = <T>(
  context: Context,
  path?: string,
): Result<T, FileError> | undefined =>
  context.abortSignal?.aborted === true
    ? err(new FileError("aborted", "aborted", path))
    : undefined;

/** A `Call` on `host`. */
export const caller =
  (host: ComputerEnvHost): Call =>
  async (context, op, ...args) => {
    const path = args[0] instanceof Array ? undefined : String(args[0]);
    const before = abortedResult<ValueOf<typeof op>>(context, path);

    if (before !== undefined) return before;

    let response: WireResult<ValueOf<typeof op>>;

    try {
      // SAFETY: `op` and `args` come from one `HostOperations` member, the pairing `EnvRequest` lists; the Workspace DO
      // answers it with that operation's result.
      response = (await host.fileOperation({ op, args } as EnvRequest)) as WireResult<
        ValueOf<typeof op>
      >;
    } catch (cause) {
      const error = new FileError(
        "unknown",
        cause instanceof Error ? cause.message : String(cause),
        path,
      );

      unreachable.add(error);

      return err(error);
    }

    return abortedResult(context, path) ?? fromResult(response);
  };
