import * as Schema from "effect/Schema";

/**
 * A web tool could not do what it was asked: the model sees `message` as the tool's error result. Inside the module
 * the message is the short cause (`HTTP 404 Not Found`, `blocked: private address`); each tool prefixes the subject
 * (`Unable to fetch <url>: …`) where the failure leaves it.
 */
export class WebToolError extends Schema.TaggedError<
  WebToolError,
  { readonly brand: unique symbol }
>()("WebToolError", { message: Schema.String }) {}
