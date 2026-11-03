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
  fetchTo,
  HANG_TOOL,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  modernTaskServer,
  PROGRESS_TOOL,
  REGION_TOOL,
  type Received,
  REPORT_TOOL,
  ROOTS_TOOL,
  type RpcBody,
  rpcMethods,
  SHOUT_TOOL,
  sse,
  TASKS_EXTENSION,
  type TaskServer,
  type TaskServerOptions,
  TYPED_TOOL,
} from "./fakes.fixture.ts";
