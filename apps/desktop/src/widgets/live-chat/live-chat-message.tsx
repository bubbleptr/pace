import { ChatChainOfThought as ChainOfThought } from "@/shared/ui/chat/chat-chain-of-thought";
import { ChatThoughtMarkdown } from "@/shared/ui/chat/chat-thought-markdown";
import { ChatThoughtStep } from "@/shared/ui/chat/chat-thought-step";
import { ChatToolStep } from "@/shared/ui/chat/chat-tool-step";
import {
  ChatMarkdown as Markdown,
  ChatStreamMarkdown as StreamMarkdown,
} from "@/shared/ui/chat/chat-markdown";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { ChatContextChange } from "@/shared/ui/chat/chat-context-change";
import { ChatMessage, ChatMessageActions } from "@/shared/ui/chat/chat-message";
import {
  type ChatToolItem,
} from "@/shared/ui/chat/chat-tool";
import { type ReactNode } from "react";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { GitBranch } from "@/shared/ui/icons";
import { type CotStep, type CotView } from "@/entities/session/cot-view";
import { type LiveMessage, type RunTimelineItem } from "@/entities/session/live-chat-model";

export function LiveChatMessage({
  message,
  onForkMessage,
  recovery,
}: {
  message: LiveMessage;
  onForkMessage?: (message: LiveMessage) => void;
  recovery?: ReactNode;
}) {
  if (message.kind === "context_change") {
    return (
      <ChatContextChange
        sectionsChanged={message.contextChange?.sectionsChanged}
        sectionsRemoved={message.contextChange?.sectionsRemoved}
        toolsAdded={message.contextChange?.toolsAdded}
        toolsRemoved={message.contextChange?.toolsRemoved}
      />
    );
  }

  if (message.role === "user") {
    const canFork = Boolean(message.piEntryId && onForkMessage);

    return (
      <ChatMessage.User>
        <div className="flex flex-col items-end gap-1">
          {message.images?.length ? (
            <div className="chat-message__images">
              {message.images.map((image, index) => (
                <Thumbnail
                  key={`${message.id}-image-${index}`}
                  alt={image.name ?? "Attached image"}
                  label={image.name ?? "Attached image"}
                  src={image.src}
                />
              ))}
            </div>
          ) : null}
          {message.body || message.controlLabel ? (
            <ChatMessage.Bubble>
              {message.controlLabel ? (
                <p className="mb-1 text-xs font-medium text-muted">
                  {message.controlLabel}
                </p>
              ) : null}
              {message.body ? (
                <ChatMessage.Content>{message.body}</ChatMessage.Content>
              ) : null}
            </ChatMessage.Bubble>
          ) : null}
          {message.body || canFork ? (
            <ChatMessageActions className="shrink-0">
              {message.body ? (
                <ChatMessageActions.Copy
                  aria-label="Copy"
                  tooltip="Copy"
                  onPress={() => {
                    void navigator.clipboard?.writeText(message.body);
                  }}
                />
              ) : null}
              {canFork ? (
                <ChatMessage.Action
                  aria-label="Fork from message"
                  tooltip="Fork from message"
                  onPress={() => onForkMessage?.(message)}
                >
                  <GitBranch className="size-4" />
                </ChatMessage.Action>
              ) : null}
            </ChatMessageActions>
          ) : null}
        </div>
      </ChatMessage.User>
    );
  }

  if (message.controlLabel === "Run failed") {
    return (
      <ChatMessage.Assistant>
        <ChatMessage.Body>{recovery ?? <ChatRunFailure error={message.body} />}</ChatMessage.Body>
      </ChatMessage.Assistant>
    );
  }

  return (
    <ChatMessage.Assistant>
      <ChatMessage.Body>
        {message.controlLabel ? (
          <p className="mb-1 text-xs font-medium text-muted">
            {message.controlLabel}
          </p>
        ) : null}
        {!message.controlLabel && message.cotView ? (
          <AssistantRunTrajectory view={message.cotView} />
        ) : null}
        {message.body ? (
          <ChatMessage.Content>
            <AssistantMessageContent message={message} />
          </ChatMessage.Content>
        ) : null}
        {!message.controlLabel && !message.isStreaming && message.body ? (
          <ChatMessageActions className="chat-message__actions--persist">
            <ChatMessageActions.Copy
              aria-label="Copy"
              tooltip="Copy"
              onPress={() => {
                void navigator.clipboard?.writeText(message.body);
              }}
            />
            <ChatMessageActions.ThumbsUp
              aria-label="Good response"
              tooltip="Good response"
            />
            <ChatMessageActions.ThumbsDown
              aria-label="Bad response"
              tooltip="Bad response"
            />
          </ChatMessageActions>
        ) : null}
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  );
}

/**
 * One Active Run's Chain of Thought. The phase, the clock anchor and the step
 * list all come from `deriveCotView`; this only lays them out, so there is no
 * second opinion about what stage the run is in (ADR-0030 §1).
 */
function AssistantRunTrajectory({ view }: { view: CotView }) {
  if (view.phase === "hidden") {
    return null;
  }

  const ticking = view.phase === "thinking" || view.phase === "acting";

  // Nothing measured and nothing to disclose: a bare "Worked" header would be
  // chrome with nothing behind it.
  if (!ticking && !view.steps.length && view.elapsedMs === undefined) {
    return null;
  }

  return (
    <ChainOfThought
      // While the clock runs the component owns it: it walks the Run's anchor
      // at 100ms rather than the page re-deriving the whole view that often.
      // Every other phase hands over the frozen number (ADR-0030 §6).
      {...(ticking
        ? { startedAtMs: view.anchorMs }
        : { elapsedMs: view.elapsedMs })}
      hasSteps={view.steps.length > 0}
      phase={view.phase}
      outcome={view.outcome}
    >
      <ChainOfThought.Steps>
        {view.steps.map((step) => (
          <ChainOfThought.Step key={step.id}>
            {step.kind === "thinking" ? (
              <ChatThoughtStep step={step} />
            ) : step.kind === "tools" ? (
              <ChatToolStep step={step} />
            ) : (
              // Interim Output is what the model said to the user, so it reads
              // a shade darker than the steps around it (ADR-0030 §7).
              <div
                className="chain-of-thought__interim"
                data-slot="chat-interim-output"
              >
                <ChatThoughtMarkdown text={step.text} />
              </div>
            )}
          </ChainOfThought.Step>
        ))}
      </ChainOfThought.Steps>
    </ChainOfThought>
  );
}

/**
 * Legacy-bridge fallback: the `runtimeEvents` pipeline mints no Message
 * boundaries, so its trace has no Run to phase and no anchor to measure. It
 * settles immediately with an unnumbered header — the same shape, without the
 * timing — and goes away with the pipeline itself.
 */
export function settledCotViewFromTimeline(timeline: RunTimelineItem[]): CotView {
  const steps: CotStep[] = [];

  for (const item of timeline) {
    if (item.kind !== "tool") {
      steps.push({ kind: "thinking", id: item.id, text: item.meta, live: false });
      continue;
    }

    const tool: ChatToolItem = {
      argsText: item.argsText,
      durationMs: item.durationMs,
      output: item.outputText,
      state: item.toolState ?? "input-available",
      toolCallId: item.toolCallId ?? item.id,
      toolName: item.toolName ?? item.title,
    };
    const last = steps[steps.length - 1];

    // Consecutive calls are one step, exactly as they are on the phase path.
    if (last?.kind === "tools") {
      last.tools.push(tool);
    } else {
      steps.push({ kind: "tools", id: item.id, tools: [tool], live: false });
    }
  }

  return { phase: "settled", steps };
}

function AssistantMessageContent({ message }: { message: LiveMessage }) {
  if (message.controlLabel) {
    return message.body;
  }

  if (message.isStreaming) {
    return (
      <StreamMarkdown isStreaming>
        {message.body}
      </StreamMarkdown>
    );
  }

  return <Markdown>{message.body}</Markdown>;
}
