import type { RuntimePromptImage } from "@pace/core";
import { promptImageDataUrl } from "@pace/core";
import type { ToolPartState } from "@/shared/ui/chat/chat-tool";
import { deriveCotView, type CotView } from "@/entities/session/cot-view";
import {
  isSessionProjectionArchived,
  type SessionProjection,
} from "@/entities/session/session-projection";
import type {
  SessionRuntimeMessage,
  SessionRuntimeModel,
} from "@/entities/session/session-runtime-model";

export type LiveMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  images?: { src: string; name?: string }[];
  runId?: string;
  piEntryId?: string;
  controlLabel?: string;
  isStreaming?: boolean;
  relatedMessageIds?: string[];
  /** The Run's Chain of Thought, derived once with the bubble it belongs to. */
  cotView?: CotView;
  kind?: "context_change";
  contextChange?: {
    sectionsChanged: readonly string[];
    sectionsRemoved: readonly string[];
    toolsAdded: readonly string[];
    toolsRemoved: readonly string[];
  };
};

export type RunTimelineItem = {
  id: string;
  kind?: "trace" | "thinking" | "tool";
  title: string;
  meta: string;
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolPartState;
  argsText?: string;
  outputText?: string;
  durationMs?: number;
};

const modelFirstResponseWatchdogMs = 15_000;
const contactingModelPlaceholder = "Pi is contacting the model...";
const stalledModelResponsePlaceholder =
  "Still waiting for the model response. The provider has not returned a first chunk yet.";

// —— Structured runtime model rendering (Agent Runtime Event Model) ——
// Active once run events own the session; bridges that don't speak the new
// model fall back to the legacy runtimeEvents pipeline below.

export function runtimeModelIsActive(projection: SessionProjection) {
  return projection.runtimeModel.runs.size > 0;
}

function chatTextFromModelMessage(message: SessionRuntimeMessage) {
  return message.parts
    .filter((part) => part.partType === "text")
    .map((part) => part.body)
    .join("");
}

function chatImagesFromModelMessage(message: SessionRuntimeMessage) {
  return message.parts
    .filter((part) => part.partType === "image" && part.body)
    .map((part) => ({
      src: part.body,
      ...(part.name ? { name: part.name } : {}),
    }));
}

function liveImagesFromPrompt(images?: RuntimePromptImage[]) {
  return images?.map((image) => ({
    src: promptImageDataUrl(image),
    name: image.name,
  }));
}

function latestRuntimeModelRunId(model: SessionRuntimeModel) {
  const runs = [...model.runs.values()];
  const activeRun = [...runs].reverse().find((run) => !run.endedAt);

  return activeRun?.runId ?? runs[runs.length - 1]?.runId;
}

/**
 * While a queued follow-up is `processing`, the queue strip hides it and the
 * runtime may not have emitted a user message yet — bridge that gap so the
 * second (and later) user turns never disappear from live chat (DF-005A).
 */
function appendProcessingQueuedFollowUpsAsUserMessages(
  projection: SessionProjection,
  messages: LiveMessage[],
): LiveMessage[] {
  const existingUserBodies = new Set(
    messages.filter((message) => message.role === "user").map((message) => message.body),
  );

  const processingFollowUps = projection.queuedMessages.filter(
    (queuedMessage) =>
      queuedMessage.status === "processing" &&
      !existingUserBodies.has(queuedMessage.body),
  );

  if (!processingFollowUps.length) {
    return messages;
  }

  return [
    ...messages,
    ...processingFollowUps.map((queuedMessage) => ({
      id: `queued-processing-${queuedMessage.id}`,
      role: "user" as const,
      body: queuedMessage.body,
      ...(queuedMessage.images?.length
        ? { images: liveImagesFromPrompt(queuedMessage.images) }
        : {}),
    })),
  ];
}

export function liveMessagesFromRuntimeModel(
  projection: SessionProjection,
  clockNowMs = Date.now(),
): LiveMessage[] | null {
  if (!runtimeModelIsActive(projection)) {
    return null;
  }

  const model = projection.runtimeModel;
  const streamingAllowed = projection.status === "running" && !projection.stale;
  const messages: LiveMessage[] = [];
  // One answer bubble per Active Run, minted at the Run's first model call and
  // never again: agent-core opens a Message per Turn, but only the Final
  // Answer is addressed to the user — every other Turn's text is Interim
  // Output and belongs in the Chain of Thought (ADR-0030 §7).
  const answeredRunIds = new Set<string>();
  let errorCursor = 0;

  for (const entry of model.order) {
    if (entry.kind === "error") {
      const error = model.errors[errorCursor];

      errorCursor += 1;

      if (error) {
        messages.push({
          id: entry.id,
          role: "assistant",
          ...(error.runId ? { runId: error.runId } : {}),
          body: error.body,
          controlLabel: "Run failed",
        });
      }

      continue;
    }

    if (entry.kind === "context_change") {
      messages.push({
        id: entry.id,
        role: "assistant",
        body: "",
        kind: "context_change",
        contextChange: {
          sectionsChanged: entry.sectionsChanged,
          sectionsRemoved: entry.sectionsRemoved,
          toolsAdded: entry.toolsAdded,
          toolsRemoved: entry.toolsRemoved,
        },
      });
      continue;
    }

    if (entry.kind !== "message") {
      continue;
    }

    const message = model.messages.get(entry.id);

    if (!message) {
      continue;
    }

    const runId = message.runId;

    if (!runId || message.role !== "assistant" || message.controlLabel) {
      // Abandoned retry partials are closed boundaries, not answers.
      if (message.abandoned) {
        continue;
      }

      const body = chatTextFromModelMessage(message);
      const images = chatImagesFromModelMessage(message);
      const isStreaming = streamingAllowed && message.phase === "streaming";

      if (!body && !images.length && !message.controlLabel && !isStreaming) {
        continue;
      }

      messages.push({
        id: message.messageId,
        role: message.role,
        body,
        ...(images.length ? { images } : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        ...(message.piEntryId ? { piEntryId: message.piEntryId } : {}),
        ...(message.controlLabel ? { controlLabel: message.controlLabel } : {}),
        ...(isStreaming ? { isStreaming: true } : {}),
      });

      continue;
    }

    if (answeredRunIds.has(runId)) {
      continue;
    }

    answeredRunIds.add(runId);

    const cotView = deriveCotView(model, runId, { streamingAllowed, nowMs: clockNowMs });

    // A run whose every model call was abandoned settles with nothing said,
    // nothing to disclose and nothing measured. Its bubble would be an empty
    // gap above the error bubble that already tells the story.
    if (
      cotView.phase === "settled" &&
      !cotView.steps.length &&
      !cotView.answer &&
      cotView.elapsedMs === undefined
    ) {
      continue;
    }

    messages.push({
      // The Run's first Message anchors the bubble's place in the log; an
      // abandoned one still holds it, so a retry does not reorder the chat.
      id: message.messageId,
      role: "assistant",
      runId,
      body: cotView.answer?.text ?? "",
      // Streaming here means "the Run is still in flight": it gates the
      // incremental renderer and holds the ActionBar back until run(end).
      ...(cotView.phase === "settled" ? {} : { isStreaming: true }),
      cotView,
    });
  }

  const messagesWithPlaceholder = appendModelRunningPlaceholder(
    projection,
    messages,
    clockNowMs,
  );
  const hasInitialPromptMessage = messagesWithPlaceholder.some(
    (message) => message.role === "user" && message.body === projection.initialPrompt,
  );

  const withInitial = hasInitialPromptMessage
    ? messagesWithPlaceholder
    : [
        {
          id: `${projection.id}-initial-prompt`,
          role: "user" as const,
          body: projection.initialPrompt,
        },
        ...messagesWithPlaceholder,
      ];

  return appendProcessingQueuedFollowUpsAsUserMessages(projection, withInitial);
}

/**
 * The wait before the model answers at all. Once a Message opens, the Chain of
 * Thought takes over and says what is happening; until then there is no trace
 * to show, so the wait itself has to be the message (ADR-0030 §5, `hidden`).
 */
function appendModelRunningPlaceholder(
  projection: SessionProjection,
  messages: LiveMessage[],
  clockNowMs: number,
): LiveMessage[] {
  if (projection.status !== "running" || projection.stale) {
    return messages;
  }

  const model = projection.runtimeModel;
  const runId = latestRuntimeModelRunId(model);

  if (!runId) {
    return messages;
  }

  // Scoped to the Run that is actually waiting: an earlier Run's answer says
  // nothing about whether this one has been picked up.
  const runHasModelCall = [...model.messages.values()].some(
    (message) => message.role === "assistant" && message.runId === runId,
  );

  if (runHasModelCall) {
    return messages;
  }

  const latestTimestampMs = Date.parse(model.updatedAt ?? projection.updatedAt);
  const elapsedMs = Number.isFinite(latestTimestampMs)
    ? Math.max(0, clockNowMs - latestTimestampMs)
    : 0;

  return [
    ...messages,
    {
      id: `${projection.id}-running-placeholder`,
      role: "assistant",
      runId,
      body:
        elapsedMs >= modelFirstResponseWatchdogMs
          ? stalledModelResponsePlaceholder
          : contactingModelPlaceholder,
      isStreaming: true,
    },
  ];
}

export function liveMessagesFromProjection(
  projection: SessionProjection,
  clockNowMs = Date.now(),
): LiveMessage[] {
  const liveEvents = projection.runtimeEvents
    .filter(isLiveChatRuntimeEvent)
    .reduce<SessionProjection["runtimeEvents"]>((events, event) => {
      const previousEvent = events[events.length - 1];

      if (isAdjacentDuplicateLiveMessageEvent(previousEvent, event)) {
        return [...events.slice(0, -1), event];
      }

      const identity = liveRuntimeMessageIdentity(event);

      if (!identity) {
        return [...events, event];
      }

      const existingIndex = events.findIndex(
        (existingEvent) => liveRuntimeMessageIdentity(existingEvent) === identity,
      );

      if (existingIndex === -1) {
        return [...events, event];
      }

      return events.map((existingEvent, index) =>
        index === existingIndex ? event : existingEvent,
      );
    }, []);
  const projectedMessages = liveEvents
    .map(
      (event): LiveMessage => ({
        id: event.messageId ?? event.id,
        role:
          event.role === "user"
            ? "user"
            : event.role === "assistant"
              ? "assistant"
              : "assistant",
        body: event.body,
        ...(event.images?.length
          ? { images: liveImagesFromPrompt(event.images) }
          : {}),
        ...(event.piEntryId ? { piEntryId: event.piEntryId } : {}),
        controlLabel:
          event.kind === "control" ||
          event.kind === "status" ||
          event.kind === "error"
            ? (event.title ?? "Control")
            : undefined,
      }),
    );
  const collapsedMessages = collapseAssistantRunMessages(projectedMessages);
  const streamingMessageId =
    projection.status === "running" && !projection.stale
      ? [...collapsedMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" && !message.controlLabel,
          )?.id
      : undefined;
  const visibleMessages = collapsedMessages.map((message) =>
    message.id === streamingMessageId
      ? {
          ...message,
          isStreaming: true,
        }
      : message,
  );
  const messagesWithRunningPlaceholder = appendRunningAssistantPlaceholder(
    projection,
    visibleMessages,
    clockNowMs,
  );
  const hasInitialPromptEvent = projectedMessages.some(
    (message) =>
      message.role === "user" && message.body === projection.initialPrompt,
  );

  const withInitial = hasInitialPromptEvent
    ? messagesWithRunningPlaceholder
    : [
        {
          id: `${projection.id}-initial-prompt`,
          role: "user" as const,
          body: projection.initialPrompt,
        },
        ...messagesWithRunningPlaceholder,
      ];

  return appendProcessingQueuedFollowUpsAsUserMessages(projection, withInitial);
}

export function isAssistantAnswerMessage(message: LiveMessage) {
  return message.kind !== "context_change" && message.role === "assistant" && !message.controlLabel;
}

export function relatedMessageIdsFor(message: LiveMessage) {
  return message.relatedMessageIds ?? [message.id];
}

// Legacy-fallback only: message boundaries in the runtime-model path come from
// the protocol, so this adjacency heuristic never runs there. Delete together
// with the legacy runtimeEvents pipeline once every bridge speaks the Agent
// Runtime Event Model.
function collapseAssistantRunMessages(messages: LiveMessage[]) {
  return messages.reduce<LiveMessage[]>((collapsedMessages, message) => {
    if (!isAssistantAnswerMessage(message)) {
      return [...collapsedMessages, message];
    }

    const previousMessage = collapsedMessages[collapsedMessages.length - 1];

    if (!previousMessage || !isAssistantAnswerMessage(previousMessage)) {
      return [
        ...collapsedMessages,
        {
          ...message,
          relatedMessageIds: relatedMessageIdsFor(message),
        },
      ];
    }

    return [
      ...collapsedMessages.slice(0, -1),
      {
        ...message,
        relatedMessageIds: [
          ...relatedMessageIdsFor(previousMessage),
          ...relatedMessageIdsFor(message),
        ],
      },
    ];
  }, []);
}

function appendRunningAssistantPlaceholder(
  projection: SessionProjection,
  messages: LiveMessage[],
  clockNowMs: number,
): LiveMessage[] {
  if (projection.status !== "running" || projection.stale) {
    return messages;
  }

  const hasAssistantMessage = messages.some(
    (message) =>
      message.role === "assistant" &&
      !message.controlLabel &&
      message.body.trim().length > 0,
  );

  if (hasAssistantMessage) {
    return messages;
  }

  const traceMessageId = [...projection.runtimeEvents]
    .reverse()
    .find(
      (event) =>
        (event.kind === "thinking" ||
          event.kind === "tool-call" ||
          event.kind === "tool-result") &&
        event.messageId,
    )?.messageId;

  return [
    ...messages,
    {
      id: traceMessageId ?? `${projection.id}-running-placeholder`,
      role: "assistant",
      body: runningAssistantPlaceholderBody(projection, clockNowMs),
      isStreaming: true,
    },
  ];
}

function runningAssistantPlaceholderBody(
  projection: SessionProjection,
  clockNowMs: number,
) {
  const hasModelActivity = projection.runtimeEvents.some(
    (event) =>
      event.kind === "thinking" ||
      event.kind === "tool-call" ||
      event.kind === "tool-result" ||
      (event.kind === "message" && event.role === "assistant"),
  );

  if (hasModelActivity) {
    return "";
  }

  const latestRuntimeTimestamp =
    projection.runtimeEvents[projection.runtimeEvents.length - 1]?.timestamp ??
    projection.updatedAt;
  const latestRuntimeTimeMs = Date.parse(latestRuntimeTimestamp);
  const elapsedMs = Number.isFinite(latestRuntimeTimeMs)
    ? Math.max(0, clockNowMs - latestRuntimeTimeMs)
    : 0;

  return elapsedMs >= modelFirstResponseWatchdogMs
    ? stalledModelResponsePlaceholder
    : contactingModelPlaceholder;
}

function isLiveChatRuntimeEvent(
  event: SessionProjection["runtimeEvents"][number],
) {
  return (
    ((event.kind === "message" || event.kind === "control") &&
      (event.role === "user" || event.role === "assistant")) ||
    event.kind === "error"
  );
}

function liveRuntimeMessageIdentity(
  event: SessionProjection["runtimeEvents"][number],
) {
  if (event.kind !== "message" || !event.messageId) {
    return null;
  }

  return `${event.piSessionId}\u0000${event.messageId}`;
}

function isAdjacentDuplicateLiveMessageEvent(
  previousEvent: SessionProjection["runtimeEvents"][number] | undefined,
  event: SessionProjection["runtimeEvents"][number],
) {
  return (
    previousEvent?.kind === "message" &&
    event.kind === "message" &&
    previousEvent.piSessionId === event.piSessionId &&
    previousEvent.role === "assistant" &&
    event.role === "assistant" &&
    previousEvent.body.trim() !== "" &&
    previousEvent.body === event.body
  );
}

export function runTimelineFromProjection(
  projection: SessionProjection,
): RunTimelineItem[] {
  const items: RunTimelineItem[] = [];
  const toolItemIndexes = new Map<string, number>();
  const toolCallTimestamps = new Map<string, string>();

  for (const event of projection.runtimeEvents) {
    if (event.kind === "thinking") {
      items.push({
        id: event.id,
        kind: "thinking",
        title: "Thinking",
        meta: event.body,
        messageId: event.messageId,
      });
      continue;
    }

    if (event.kind !== "tool-call" && event.kind !== "tool-result") {
      continue;
    }

    const toolName = event.title ?? "Tool";
    const toolIdentity = event.toolCallId ?? event.id;
    const existingIndex = toolItemIndexes.get(toolIdentity);

    if (event.kind === "tool-call" && !toolCallTimestamps.has(toolIdentity)) {
      toolCallTimestamps.set(toolIdentity, event.timestamp);
    }

    if (existingIndex === undefined) {
      const item: RunTimelineItem = {
        id: event.id,
        kind: "tool",
        title: `Tool: ${toolName}`,
        meta: event.body,
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolName,
        toolState:
          event.kind === "tool-result" ? "output-available" : "input-available",
        argsText: event.kind === "tool-call" ? event.body : undefined,
        outputText: event.kind === "tool-result" ? event.body : undefined,
      };

      toolItemIndexes.set(toolIdentity, items.length);
      items.push(item);
      continue;
    }

    const existingItem = items[existingIndex];
    const callTimestamp = toolCallTimestamps.get(toolIdentity);
    const durationMs =
      event.kind === "tool-result" && callTimestamp
        ? Date.parse(event.timestamp) - Date.parse(callTimestamp)
        : undefined;

    items[existingIndex] = {
      ...existingItem,
      id: `${existingItem.id}:${event.id}`,
      messageId: existingItem.messageId ?? event.messageId,
      toolCallId: existingItem.toolCallId ?? event.toolCallId,
      toolName: existingItem.toolName ?? toolName,
      toolState:
        event.kind === "tool-result" ? "output-available" : existingItem.toolState,
      argsText:
        event.kind === "tool-call" ? event.body : existingItem.argsText,
      outputText:
        event.kind === "tool-result" ? event.body : existingItem.outputText,
      meta: event.kind === "tool-result" ? event.body : existingItem.meta,
      ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
        ? { durationMs }
        : {}),
    };
  }

  return items;
}

export function isReadOnlyProjection(projection: SessionProjection | null) {
  return Boolean(projection && isSessionProjectionArchived(projection));
}

export function isRuntimeUnavailableProjection(projection: SessionProjection | null) {
  return Boolean(projection?.stale);
}
