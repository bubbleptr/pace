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

/** JSON from a socket has no TypeScript guarantees; reject it before dispatch. */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (!record(value)) return false;
  if (value.type === "subscribe" || value.type === "unsubscribe") {
    const stream = value.stream;
    return (
      typeof stream === "string"
      && (stream === "tasks" || stream === "conversations" || stream === "approvals" || /^(?:conversation:|doc:.+:)[1-9]\d*$/.test(stream))
    );
  }
  if (value.type !== "call" || !Number.isSafeInteger(value.id) || !record(value.args)) return false;
  const args = value.args;
  if (typeof args.conversationId !== "number" || !Number.isSafeInteger(args.conversationId) || args.conversationId < 1) return false;
  switch (value.method) {
    case "submit":
      return typeof args.text === "string" && (args.whenBusy === "steer" || args.whenBusy === "followUp") && nonempty(args.requestId);
    case "abort":
    case "cycleThinking":
      return true;
    case "compact":
      return args.instructions === undefined || typeof args.instructions === "string";
    case "setModel":
      return record(args.model) && nonempty(args.model.provider) && nonempty(args.model.modelId);
    case "approve":
      return nonempty(args.approvalId) && typeof args.approved === "boolean" && nonempty(args.by);
    case "fork":
      return (
        typeof args.entryId === "string" && /^[1-9]\d*$/.test(args.entryId)
        && (args.removeTools === undefined || (Array.isArray(args.removeTools) && args.removeTools.every(nonempty)))
      );
    default:
      return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
