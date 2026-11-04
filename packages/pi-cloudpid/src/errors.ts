// @effect-diagnostics extendsNativeError:off -- errors the command tells apart with instanceof.
import type { JsonObject } from "./json.ts";

/** A refusal the owner reads as it is: what is wrong and what to do (never a stack trace). */
export class Refusal extends Error {
  override readonly name = "Refusal";
}

/** The endpoint's domain failure (`isError` result): its `code`, one sentence, whether a retry may heal it. */
export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, retryable: boolean, details?: JsonObject) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}
