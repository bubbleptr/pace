/** One open connection to a host's gateway, carrying serialized frames. */
export interface FrameConnection {
  send(data: string): void;
  close(): void;
}

export interface FrameHandlers {
  message(data: string): void;
  /** Called once, also when the connection never opened; `reason` explains a failure to connect. */
  closed(code: number, reason?: string): void;
}

/** How a client reaches a host: a WebSocket, or a relay such as Pace's backend over IPC. */
export interface FrameTransport {
  /** Shown in errors, for example the host URL. */
  readonly label: string;
  open(handlers: FrameHandlers): FrameConnection;
}

export function webSocketTransport(url: string, token: string): FrameTransport {
  return {
    label: url,
    open(handlers) {
      const address = new URL(url);
      address.searchParams.set("token", token);
      const socket = new WebSocket(address);
      socket.onmessage = (event) => handlers.message(String(event.data));
      socket.onclose = (event) => handlers.closed(event.code);
      return { send: (data) => socket.send(data), close: () => socket.close() };
    },
  };
}

export type RelayEvent =
  | { readonly kind: "frame"; readonly connectionId: string; readonly data: string }
  | { readonly kind: "closed"; readonly connectionId: string; readonly code: number; readonly reason?: string };

/**
 * A relay that holds the WebSocket for the client, as Pace's backend does for
 * its renderer. It only moves frames; the client still applies every op.
 */
export interface FrameRelay {
  /** Rejects when the relay cannot even try, for example with no token; the reason reaches the user. */
  connect(connectionId: string): Promise<void>;
  send(connectionId: string, data: string): void;
  disconnect(connectionId: string): void;
  subscribe(listener: (event: RelayEvent) => void): () => void;
}

export function relayTransport(relay: FrameRelay, label: string): FrameTransport {
  return {
    label,
    open(handlers) {
      const connectionId = crypto.randomUUID();
      let closed = false;
      const close = (code: number, reason?: string): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        handlers.closed(code, reason);
      };
      // Subscribed before connecting, so no frame of this connection is missed.
      const unsubscribe = relay.subscribe((event) => {
        if (event.connectionId !== connectionId) return;
        if (event.kind === "frame") handlers.message(event.data);
        else close(event.code, event.reason);
      });
      relay.connect(connectionId).catch((error: unknown) => close(1006, error instanceof Error ? error.message : String(error)));
      return {
        send: (data) => {
          if (!closed) relay.send(connectionId, data);
        },
        close: () => {
          if (closed) return;
          relay.disconnect(connectionId);
          close(1000);
        },
      };
    },
  };
}
