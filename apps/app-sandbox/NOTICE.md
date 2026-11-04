# Notices

The proxy page and its script (`src/proxy.ts`: `proxyPage` and the `/proxy.js` source) are ported from the sandbox proxy of
the reference host in [`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) at commit
`07cda2513b0b691ac261ac69c856062c9afb2824`. The project is moving from the MIT License to the Apache License, Version 2.0:
its new contributions are Apache-2.0 and those whose authors have not consented to relicense remain MIT, so the port is used
under the terms of both. The upstream `LICENSE`, with the Apache-2.0 text and the MIT text ("Copyright (c) 2024-2025 Model
Context Protocol a Series of LF Projects, LLC."), is in [`LICENSES/ext-apps.LICENSE`](LICENSES/ext-apps.LICENSE); the upstream
repository has no `NOTICE` file.

What was ported, and what changed:

| Here                     | From (`examples/basic-host/`) | Change                                                                                                                              |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `proxyPage` (the HTML)   | `sandbox.html`                | the host origin is a `<meta>` written from the sandbox's hostname; the CSP is a response header, not a `<meta>`; styles inline      |
| `/proxy.js` (the script) | `src/sandbox.ts`              | the host origin is read from that `<meta>` instead of `document.referrer`, which a browser or extension can strip; plain JavaScript |
