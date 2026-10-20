# Code mode scripts run in a separately deployed sandbox Worker

The `codemode` tool uses pi-durable's code mode with `RemoteCodemodeSandbox`. The QuickJS sandbox is a Durable Object class in its own Worker script (`apps/codemode-sandbox`), with one instance per Session. A class bound from the same script would run scripts on the Session DO's thread and isolate. A separate script gives them their own isolate, CPU limit, and memory, and keeps the QuickJS WebAssembly out of the main Worker's bundle.
