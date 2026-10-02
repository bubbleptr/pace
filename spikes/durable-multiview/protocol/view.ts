// The client contract, after DurableView / DurableViewSource / DurableController in
// pi's packages/coding-agent/src/experimental/durable/runtime.ts (MIT, Earendil Works).
// Kept structurally identical so the ported TUI renders a remote host unchanged;
// `connection` is the one addition, since a remote view can lose its host.
import type { ConversationId, ConversationView, ModelRef, TaskGraph } from "@earendil-works/pi-durable";

export interface ModelSummary extends ModelRef {
  readonly name: string;
  readonly contextWindow: number;
}

export interface Notice {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
  readonly id: ConversationId;
  readonly label: string;
  /** The first user message, for a subagent its task. */
  readonly title?: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly directory: string;
  readonly cwd: string;
}

export type ConnectionState = "connected" | "reconnecting" | "closed";

/** Everything a client renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
  readonly session: SessionInfo;
  /** The conversation shown and talked to. */
  readonly conversation: ConversationView;
  readonly conversations: readonly ConversationSummary[];
  readonly models: readonly ModelSummary[];
  readonly notices: readonly Notice[];
  /** The live task graph while the task panel is open. */
  readonly tasks?: TaskGraph;
  readonly connection: ConnectionState;
}

export interface DurableViewSource {
  current(): DurableView;
  subscribe(listener: () => void): () => void;
}

/** What a client may ask for. */
export interface DurableController {
  /** Prompt when idle; otherwise steer or queue a follow-up. */
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  abort(): Promise<void>;
  cycleThinking(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  toggleTasks(): Promise<void>;
  /** Show and talk to another conversation. */
  switchConversation(id: ConversationId): Promise<void>;
}
