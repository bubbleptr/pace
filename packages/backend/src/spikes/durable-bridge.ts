import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Dev-only relay for the Durable multiview spike (spikes/durable-multiview):
 * holds the WebSocket to a local Durable host for the renderer, which cannot
 * open one under its CSP. It moves frames and never parses them, so the
 * renderer stays the single writer of what it shows (ADR-0044) and the hop
 * reuses process IPC (ADR-0042). Deleted with the spike.
 */
export type DurableSpikeBridgeEvent =
  | { kind: "frame"; connectionId: string; data: string }
  | { kind: "closed"; connectionId: string; code: number; reason?: string };

export type DurableSpikeBridge = {
  /** Starts a connection; frames and its close arrive as events. Rejects only when it cannot try. */
  connect(input: { connectionId: string; url?: string; token?: string }): Promise<void>;
  send(input: { connectionId: string; data: string }): void;
  disconnect(input: { connectionId: string }): void;
  onEvent(listener: (event: DurableSpikeBridgeEvent) => void): () => void;
  dispose(): void;
};

export const DURABLE_SPIKE_DEFAULT_URL = "ws://127.0.0.1:7420";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Where the spike host keeps its token: `~/.pi/agent/experimental/durable-multiview/default/token`. */
export function durableSpikeTokenPath(agentDir: string): string {
  return join(agentDir, "experimental", "durable-multiview", "default", "token");
}

export function createDurableSpikeBridge(options: {
  agentDir: string;
  /** Host used when a connect names none; a verification run points this away from the operator's host. */
  defaultUrl?: string;
}): DurableSpikeBridge {
  const sockets = new Map<string, WebSocket>();
  const listeners = new Set<(event: DurableSpikeBridgeEvent) => void>();
  const emit = (event: DurableSpikeBridgeEvent) => {
    for (const listener of listeners) listener(event);
  };

  async function tokenFor(given: string | undefined): Promise<string> {
    if (given) return given;
    const path = durableSpikeTokenPath(options.agentDir);
    try {
      return (await readFile(path, "utf8")).trim();
    } catch {
      throw new Error(`No host token at ${path}. Start the host first: bun run host (in spikes/durable-multiview).`);
    }
  }

  return {
    async connect({ connectionId, url, token }) {
      const address = new URL(url ?? options.defaultUrl ?? DURABLE_SPIKE_DEFAULT_URL);
      // The token grants full control of the host's agent; never send it off this machine.
      if (!LOOPBACK_HOSTS.has(address.hostname)) {
        throw new Error(`Durable host must be on a loopback address, not ${address.hostname}.`);
      }
      address.searchParams.set("token", await tokenFor(token));
      const socket = new WebSocket(address);
      sockets.set(connectionId, socket);
      socket.onmessage = (event) => emit({ kind: "frame", connectionId, data: String(event.data) });
      socket.onclose = (event) => {
        if (sockets.get(connectionId) === socket) sockets.delete(connectionId);
        emit({ kind: "closed", connectionId, code: event.code, ...(event.reason ? { reason: event.reason } : {}) });
      };
    },
    send({ connectionId, data }) {
      const socket = sockets.get(connectionId);
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    },
    disconnect({ connectionId }) {
      sockets.get(connectionId)?.close();
      sockets.delete(connectionId);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      listeners.clear();
    },
  };
}
