---
status: accepted
---

# Visuals are first-party and kept apart from MCP Apps, sharing only the App sandbox and the frame's components

A Visual has no MCP server, no `ui://` resource, no calls, no App context and no generation rule, and its page lives in the Session rather than in `McpHost`. So Visuals have their own records (a store in the Session's storage on a chunked-record primitive extracted from the App record store), their own socket messages (`visuals`, `visual_page`), their own Fork and Clone copies (`ExportPage.visuals`) and their own Pane. They share the App sandbox's origin scheme, a shim the web client injects that speaks a subset of the ext-apps frame protocol (initialize, size, host context, open link, Escape), and the frame's places, focus and link handling, moved from `apps/web/src/app-view/` into a shared `apps/web/src/sandbox-frame/`. The sandbox Worker does not change.

## Considered options

- **A kind of App record**: every App reader (generation, availability, `mcp_apps` entries, `ui/html`) would branch on the kind, and Visuals would evict App data within one 32 MiB bound.
- **Full App Views**: stretches MCP semantics (tool input and result, calls, App context, generations) over a page with no server.
- **A self-contained renderer sharing nothing (as T3 Code's `html_render`)**: would duplicate the frame protocol, places and isolation cloudpid already has.

## Consequences

- A second record store and a second copy channel through every Fork and Clone hop.
- A refactor that moves App View code into `sandbox-frame/` before Visuals ship; App View tests move with it as the regression.
- The shim is injected at mount and never stored, so a fix to it reaches every stored Visual, and Visuals can be tried end to end on a preview without a sandbox deploy.
