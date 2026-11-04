# The ext-apps "basic-server-vanillajs" example View

`mcp-app.html.txt`, `mcp-app.ts.txt`, `global.css.txt` and `mcp-app.css.txt` are that example's `mcp-app.html`,
`src/mcp-app.ts`, `src/global.css` and `src/mcp-app.css`, unmodified, from
https://github.com/modelcontextprotocol/ext-apps/tree/07cda2513b0b691ac261ac69c856062c9afb2824/examples/basic-server-vanillajs (MIT or Apache-2.0; see `apps/web/NOTICE.md` and `apps/web/LICENSES/ext-apps.LICENSE`).
They carry a `.txt` extension so neither the typechecker nor the linter reads them as this package's code.
`example-view.test.ts` bundles them as the example's own build does (Vite, with `@modelcontextprotocol/ext-apps` resolved to
the package's `app-with-deps` build, its dependencies included) into one HTML file, and runs that file.
