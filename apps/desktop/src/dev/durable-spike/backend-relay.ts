import type { BackendRpcEvent } from "@pace/backend";
import type { FrameRelay, RelayEvent } from "@pace/durable-spike/protocol/transport.ts";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type SubscribeBackendEvent = (listener: (event: BackendRpcEvent) => void) => () => void;

/**
 * The spike's relay over Pace's backend: the renderer cannot open a WebSocket
 * under its CSP, so the backend holds it and frames cross the existing IPC.
 */
export function backendRelay({ invoke, onBackendEvent }: { invoke: Invoke; onBackendEvent: SubscribeBackendEvent }): FrameRelay {
  return {
    connect: (connectionId) => invoke<null>("durable_spike_connect", { connectionId }).then(() => {}),
    send: (connectionId, data) => void invoke("durable_spike_send", { connectionId, data }),
    disconnect: (connectionId) => void invoke("durable_spike_disconnect", { connectionId }),
    subscribe: (listener) =>
      onBackendEvent((event) => {
        const relayed = relayEventOf(event);
        if (relayed !== undefined) listener(relayed);
      }),
  };
}

function relayEventOf(event: BackendRpcEvent): RelayEvent | undefined {
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
