# The ext-apps "basic-server-vanillajs" example View

`mcp-app.html.txt`, `mcp-app.ts.txt`, `global.css.txt` and `mcp-app.css.txt` are that example's `mcp-app.html`,
`src/mcp-app.ts`, `src/global.css` and `src/mcp-app.css`, unmodified, from
https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-server-vanillajs (MIT or Apache-2.0, Anthropic, PBC).
They carry a `.txt` extension so neither the typechecker nor the linter reads them as this package's code.
`example-view.test.ts` bundles them as the example's own build does (Vite, with `@modelcontextprotocol/ext-apps` resolved to
the package's `app-with-deps` build, its dependencies included) into one HTML file, and runs that file.
