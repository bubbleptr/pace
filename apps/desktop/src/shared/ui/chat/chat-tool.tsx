import {
  ChatToolCalls,
  type ChatToolCallItem,
  type ChatToolCallStatus,
} from "@astryxdesign/core";
import type { ComponentProps } from "react";

/**
 * Lifecycle of a tool invocation as rendered in the trace. Mirrors the state
 * union the runtime event pipeline produces (own type, not a vendor import).
 */
export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export type ChatToolItem = {
  argsText?: string;
  /** Per-edit line counts; rendered as Astryx additions/deletions stats. */
  diffStat?: { additions: number; deletions: number };
  durationMs?: number;
  output?: string;
  state: ToolPartState;
  toolCallId?: string;
  toolName?: string;
};

const statusMap: Record<ToolPartState, ChatToolCallStatus> = {
  "input-streaming": "running",
  "input-available": "running",
  "output-available": "complete",
  "output-error": "error",
};

/** Argument keys that name what a tool acted on, most specific first. */
const TARGET_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "name",
] as const;

const TARGET_MAX_LENGTH = 120;

export function toolTargetFromArgs(argsText: string | undefined): string | undefined {
  if (!argsText) {
    return undefined;
  }

  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    return undefined;
  }

  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  for (const key of TARGET_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > TARGET_MAX_LENGTH
        ? `${value.slice(0, TARGET_MAX_LENGTH)}…`
        : value;
    }
  }

  return undefined;
}

export function formatToolDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  return durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1000).toFixed(1)}s`;
}

export function hasToolDetail(tool: ChatToolItem) {
  return tool.argsText != null || tool.output != null;
}

/**
 * The args and output panes of one call. Rendered inside the Astryx row when
 * it expands, and directly by a single-call ChatToolStep, whose own row
 * already names the call — a second header there would only cost a click.
 */
export type ChatToolDetailProps = Omit<ComponentProps<"div">, "children"> & {
  tool: ChatToolItem;
};

export function ChatToolDetail({ tool, className, ...rest }: ChatToolDetailProps) {
  return (
    <div className={className} {...rest}>
      {tool.argsText != null ? (
        <pre className="chat-tool__section" data-slot="chat-tool-args">
          {tool.argsText}
        </pre>
      ) : null}
      {tool.output !== undefined ? (
        <pre className="chat-tool__section" data-slot="chat-tool-result">
          {tool.output}
        </pre>
      ) : null}
    </div>
  );
}

function toAstryxCall(tool: ChatToolItem, index: number): ChatToolCallItem {
  const resultDetail = hasToolDetail(tool) ? <ChatToolDetail tool={tool} /> : undefined;

  return {
    name: tool.toolName ?? "tool",
    status: statusMap[tool.state],
    target: toolTargetFromArgs(tool.argsText),
    ...(tool.diffStat
      ? { additions: tool.diffStat.additions, deletions: tool.diffStat.deletions }
      : {}),
    duration: formatToolDuration(tool.durationMs),
    errorMessage: tool.state === "output-error" ? tool.output : undefined,
    key: tool.toolCallId ?? `tool-${index}`,
    resultDetail,
  };
}

/**
 * Adapter over Astryx ChatToolCalls. One call renders as an inline row;
 * several collapse into the "N tool calls" summary Astryx provides. The
 * wrapper div carries the data-slot contract page tests assert on.
 */
export type ChatToolGroupProps = Omit<ComponentProps<"div">, "children"> & {
  tools: ChatToolItem[];
};

export function ChatToolGroup({
  tools,
  className = "",
  ...rest
}: ChatToolGroupProps) {
  if (!tools.length) {
    return null;
  }

  return (
    <div
      className={`chat-tool ${className}`.trim()}
      data-slot="chat-tool-group"
      data-tool-count={tools.length}
      // Single-call groups keep the per-tool state contract on the wrapper.
      data-state={tools.length === 1 ? tools[0].state : undefined}
      {...rest}
    >
      <ChatToolCalls calls={tools.map(toAstryxCall)} />
    </div>
  );
}

/**
 * Single-call sugar over ChatToolGroup, keeping the original data-slot and
 * data-state contract (detail stays unmounted while collapsed — Astryx
 * native behavior).
 */
export type ChatToolProps = Omit<ComponentProps<"div">, keyof ChatToolItem | "children"> &
  ChatToolItem;

export function ChatTool({
  argsText,
  diffStat,
  durationMs,
  output,
  state,
  toolCallId,
  toolName,
  className = "",
  ...rest
}: ChatToolProps) {
  return (
    <div
      className={`chat-tool ${className}`.trim()}
      data-slot="chat-tool"
      data-state={state}
      data-tool-call-id={toolCallId}
      {...rest}
    >
      <ChatToolCalls
        calls={[
          toAstryxCall(
            { argsText, diffStat, durationMs, output, state, toolCallId, toolName },
            0,
          ),
        ]}
      />
    </div>
  );
}
