/**
 * `@cloudpid/mcp/testing`: the fake MCP servers of both Protocol eras, on the SDK server, for the tests of the packages
 * that use the core (`docs/architecture/mcp.md` → Testing and tracing). `McpWorker`'s engine tests run them as an
 * auxiliary Worker. It loads the SDK, so only tests import it.
 */
export {
  BIG_TOOL,
  ECHO_TOOL,
  type FakeOptions,
  type FakeServer,
  HANG_TOOL,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  REGION_TOOL,
  type Received,
  type RpcBody,
  rpcMethods,
  SHOUT_TOOL,
  sse,
  TYPED_TOOL,
} from "./fakes.fixture.ts";
