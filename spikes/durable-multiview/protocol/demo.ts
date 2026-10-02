// Shapes of the on-call demo's own state, as clients receive it. Type-only, so browsers can import it.
import type { ConversationId } from "@earendil-works/pi-durable";

export type PlanItem = {
  readonly text: string;
  readonly status: "todo" | "doing" | "done";
}

/** `demo.plan`: the investigation plan the main agent keeps. */
export type PlanState = {
  readonly items: readonly PlanItem[];
}

/** `demo.rollout`: each rollback's regions and where each one got to, keyed by rollback task ID. */
export type RolloutState = {
  readonly runs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type ApprovalDecision = {
  readonly approved: boolean;
  /** The client that decided. */
  readonly by: string;
  readonly at: number;
}

/** A tool call held by the approval hook until some client decides. */
export type PendingApproval = {
  /** The held tool call's task ID. */
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly tool: string;
  readonly summary: string;
  readonly requestedAt: number;
}
