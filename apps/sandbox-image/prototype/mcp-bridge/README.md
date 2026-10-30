# PROTOTYPE (#383): stdio MCP servers as Streamable HTTP through a Container bridge

Throwaway, never merged. It answers [A stdio MCP server reached as Streamable HTTP through a Container bridge](https://github.com/ian-pascoe/cloudpid/issues/383); the verdict is on that issue.

- `bridge.mjs`: the bridge (plain Node, no dependencies). It spawns each stdio server at its first request, serves it as Streamable HTTP, and keeps nothing across a restart.
- `demo.mjs`: drives the bridge the way the Environment's MCP host object would (the 2025-11-25 SDK client), through discovery, an idle stop, a cold call, server→client requests, progress, and calls cut by a crash and by a Container stop. Its output is in `demo-output.txt`.
- `cold.mjs`: the cost of a stdio server's first answer, cold (download included) and warm, for npx and uvx servers. It has no dependencies, so it also runs on a cloudpid Container.

```sh
npm install --no-package-lock   # the SDK, for demo.mjs only
node demo.mjs
node cold.mjs
```
