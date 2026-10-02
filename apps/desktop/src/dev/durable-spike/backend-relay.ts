import type { FrameRelay, RelayEvent } from "../../../../../spikes/durable-multiview/protocol/transport.ts";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type BackendEvent = {
  type: "event";
  event: { sessionId: string; type: string; payload: Record<string, unknown> };
};
type SubscribeBackendEvent = (listener: (event: BackendEvent) => void) => () => void;

/**
 * The spike's relay over Pace's backend: the renderer cannot open a WebSocket
 * under its CSP, so the backend holds it and frames cross the existing IPC.
 */
export function backendRelay({ invoke, onBackendEvent }: { invoke: Invoke; onBackendEvent: SubscribeBackendEvent }): FrameRelay {
  const connections = new Set<string>();
  const listeners = new Set<(event: RelayEvent) => void>();
  let unsubscribe: (() => void) | undefined;
  const emit = (event: RelayEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    connect: async (connectionId) => {
      connections.add(connectionId);
      try {
        await invoke<null>("durable_spike_connect", { connectionId });
      } catch (error) {
        connections.delete(connectionId);
        throw error;
      }
    },
    send: (connectionId, data) => {
      void invoke("durable_spike_send", { connectionId, data }).catch((error: unknown) => {
        if (!connections.delete(connectionId)) return;
        emit({ kind: "closed", connectionId, code: 1006, reason: error instanceof Error ? error.message : String(error) });
      });
    },
    disconnect: (connectionId) => {
      connections.delete(connectionId);
      // The transport is already closed locally; a dead backend has nothing left to close.
      void invoke("durable_spike_disconnect", { connectionId }).catch(() => {});
    },
    subscribe: (listener) => {
      listeners.add(listener);
      unsubscribe ??= onBackendEvent((event) => {
        if (event.event.sessionId === "__backend__" && event.event.payload.lifecycle === "disconnected") {
          for (const connectionId of connections) {
            connections.delete(connectionId);
            emit({ kind: "closed", connectionId, code: 1006, reason: "Pace backend disconnected" });
          }
          return;
        }
        const relayed = relayEventOf(event);
        if (relayed === undefined) return;
        if (relayed.kind === "closed") connections.delete(relayed.connectionId);
        emit(relayed);
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}

function relayEventOf(event: BackendEvent): RelayEvent | undefined {
  if (event.type !== "event") return undefined;
  const { type, payload } = event.event;
  if (typeof payload.connectionId !== "string") return undefined;
  if (type === "durable_spike.frame" && typeof payload.data === "string") {
    return { kind: "frame", connectionId: payload.connectionId, data: payload.data };
  }
  if (type === "durable_spike.closed" && typeof payload.code === "number") {
    return {
      kind: "closed",
      connectionId: payload.connectionId,
      code: payload.code,
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    };
  }
  return undefined;
}
