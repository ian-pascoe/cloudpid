import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The response the hello Worker serves for every request. */
export const hello = HttpServerResponse.text("Hello from cloudpid");
