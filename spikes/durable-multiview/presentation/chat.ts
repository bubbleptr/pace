// What a graphical client shows for a conversation view, as plain data. The
// derivations follow pi's durable TUI (packages/coding-agent/src/experimental/durable/tui.ts,
// MIT, Earendil Works) so every client tells the same story. Type-only imports keep it browser-safe.
import type {
  ConversationId,
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
  TaskGraph,
  TaskGraphNode,
  TaskId,
} from "@earendil-works/pi-durable";

export interface ToolCallView {
  readonly callId: string;
  readonly name: string;
  /** What the call acts on, from its arguments. */
  readonly target?: string;
  readonly status: "pending" | "running" | "complete" | "error";
  readonly output?: string;
  /** A subagent's conversation, from the call's running details. */
  readonly conversationId?: ConversationId;
}

export type ChatItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      /** Absent while streaming; `aborted` for a partial an interrupted attempt left behind. */
      readonly stopReason?: string;
      readonly streaming: boolean;
      readonly tools: readonly ToolCallView[];
    }
  | { readonly kind: "compaction"; readonly id: string; readonly summary: string }
  | { readonly kind: "reset"; readonly id: string };

type Block = { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly arguments?: unknown };
type Message = { readonly role: string; readonly content: string | readonly Block[]; readonly stopReason?: string; readonly toolCallId?: string; readonly isError?: boolean };

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

function targetOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const values = Object.values(args as Record<string, unknown>);
  const first = values.find((value) => typeof value === "string") as string | undefined;
  const target = first ?? (values.length === 0 ? undefined : JSON.stringify(args));
  return target === undefined || target.length <= 80 ? target : `${target.slice(0, 77)}...`;
}

function callsOf(message: Message, status: ToolCallView["status"], output?: string): ToolCallView[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "toolCall" || block.id === undefined || block.name === undefined) return [];
    const target = targetOf(block.arguments);
    return [{ callId: block.id, name: block.name, status, ...(target === undefined ? {} : { target }), ...(output === undefined ? {} : { output }) }];
  });
}

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

export function chatItems(view: ConversationView): ChatItem[] {
  const items: ChatItem[] = [];
  // Where each call ID's newest card sits; provider call IDs may repeat across turns.
  const calls = new Map<string, { item: number; tool: number }>();
  const updateCall = (callId: string, patch: Partial<ToolCallView>): void => {
    const at = calls.get(callId);
    if (at === undefined) return;
    const item = items[at.item] as Extract<ChatItem, { kind: "assistant" }>;
    const tools = item.tools.map((tool, index) => (index === at.tool ? { ...tool, ...patch } : tool));
    items[at.item] = { ...item, tools };
  };
  const addAssistant = (id: string, message: Message, streaming: boolean): void => {
    // Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
    const ran = streaming || message.stopReason === "toolUse";
    const tools = ran ? callsOf(message, "pending") : callsOf(message, "error", "Not run: the answer was interrupted.");
    tools.forEach((tool, index) => calls.set(tool.callId, { item: items.length, tool: index }));
    items.push({
      kind: "assistant",
      id,
      text: textOf(message.content),
      ...(streaming ? {} : { stopReason: message.stopReason ?? "stop" }),
      streaming,
      tools,
    });
  };

  for (const entry of view.entries as readonly EntryRecord[]) {
    const message = entry.model?.[0] as Message | undefined;
    const id = String(entry.id);
    if (entry.kind === "pi.user" && message?.role === "user") items.push({ kind: "user", id, text: textOf(message.content) });
    else if (entry.kind === "pi.assistant" && message?.role === "assistant") addAssistant(id, message, false);
    else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && message.toolCallId !== undefined) {
      updateCall(message.toolCallId, { status: message.isError ? "error" : "complete", output: textOf(message.content) });
    } else if (entry.kind === "pi.compaction") items.push({ kind: "compaction", id, summary: message === undefined ? "" : textOf(message.content) });
    else if (entry.kind === "pi.reset") items.push({ kind: "reset", id });
  }

  const live = liveOf(view);
  for (const slot of live.tools ?? []) {
    if (slot.status !== "running") continue;
    const child = (slot.details as { conversationId?: ConversationId } | undefined)?.conversationId;
    updateCall(slot.callId, {
      status: "running",
      ...(slot.output === undefined ? {} : { output: slot.output }),
      ...(child === undefined ? {} : { conversationId: child }),
    });
  }
  const partial = live.generation?.message as Message | undefined;
  if (partial !== undefined) addAssistant("live", partial, true);
  return items;
}

/** What the conversation is doing now, most specific first; empty when idle. */
export function statusText(view: ConversationView): string {
  const live = liveOf(view);
  const generation = live.generation;
  const compaction = live.compactions?.[0];
  const runningTool = live.tools?.find((slot) => slot.status === "running");
  if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
  if (generation?.deferred !== undefined) return "Waiting for deferred response...";
  if (compaction !== undefined) {
    return compaction.retry ? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...` : `Compacting (${compaction.reason})...`;
  }
  if (runningTool !== undefined) return `Running ${runningTool.name}...`;
  if (live.run !== undefined) return "Working...";
  return "";
}

export interface QueueItem {
  readonly id: number;
  readonly mode: "steer" | "followUp" | "write";
  readonly text: string;
}

export function queueItems(view: ConversationView): QueueItem[] {
  const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
  return inbox.items.map((item) => ({
    id: item.id as unknown as number,
    mode: item.mode,
    text: item.mode === "write" ? `<${String(item.entry.kind)}>` : textOf(item.content as Message["content"]),
  }));
}

export interface TaskRow {
  readonly id: TaskId;
  readonly depth: number;
  readonly label: string;
}

function describeTask(node: TaskGraphNode): string {
  const state = node.state;
  const status =
    state.status === "waiting"
      ? `waiting on ${state.on.join(", ")}`
      : state.status === "completing"
        ? `completing (${state.outcome})`
        : `${state.status} ${state.phase}`;
  const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
  const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
  return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

/** Live tasks as an indented tree: owned work under its owner, a subagent's work under the call that owns its conversation. */
export function taskRows(graph: TaskGraph): TaskRow[] {
  const nodes = Object.values(graph.tasks);
  const owned = new Set(nodes.flatMap((node) => node.conversations));
  const children = (node: TaskGraphNode) =>
    nodes.filter(
      (candidate) => candidate.owner === node.id || (candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
    );
  const rows: TaskRow[] = [];
  const visit = (node: TaskGraphNode, depth: number): void => {
    rows.push({ id: node.id, depth, label: describeTask(node) });
    for (const child of children(node)) visit(child, depth + 1);
  };
  for (const node of nodes) if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
  return rows;
}
