// Chain of Thought runtime phase machine. One Active Run's slice of the
// session runtime model goes in; the phase, the single clock anchor and one
// flat list of steps come out. Components consume this and never re-derive
// state of their own. See docs/adr/0030-cot-runtime-phase-machine.md §1/§2/§3/§6/§7.

import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import { toolDiffStatFromResult } from "./tool-diff-stat";
import type {
  SessionRuntimeMessage,
  SessionRuntimeMessagePart,
  SessionRuntimeModel,
} from "./session-runtime-model";

export type CotPhase = "hidden" | "thinking" | "acting" | "answering" | "settled";

export type CotStep =
  | {
      kind: "thinking";
      id: string;
      text: string;
      live: boolean;
      /** Wall time inside this thinking Part; ticks while live. */
      durationMs?: number;
    }
  // Text the model addressed to the user mid-run, reclassified out of the
  // answer bubble once the same Message turned out to hold a Tool Call.
  | { kind: "interim"; id: string; text: string }
  | {
      kind: "tools";
      id: string;
      tools: ChatToolItem[];
      live: boolean;
      /** The call currently streaming or executing, while the burst is live. */
      activeToolCallId?: string;
    };

export type CotView = {
  phase: CotPhase;
  outcome?: "failed";
  /**
   * The Run's single clock anchor: its first surviving model call, as an epoch
   * stamp. Handed to the component so it can walk the clock itself instead of
   * the page re-deriving the whole view every 100ms. Absent until the Run has
   * a Message to anchor on — during a retry gap, most of all.
   */
  anchorMs?: number;
  /** Time from the Run's first model call to the first answer token. */
  elapsedMs?: number;
  /** Steps in Turn order; the last one may still be live. */
  steps: CotStep[];
  /** The answer bubble's text — final, or presumed final while answering. */
  answer?: { text: string; streaming: boolean };
};

export type DeriveCotViewOptions = {
  /** `projection.status === "running" && !projection.stale`. */
  streamingAllowed: boolean;
  nowMs?: number;
};

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const ms = Date.parse(value);

  return Number.isNaN(ms) ? undefined : ms;
}

function serializeToolDetail(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toolItem(
  part: SessionRuntimeMessagePart,
  model: SessionRuntimeModel,
): ChatToolItem {
  const tool = part.toolCallId ? model.tools.get(part.toolCallId) : undefined;
  const executed = tool?.phase === "done";
  const startedMs = parseTime(tool?.startedAt);
  const endedMs = executed ? parseTime(tool?.updatedAt) : undefined;
  // Execution is the authority on the name once it starts; before that the
  // opening part boundary already carried it, so a call whose arguments are
  // still streaming is named rather than anonymous (ADR-0030 §4).
  const toolName = tool?.name || part.name;
  const state: ChatToolItem["state"] = executed
    ? tool?.isError
      ? "output-error"
      : "output-available"
    : part.done
      ? "input-available"
      : "input-streaming";
  const diffStat =
    executed && !tool?.isError ? toolDiffStatFromResult(tool?.result) : undefined;

  return {
    state,
    ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(part.body ? { argsText: part.body } : {}),
    ...(diffStat ? { diffStat } : {}),
    ...(tool?.result !== undefined ? { output: serializeToolDetail(tool.result) } : {}),
    ...(startedMs !== undefined && endedMs !== undefined
      ? { durationMs: endedMs - startedMs }
      : {}),
  };
}

function isExecuted(part: SessionRuntimeMessagePart, model: SessionRuntimeModel): boolean {
  return part.toolCallId !== undefined && model.tools.get(part.toolCallId)?.phase === "done";
}

type Slot =
  | { kind: "part"; part: SessionRuntimeMessagePart }
  | { kind: "tools"; parts: SessionRuntimeMessagePart[] };

/** Consecutive Tool Calls in one Message are one step (ADR-0030 §3). */
function slotsOf(message: SessionRuntimeMessage): Slot[] {
  const slots: Slot[] = [];

  for (const part of message.parts) {
    if (part.partType !== "tool_call") {
      slots.push({ kind: "part", part });
      continue;
    }

    const last = slots[slots.length - 1];

    if (last?.kind === "tools") {
      last.parts.push(part);
    } else {
      slots.push({ kind: "tools", parts: [part] });
    }
  }

  return slots;
}

export function deriveCotView(
  model: SessionRuntimeModel,
  runId: string,
  options: DeriveCotViewOptions,
): CotView {
  const nowMs = options.nowMs ?? Date.now();
  const started = [...model.messages.values()].filter(
    (message) => message.runId === runId && message.role === "assistant",
  );
  // A retry abandons its partial Message: its Parts leave the CoT entirely,
  // but it did open a model call, so the Run is no longer `hidden`.
  const messages = started.filter((message) => !message.abandoned);
  const current = messages[messages.length - 1];
  const anchorMs = parseTime(messages[0]?.startedAt);

  const currentTexts = current?.parts.filter((part) => part.partType === "text") ?? [];
  const settled = !options.streamingAllowed || model.runs.get(runId)?.endedAt !== undefined;
  // §7: while the Run is live, a Message that holds a Tool Call cannot be
  // answering — its text is Interim Output. This is also what walks
  // `answering` back to `acting`, and what keeps the phase on `answering`
  // after the answer's last token: the state machine leaves it only for
  // `settled`. Once settled no later Message can claim the answer slot, so the
  // last thing the model said is the Final Answer even beside a Tool Call —
  // otherwise a Stop mid-call hides those words inside the fold.
  const answering =
    currentTexts.length > 0 &&
    (settled || !current?.parts.some((part) => part.partType === "tool_call"));
  const unexecutedTool = messages.some((message) =>
    message.parts.some(
      (part) =>
        part.partType === "tool_call" && part.toolCallId !== undefined && !isExecuted(part, model),
    ),
  );
  const latestPart = current?.parts[current.parts.length - 1];

  let phase: CotPhase;

  if (settled) {
    phase = "settled";
  } else if (answering) {
    phase = "answering";
  } else if (unexecutedTool || latestPart?.partType === "tool_call") {
    phase = "acting";
  } else if (started.length > 0) {
    phase = "thinking";
  } else {
    phase = "hidden";
  }

  const ticking = phase === "thinking" || phase === "acting";
  const steps: CotStep[] = [];

  for (const message of messages) {
    const isCurrent = message === current;

    slotsOf(message).forEach((slot, slotIndex) => {
      if (slot.kind === "tools") {
        // The burst is live until every call in it has executed — not until it
        // stops being the last step.
        const pending = slot.parts.filter((part) => !isExecuted(part, model));
        const live = ticking && pending.length > 0;

        steps.push({
          kind: "tools",
          id: `${message.messageId}-tools-${slotIndex}`,
          tools: slot.parts.map((part) => toolItem(part, model)),
          live,
          // Pi executes in order, so the active call is the first unexecuted one.
          ...(live && pending[0].toolCallId ? { activeToolCallId: pending[0].toolCallId } : {}),
        });

        return;
      }

      const { part } = slot;

      if (part.partType === "text") {
        if (!(isCurrent && answering)) {
          steps.push({ kind: "interim", id: part.partId, text: part.body });
        }

        return;
      }

      if (part.partType !== "thinking") {
        return;
      }

      // Thinking is a step even with an empty body: providers give summaries,
      // redacted blocks, or nothing at all, and that is not a special state.
      const live = ticking && isCurrent && !part.done;
      const startedMs = parseTime(part.startedAt);
      const endedMs = parseTime(part.endedAt) ?? (live ? nowMs : startedMs);

      steps.push({
        kind: "thinking",
        id: part.partId,
        text: part.body,
        live,
        ...(startedMs !== undefined && endedMs !== undefined
          ? { durationMs: endedMs - startedMs }
          : {}),
      });
    });
  }

  const answer = answering
    ? {
        text: currentTexts.map((part) => part.body).join(""),
        streaming: currentTexts.some((part) => !part.done),
      }
    : undefined;

  // §6: one anchor for live and settled alike — the first model call of the
  // Run — frozen at the first answer token, so the number never jumps.
  let elapsedMs: number | undefined;

  if (anchorMs !== undefined && current) {
    if (ticking) {
      elapsedMs = nowMs - anchorMs;
    } else {
      // Frozen at the first answer token; a Message that never reached one
      // (abort, failure) is measured to its own end instead.
      const freezeMs = parseTime(currentTexts[0]?.startedAt) ?? parseTime(current.updatedAt);

      elapsedMs = freezeMs === undefined ? undefined : freezeMs - anchorMs;
    }
  }

  return {
    phase,
    ...(model.runs.get(runId)?.outcome === "failed" ? { outcome: "failed" as const } : {}),
    ...(anchorMs !== undefined ? { anchorMs } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    steps,
    ...(answer ? { answer } : {}),
  };
}
