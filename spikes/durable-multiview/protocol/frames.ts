import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { ApprovalDecision } from "./demo.ts";
import type { ModelSummary, Notice, SessionInfo } from "./view.ts";

/**
 * A subscribable value: one conversation's view, one of its documents (`null`
 * while absent), the task graph, the conversation list, or the pending
 * approvals. A subscription starts with a snapshot; ops follow and apply to it
 * with chord's `applyImmutable`.
 */
export type StreamName =
  | `conversation:${ConversationId}`
  | `doc:${string}:${ConversationId}`
  | "tasks"
  | "conversations"
  | "approvals";

export const conversationStream = (id: ConversationId): StreamName => `conversation:${id}`;
export const docStream = (kind: string, id: ConversationId): StreamName => `doc:${kind}:${id}`;

/** Close code for a rejected token; clients must not reconnect after it. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

export interface CallMethods {
  submit: {
    args: {
      conversationId: ConversationId;
      text: string;
      whenBusy: "steer" | "followUp";
      /** Makes a resend after a lost reply admit nothing new. */
      requestId: string;
    };
    result: { submissionId: string };
  };
  abort: { args: { conversationId: ConversationId }; result: null };
  compact: { args: { conversationId: ConversationId; instructions?: string }; result: { taskId: string } };
  setModel: { args: { conversationId: ConversationId; model: ModelRef }; result: null };
  cycleThinking: { args: { conversationId: ConversationId }; result: null };
  /** Decide a pending approval; the first decision committed stands. */
  approve: {
    args: { conversationId: ConversationId; approvalId: string; approved: boolean; by: string };
    result: { decision: ApprovalDecision; first: boolean };
  };
  /** A new ownerless conversation that sees this one's entries through `entryId`. */
  fork: {
    args: { conversationId: ConversationId; entryId: string; removeTools?: readonly string[] };
    result: { conversationId: ConversationId };
  };
}

export type CallMethod = keyof CallMethods;

export type ServerFrame =
  | {
      readonly type: "hello";
      readonly session: SessionInfo;
      readonly root: ConversationId;
      readonly models: readonly ModelSummary[];
      /** Kinds of the conversation documents offered as `doc:` streams. */
      readonly docs: readonly string[];
    }
  | { readonly type: "snapshot"; readonly stream: StreamName; readonly value: unknown }
  | { readonly type: "ops"; readonly stream: StreamName; readonly ops: readonly Op[] }
  /** The stream will send nothing more, for example an unknown conversation. */
  | { readonly type: "ended"; readonly stream: StreamName; readonly reason: string }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: "notice"; readonly level: Notice["level"]; readonly message: string };

export type ClientFrame =
  | { readonly type: "subscribe"; readonly stream: StreamName }
  | { readonly type: "unsubscribe"; readonly stream: StreamName }
  | {
      [M in CallMethod]: {
        readonly type: "call";
        readonly id: number;
        readonly method: M;
        readonly args: CallMethods[M]["args"];
      };
    }[CallMethod];
