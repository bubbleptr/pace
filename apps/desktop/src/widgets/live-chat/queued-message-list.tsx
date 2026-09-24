import { ChatQueuedMessage } from "@/shared/ui/chat/chat-queued-message";
import { usePresenceList } from "@/shared/ui/chat/use-presence-list";
import { useRef, useState } from "react";
import { type SessionProjection } from "@/entities/session/session-projection";

function dropEdge(event: { currentTarget: EventTarget & Element; clientY: number }): "before" | "after" {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function moveId(
  ids: string[],
  fromId: string,
  targetId: string,
  edge: "before" | "after",
) {
  if (fromId === targetId) {
    return ids;
  }

  const next = ids.filter((id) => id !== fromId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) {
    return ids;
  }

  next.splice(edge === "before" ? targetIndex : targetIndex + 1, 0, fromId);
  return next;
}

export function QueuedMessageList({
  projection,
  onWithdraw,
  onSteer,
  onReorder,
}: {
  projection: SessionProjection;
  onWithdraw: (queuedMessageId: string) => void;
  /** Present only while a run is active; queued rows offer Steer then. */
  onSteer?: (queuedMessageId: string) => void;
  onReorder?: (orderedIds: string[]) => void | Promise<void>;
}) {
  const queuedMessages = projection.queuedMessages.filter(
    (queuedMessage) => queuedMessage.status !== "processing",
  );
  const { present, onExitTransitionEnd } = usePresenceList(
    queuedMessages,
    (queuedMessage) => queuedMessage.id,
    { exitTimeoutMs: 150 },
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "before" | "after" } | null>(
    null,
  );
  const reorderInFlightRef = useRef(false);
  const [reorderInFlight, setReorderInFlight] = useState(false);
  const setDraggedMessage = (id: string | null) => {
    draggingIdRef.current = id;
    setDraggingId(id);
  };

  if (!present.length) {
    return null;
  }

  return (
    <div
      className="mx-auto mb-3 grid w-full max-w-[44rem] gap-1.5"
      data-testid="queued-message-list"
    >
      {present.map(({ item: queuedMessage, key, motion }) => {
        const pending = queuedMessage.status === "pending";
        const reorderable = projection.followUpMode !== "all";
        const canDrag = pending && !reorderInFlight && reorderable;

        return (
          <ChatQueuedMessage
            body={queuedMessage.body || queuedMessage.images?.[0]?.name || "Attached image"}
            data-queued-message-id={queuedMessage.id}
            draggable={canDrag}
            dropTarget={dropTarget?.id === queuedMessage.id ? dropTarget.edge : undefined}
            isDragging={draggingId === queuedMessage.id}
            isSteered={queuedMessage.status === "steered"}
            isWithdrawn={queuedMessage.status === "withdrawn"}
            key={key}
            presence={motion}
            onDragEnd={() => {
              setDraggedMessage(null);
              setDropTarget(null);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setDropTarget((current) =>
                current?.id === queuedMessage.id ? null : current,
              );
            }}
            onDragOver={(event) => {
              if (
                !reorderable ||
                reorderInFlightRef.current ||
                !draggingIdRef.current ||
                draggingIdRef.current === queuedMessage.id
              ) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const edge = dropEdge(event);
              setDropTarget((current) =>
                current?.id === queuedMessage.id && current.edge === edge
                  ? current
                  : { id: queuedMessage.id, edge },
              );
            }}
            onDragStart={(event) => {
              if (!canDrag || reorderInFlightRef.current) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", queuedMessage.id);
              setDraggedMessage(queuedMessage.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromId = draggingIdRef.current;
              const edge = dropEdge(event);
              setDraggedMessage(null);
              setDropTarget(null);
              if (
                !reorderable ||
                reorderInFlightRef.current ||
                !fromId ||
                fromId === queuedMessage.id
              ) {
                return;
              }
              const orderedIds = moveId(
                queuedMessages.map((item) => item.id),
                fromId,
                queuedMessage.id,
                edge,
              );
              if (orderedIds.join("\0") === queuedMessages.map((item) => item.id).join("\0")) {
                return;
              }
              reorderInFlightRef.current = true;
              setReorderInFlight(true);
              void Promise.resolve(onReorder?.(orderedIds)).finally(() => {
                reorderInFlightRef.current = false;
                setReorderInFlight(false);
              });
            }}
            onExitTransitionEnd={() => onExitTransitionEnd(key)}
            onSteer={
              onSteer && pending ? () => onSteer(queuedMessage.id) : undefined
            }
            onWithdraw={pending ? () => onWithdraw(queuedMessage.id) : undefined}
          />
        );
      })}
    </div>
  );
}
