/* oxlint-disable -- PROTOTYPE: throwaway code, never merged */
// @effect-diagnostics *:off
/**
 * PROTOTYPE (throwaway): the host side of one MCP App View, an iframe and its `postMessage` bridge. A real host forwards
 * `tools/call` and `resources/read` over the Session socket to the Environment's MCP host object; here a stub answers.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { callAppTool, log, setModelContext, toolEntry, useStore, viewMessage } from "./store.ts";
import { viewHtml } from "./view-html.ts";

export type DisplayMode = "inline" | "fullscreen";

interface Message {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const textOf = (params: Record<string, unknown> | undefined): string => {
  const content = params?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { text?: unknown }) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
};

export const AppFrame = ({
  callId,
  displayMode,
  onDisplayMode,
  maxHeight = 420,
  fill = false,
}: {
  callId: string;
  displayMode: DisplayMode;
  /** The View asked for `mode`: the variant decides, and returns the mode it is in now. */
  onDisplayMode: (mode: DisplayMode) => DisplayMode;
  maxHeight?: number;
  /** Fill the container (a Pane) instead of following `size-changed`. */
  fill?: boolean;
}) => {
  const state = useStore();
  const entry = toolEntry(callId);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(140);
  const initialized = useRef(false);
  const sentResult = useRef(false);
  const latest = useRef({ displayMode, onDisplayMode });
  latest.current = { displayMode, onDisplayMode };

  const post = (message: object) => frame.current?.contentWindow?.postMessage(message, "*");

  const sendResult = () => {
    const current = toolEntry(callId);
    if (current?.result === undefined || sentResult.current) return;
    sentResult.current = true;
    post({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [{ type: "text", text: current.result.text }],
        structuredContent: current.result.structured,
      },
    });
    log("host→view", "ui/notifications/tool-result", callId);
  };

  useEffect(() => {
    const server = toolEntry(callId)?.server ?? "?";
    log(
      "host",
      `View mounted (${latest.current.displayMode}); loading ui://${server}/view.html`,
      callId,
    );

    const onMessage = (event: MessageEvent<Message>) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      const respond = (result: unknown) => post({ jsonrpc: "2.0", id: message.id, result });

      switch (message.method) {
        case "ui/initialize": {
          log("view→host", "ui/initialize", callId);
          const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          respond({
            protocolVersion: "2026-01-26",
            hostInfo: { name: "cloudpid", version: "prototype" },
            hostContext: {
              theme: dark ? "dark" : "light",
              displayMode: latest.current.displayMode,
              availableDisplayModes: ["inline", "fullscreen"],
              platform: window.innerWidth < 640 ? "mobile" : "web",
            },
          });
          return;
        }
        case "ui/notifications/initialized": {
          initialized.current = true;
          const current = toolEntry(callId);
          post({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: current?.args },
          });
          log("host→view", "ui/notifications/tool-input (replayed from the transcript)", callId);
          sendResult();
          return;
        }
        case "ui/notifications/size-changed": {
          const wanted = Number(message.params?.height ?? 0);
          setHeight(wanted);
          return;
        }
        case "tools/call": {
          const name = String(message.params?.name);
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
          log(
            "view→host",
            `tools/call ${name} → ${server} (app-only: not in the model's tools)`,
            callId,
          );
          void callAppTool(callId, name, args).then((result) => {
            respond(result);
            log("host→view", `tools/call ${name} result`, callId);
          });
          return;
        }
        case "ui/update-model-context": {
          const text = textOf(message.params);
          setModelContext(callId, server, text);
          log("view→host", `ui/update-model-context: "${text}"`, callId);
          respond({});
          return;
        }
        case "ui/message": {
          const text = textOf(message.params);
          log("view→host", `ui/message: "${text}"`, callId);
          viewMessage(server, text);
          respond({});
          return;
        }
        case "ui/request-display-mode": {
          const wanted = message.params?.mode === "fullscreen" ? "fullscreen" : "inline";
          const mode = latest.current.onDisplayMode(wanted);
          log("view→host", `ui/request-display-mode ${wanted} → ${mode}`, callId);
          respond({ mode });
          return;
        }
        default:
          log("view→host", `${message.method ?? "response"} (ignored)`, callId);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      log("host→view", "ui/resource-teardown; View unmounted, its own state is gone", callId);
    };
  }, [callId]);

  // A result that arrives after the View initialized (the call was running).
  useEffect(() => {
    if (initialized.current) sendResult();
  });

  if (entry === undefined) return null;

  return (
    <iframe
      ref={frame}
      title={`${entry.title} app`}
      sandbox="allow-scripts"
      srcDoc={viewHtml(entry.app)}
      data-epoch={state.epoch}
      className={cn("w-full rounded-md border bg-background", fill && "h-full")}
      style={fill ? undefined : { height: Math.min(height + 2, maxHeight) }}
    />
  );
};
